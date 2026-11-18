/**
 * HTTP/SSE 层：只做两件事——把请求变成 service/turn 调用、把结果原样返回。
 * 不含业务规则；游戏层拒绝一律 HTTP 200 + {ok:false,code,message}，500 只表示未预期异常。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Memory, MemoryRecord, Registry, Store, Turn, TurnEvent } from "../../../packages/shared/src/contract/types.ts";
import { DialogueBodySchema, TickBodySchema, TravelBodySchema, zodMessage } from "./map.data.ts";
import type { MapService } from "./map.ts";
import type { LlmSettings } from "./settings.ts";
import type { SaveIndex } from "./saves.ts";
import type { TurnHistory } from "./turn-history.ts";
import { registerResumeRoutes } from "./resume.routes.ts";
import { makeRoomExists } from "./room-exists.ts";
import { isSafeRoomId } from "../../../packages/engine/src/store.ts";
import { EMPTY_SCENARIOS } from "./scenarios.ts";
import type { ScenarioCatalog } from "./scenarios.ts";
import { registerViewRoutes } from "./view.routes.ts";

export interface AppDeps {
  store: Store;
  turn: Turn;
  map: MapService;
  /** 运行时模型接入（玩家自备 key）：/api/v1/settings/llm */
  settings: LlmSettings;
  /** 注册表（属性声明）；/api/v1/registry 给前端按数据渲染面板用（I2） */
  registry: Registry;
  /** 读取账号维度的私忆档案（GET /api/v1/me）；记忆是日志投影，这里只读 */
  memory: Memory & { all(roomId: string): MemoryRecord[]; get?(memoryId: string): MemoryRecord | undefined };
  createRoom(mode: "solo" | "coop", userId?: string): Promise<{ roomId: string; actorId: string }>;
  /** 开发期账号：没有登录态时用 GALGAME_DEV_USER 兜底（上线接登录中间件后删掉） */
  devUser?: string;
  /** 审核器种类：llm = 真模型审核；deny_all = 未配置（fail-closed，永不发布世界层） */
  canonizeJudge?: "llm" | "deny_all";
  /** 是否信任 X-User-Id 头；默认 true（本机开发）。生产置 GALGAME_TRUST_USER_HEADER=0 */
  trustUserHeader?: boolean;
  /** 世界层永久记忆（P3）：只在管理员端点里被调用 */
  canonize?: {
    retireRoom(roomId: string): Promise<{ written: string[]; candidates: number }>;
    tombstone(memoryId: string, reason: string): Promise<boolean>;
    stats(): { worldId: string; version: number; writtenToday: number; writtenTotal: number; circuitOpen: boolean; consecutiveJudgeFailures: number };
    sample(limit: number): MemoryRecord[];
  };
  /** 管理员令牌；canonize 端点用它鉴权（地图端点由 MapService 自己校验） */
  adminToken?: string;
  /** 世界印象（用户投影）：/me 只读，投递在 Turn 里 */
  impressions?: { pending(userId: string, roomId: string, limit: number): Promise<unknown[]>; count?(userId: string): Promise<number> };
  /** 回合历史（issue #7）：只记已提交回合，用于续玩重放 */
  history?: TurnHistory;
  /** 存档索引（issue #7）：账号 → 房间游标 */
  saves?: SaveIndex;
  /** 开局剧本 / NPC 公开档案（content/scenarios/*.json）；标题页与图鉴用，缺省 = 无预设 */
  scenarios?: ScenarioCatalog;
  version: string;
}

interface GameError {
  ok: false;
  code: string;
  message: string;
}

function sseWrite(raw: NodeJS.WritableStream, event: string, data: unknown): void {
  raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function schemaError(message: string): GameError {
  return { ok: false, code: "E_SCHEMA_INVALID", message };
}

/**
 * 账号维度：优先 `X-User-Id` 头（联机/生产由登录态中间件注入），其次请求体，最后开发期默认值。
 * 只在服务端用；绝不把 userId 当权限凭据（它是"哪份记忆档案"的键，不是 token）。
 */
export function userIdOf(req: FastifyRequest, deps: AppDeps, body?: { userId?: string }): string | undefined {
  const raw = req.headers["x-user-id"];
  const header = deps.trustUserHeader === false ? undefined : Array.isArray(raw) ? raw[0] : raw;
  const fromBody = body?.userId;
  const id = (header ?? fromBody ?? deps.devUser ?? "").trim();
  return id === "" ? undefined : id.slice(0, 64);
}

const WORLD_ROOM_PREFIX = "room_world_";

/**
 * 世界层房间（room_world_<worldId>）是永久记忆的存储房间，**没有成员、不能进**。
 * 不拦住的话，客户端可以 GET 它的完整事件流，把"这个世界知道的事"连同 sourceRefs/隐私扫描细节全读走（审阅 P1）。
 */
export function isWorldRoom(roomId: string): boolean {
  return roomId.startsWith(WORLD_ROOM_PREFIX);
}

/** 管理员令牌统一从 x-admin-token 头取；校验在 MapService/草案引擎里做 */
function adminTokenOf(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers["x-admin-token"];
  return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
}

/**
 * 模型设置端点只允许本机调用（审阅 M3）：这些端点会改服务端出站目标（SSRF 面）且涉及明文 key，
 * 局域网/公网直连一律拒绝。本机浏览器与 Vite 代理都从 127.0.0.1/::1 进来，不受影响。
 */
function requireLocal(req: FastifyRequest): GameError | null {
  const ip = req.ip ?? "";
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return null;
  return { ok: false, code: "E_FORBIDDEN", message: "模型设置仅允许本机操作" };
}

/** 未预期异常兜底成 500；业务拒绝不经过这里（它们在 service 里返回 ok:false） */
async function safe(reply: FastifyReply, fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (e) {
    // 内部异常（含绝对路径的 zod 错误等）只进服务端日志，不回给客户端
    console.error("[server] unhandled route error", e);
    return reply.code(500).send({ ok: false, code: "E_MODULE_FAULT", message: "服务器内部错误" });
  }
}

export function registerRoutes(app: FastifyInstance, deps: AppDeps): void {
  // 所有带 :roomId 的路径先过白名单：roomId 只允许作为 id，不能变成文件路径。
  // Fastify 会先解码 `%2F`，所以 `..%2F..%2Fpwn` 到这里已经是 `../../pwn`；必须在这里挡。
  app.addHook("preHandler", async (req, reply) => {
    const params = req.params as { roomId?: string } | undefined;
    const roomId = params?.roomId;
    if (roomId !== undefined && !isSafeRoomId(roomId)) {
      return reply.code(400).send({ ok: false, code: "E_SCHEMA_INVALID", message: "非法 roomId" });
    }
  });

  const roomExists = makeRoomExists(deps.store);

  /**
   * 房间入口统一守卫（issue #37）：世界层房间与不存在的房间一律 404，且必须先于
   * body 校验、SSE 开流与任何写操作。存在性走 `listRooms()`（持久化事实），
   * 不再依赖 `snapshot()` 抛错——后者对缺失房间返回空状态，会把未知房间当 200。
   */
  const roomGate = async (roomId: string, reply: FastifyReply): Promise<boolean> => {
    if (isWorldRoom(roomId)) {
      reply.code(404).send({ ok: false, code: "E_ROOM_NOT_FOUND", message: "世界层房间不接受该操作" });
      return false;
    }
    if (!(await roomExists(roomId))) {
      reply.code(404).send({ ok: false, code: "E_ROOM_NOT_FOUND", message: "房间不存在" });
      return false;
    }
    return true;
  };

  app.get("/api/v1/health", async () => ({
    ok: true,
    contract: deps.version,
    // fail-closed 要能被看见：没配 judge 时 canonize 仍启用，但永远不会写出世界层（审阅 P2-⑥）
    canonize: { enabled: deps.canonize !== undefined, judge: deps.canonizeJudge ?? "none" },
  }));

  // ---------------------------------------------------------------- 注册表（前端按数据渲染面板，I2）
  /** 只暴露声明（标签/可见性/范围），不含任何实体数值；键来自 content/registry/attrs.json */
  app.get("/api/v1/registry", async () => ({
    ok: true,
    attrs: deps.registry.attrs().map((d) => ({
      key: d.key,
      type: d.type,
      scope: d.scope,
      min: d.min,
      max: d.max,
      visibility: d.visibility,
      label: d.display.label,
      unit: d.display.unit,
      hidden: d.display.hidden ?? false,
    })),
  }));

  // ---------------------------------------------------------------- 模型接入（docs/03 §5.2.2，仅本机）
  app.get("/api/v1/settings/llm", async (req) => {
    const deny = requireLocal(req);
    if (deny) return deny;
    return { ok: true, view: deps.settings.view() };
  });

  app.post("/api/v1/settings/llm", async (req) => {
    const deny = requireLocal(req);
    if (deny) return deny;
    const r = await deps.settings.apply(req.body);
    return r.ok ? { ok: true, view: r.view } : { ok: false, code: r.code, message: r.message };
  });

  app.delete("/api/v1/settings/llm", async (req) => {
    const deny = requireLocal(req);
    if (deny) return deny;
    await deps.settings.clear();
    return { ok: true, view: deps.settings.view() };
  });

  app.post("/api/v1/rooms", async (req) => {
    const body = (req.body ?? {}) as { mode?: "solo" | "coop"; userId?: string; scenarioId?: string };
    const userId = userIdOf(req, deps, body);
    const room = await deps.createRoom(body.mode === "coop" ? "coop" : "solo", userId);
    // 建房即登记存档索引（issue #7）：lastCommittedSeq 从建房种子事件之后算起。
    // 登记失败不回滚房间——房间本体是权威的，索引只是"我玩过哪些"的投影。
    if (userId && deps.saves) {
      const ts = Date.now();
      const scenarioId = typeof body.scenarioId === "string" && body.scenarioId.trim() ? body.scenarioId.trim().slice(0, 64) : "default";
      // Store 契约没有 seq()（FileStore 的快捷方式是内部实现）：用事件尾序号登记游标
      const seeded = await deps.store.events(room.roomId, 0, 500).catch(() => []);
      try {
        await deps.saves.upsert(userId, {
          roomId: room.roomId,
          scenarioId,
          createdAt: ts,
          updatedAt: ts,
          lastTurnId: "",
          lastCommittedSeq: seeded.length ? seeded[seeded.length - 1]!.seq : 0,
          actorId: room.actorId,
          formatVersion: 1,
        });
      } catch (e) {
        console.warn("[saves] 建房登记失败（房间已创建）:", e);
      }
    }
    return { ...room, ...(userId ? { userId } : {}) };
  });

  /** 玩家档案（记忆的派生视图，不写状态）：私忆只按 userId+ownerId 过滤后返回 */
  app.get("/api/v1/me", async (req, reply) => {
    const q = req.query as { roomId?: string; actorId?: string };
    const userId = userIdOf(req, deps);
    if (!q.roomId || !q.actorId) return reply.code(400).send({ code: "E_SCHEMA_INVALID", message: "roomId/actorId 必填" });
    if (!userId) return reply.code(400).send({ code: "E_SCHEMA_INVALID", message: "缺少 X-User-Id（或 GALGAME_DEV_USER）" });
    const profile = await deps.memory.profile(userId, q.actorId, q.roomId);
    let impressionCount = 0;
    let pendingImpressions: unknown[] = [];
    if (deps.impressions) {
      impressionCount = deps.impressions.count ? await deps.impressions.count(userId) : 0;
      pendingImpressions = await deps.impressions.pending(userId, q.roomId, 5);
    }
    return { ok: true, userId, profile, impressionCount, pendingImpressions };
  });

  // 续玩/存档（issue #7）：独立区块，见 resume.routes.ts
  registerResumeRoutes(app, deps, { userIdOf, isWorldRoom, roomExists });

  app.get("/api/v1/rooms/:roomId/state", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    if (!(await roomGate(roomId, reply))) return reply;
    try {
      return await deps.store.snapshot(roomId);
    } catch {
      return reply.code(404).send({ ok: false, code: "E_ROOM_NOT_FOUND", message: "房间不存在或事件日志不可读" });
    }
  });

  app.get("/api/v1/rooms/:roomId/events", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    if (!(await roomGate(roomId, reply))) return reply;
    const q = req.query as { fromSeq?: string; limit?: string };
    const from = Number(q.fromSeq ?? 0);
    const limit = Math.min(Number(q.limit ?? 200), 200);
    const events = await deps.store.events(roomId, from, limit);
    return { events, lastSeq: events.length ? events[events.length - 1]!.seq : from };
  });

  /** 一次行动 = 一条 SSE 流，事件名就是 TurnEvent.type */
  app.post("/api/v1/rooms/:roomId/turns", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    if (!(await roomGate(roomId, reply))) return reply;
    const body = (req.body ?? {}) as { actorId?: string; input?: string; clientTurnId?: string; userId?: string; options?: Record<string, unknown> };
    if (!body.actorId || !body.input || !body.clientTurnId) {
      return reply.code(400).send({ code: "E_SCHEMA_INVALID", message: "actorId/input/clientTurnId 必填" });
    }
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    try {
      const userId = userIdOf(req, deps, body as { userId?: string });
    const it = deps.turn.run({
      roomId,
      actorId: body.actorId,
      input: body.input,
      clientTurnId: body.clientTurnId,
      options: body.options as never,
      ...(userId ? { userId } : {}),
    });
      for await (const ev of it as AsyncIterable<TurnEvent>) {
        sseWrite(reply.raw, ev.type, ev);
        if (ev.type === "turn.commit" || ev.type === "turn.error") break;
      }
    } catch (e) {
      sseWrite(reply.raw, "turn.error", { type: "turn.error", code: "E_UPSTREAM", message: String(e), retryable: true });
    } finally {
      reply.raw.end();
    }
    return reply;
  });

  // ---------------------------------------------------------------- 世界层永久记忆（docs/08 §9.3，管理员）
  app.post("/api/v1/admin/canonize/run", async (req, reply) => {
    if (!deps.canonize) return reply.code(404).send({ ok: false, code: "E_FORBIDDEN", message: "canonize 未启用" });
    if (!adminTokenOf(req.headers) || adminTokenOf(req.headers) !== (deps.adminToken ?? "")) {
      return reply.code(403).send({ ok: false, code: "E_FORBIDDEN", message: "需要管理员令牌" });
    }
    const body = (req.body ?? {}) as { roomId?: string };
    if (!body.roomId) return reply.code(400).send({ ok: false, code: "E_SCHEMA_INVALID", message: "roomId 必填" });
    const report = await safe(reply, () => deps.canonize!.retireRoom(body.roomId!));
    return { ok: true, report };
  });

  app.post("/api/v1/admin/canonize/tombstone", async (req, reply) => {
    if (!deps.canonize) return reply.code(404).send({ ok: false, code: "E_FORBIDDEN", message: "canonize 未启用" });
    if (!adminTokenOf(req.headers) || adminTokenOf(req.headers) !== (deps.adminToken ?? "")) {
      return reply.code(403).send({ ok: false, code: "E_FORBIDDEN", message: "需要管理员令牌" });
    }
    const body = (req.body ?? {}) as { memoryId?: string; reason?: string };
    if (!body.memoryId) return reply.code(400).send({ ok: false, code: "E_SCHEMA_INVALID", message: "memoryId 必填" });
    const done = await deps.canonize.tombstone(body.memoryId, body.reason ?? "管理员撤回");
    if (done) return { ok: true };
    // 撤回失败的真实原因从世界层记忆状态推：不存在 = 404 语义，已撤回 = 不可变
    // 存在性用记忆索引判（sample(200) 在世界层 >200 条时会误判 404，审阅 P2-⑤）
    const hit = deps.memory.get?.(body.memoryId);
    if (!hit) return reply.code(404).send({ ok: false, code: "E_REF_NOT_FOUND", message: `世界记忆 ${body.memoryId} 不存在` });
    return reply.code(409).send({ ok: false, code: "E_MEMORY_IMMUTABLE", message: `世界记忆 ${body.memoryId} 已撤回或不可变` });
  });

  /** 观测（P4）：只读指标 + 人工抽样复审用的永久记忆清单 */
  app.get("/api/v1/admin/stats", async (req, reply) => {
    if (!adminTokenOf(req.headers) || adminTokenOf(req.headers) !== (deps.adminToken ?? "")) {
      return reply.code(403).send({ ok: false, code: "E_FORBIDDEN", message: "需要管理员令牌" });
    }
    const q = req.query as { roomId?: string; sample?: string };
    const rooms = q.roomId ? [q.roomId] : [];
    const perRoom = rooms.map((roomId) => {
      const records = deps.memory.all(roomId);
      const byTier: Record<string, number> = {};
      let tombstoned = 0;
      for (const r of records) {
        byTier[r.tier ?? "short"] = (byTier[r.tier ?? "short"] ?? 0) + 1;
        if (r.status === "tombstoned") tombstoned += 1;
      }
      return { roomId, total: records.length, byTier, tombstoned };
    });
    const canonize = deps.canonize ? deps.canonize.stats() : null;
    const sample = deps.canonize ? deps.canonize.sample(Number(q.sample ?? 10)) : [];
    return { ok: true, canonize, rooms: perRoom, sample };
  });

  // ---------------------------------------------------------------- 地图（docs/06 §4）
  app.get("/api/v1/rooms/:roomId/map", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    if (!(await roomGate(roomId, reply))) return reply;
    const q = req.query as { actorId?: string };
    return safe(reply, () => deps.map.getMap(roomId, q.actorId));
  });

  app.post("/api/v1/rooms/:roomId/map/travel", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    if (!(await roomGate(roomId, reply))) return reply;
    const parsed = TravelBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return schemaError(zodMessage(parsed.error));
    return safe(reply, () => deps.map.travel(roomId, parsed.data.actorId, parsed.data.locId));
  });

  app.post("/api/v1/rooms/:roomId/map/tick", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    if (!(await roomGate(roomId, reply))) return reply;
    const parsed = TickBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return schemaError(zodMessage(parsed.error));
    return safe(reply, () => deps.map.tick(roomId, parsed.data));
  });

  app.post("/api/v1/rooms/:roomId/map/dialogue", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    if (!(await roomGate(roomId, reply))) return reply;
    const parsed = DialogueBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return schemaError(zodMessage(parsed.error));
    return safe(reply, () =>
      deps.map.openDialogue(roomId, parsed.data.actorId, parsed.data.sceneId, parsed.data.dialogueId),
    );
  });

  app.post("/api/v1/map/drafts", (req, reply) => safe(reply, () => deps.map.createDraft(req.body)));

  app.get("/api/v1/map/drafts", (req, reply) => safe(reply, () => deps.map.listDrafts(adminTokenOf(req.headers))));

  app.get("/api/v1/map/drafts/:id", (req, reply) => {
    const { id } = req.params as { id: string };
    return safe(reply, () => deps.map.getDraft(id));
  });

  app.post("/api/v1/admin/map/drafts/:id/review", (req, reply) => {
    const { id } = req.params as { id: string };
    return safe(reply, () => deps.map.reviewDraft(id, adminTokenOf(req.headers), req.body));
  });

  app.post("/api/v1/admin/map/drafts/:id/publish", (req, reply) => {
    const { id } = req.params as { id: string };
    return safe(reply, () => deps.map.publishDraft(id, adminTokenOf(req.headers), req.body));
  });

  app.post("/api/v1/admin/map/drafts/:id/generate", (req, reply) => {
    const { id } = req.params as { id: string };
    return safe(reply, () => deps.map.retryGenerate(id, adminTokenOf(req.headers)));
  });

  // ---------------------------------------------------------------- 图鉴 / 开局剧本（docs/03 §5.2.5、§5.2.6）
  // 路由实现放独立文件，这里只做装配：并行开发时这段代码尽量不成为冲突点。
  // 图鉴需要"房间存在性"：FileStore 有 listRooms，snapshot 对缺失房间不抛错；
  // 测试替身若不实现 listRooms，按空房间表处理（图鉴 404），不影响其它端点。
  const viewStore = deps.store as Store & { listRooms?: () => Promise<string[]> };
  registerViewRoutes(app, {
    store: {
      snapshot: (roomId) => viewStore.snapshot(roomId),
      listRooms: () => viewStore.listRooms?.() ?? Promise.resolve([]),
    },
    registry: deps.registry,
    scenarios: deps.scenarios ?? EMPTY_SCENARIOS,
  });
}
