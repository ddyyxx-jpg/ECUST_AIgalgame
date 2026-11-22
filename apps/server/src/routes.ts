/**
 * HTTP/SSE 层：只做两件事——把请求变成 service/turn 调用、把结果原样返回。
 * 不含业务规则；游戏层拒绝一律 HTTP 200 + {ok:false,code,message}，500 只表示未预期异常。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ActorId, Memory, MemoryRecord, Registry, RoomId, Store, Turn, TurnEvent, WorldState } from "../../../packages/shared/src/contract/types.ts";
import type { ConversationEvent, GossipEvent, MessageDigest, UtteranceModeDef } from "../../../packages/shared/src/contract/v2.ts";
import { projectEventsForPlayer, playerOf, projectStateForPlayer, projectTurnEventForPlayer } from "./outbound-secrets.ts";
import { projectConversationEvents, saveSnapshot, sessionSnapshotPath, type ConversationHostV2 } from "../../../packages/engine/src/v2/index.ts";
import { DialogueBodySchema, TickBodySchema, TravelBodySchema, zodMessage } from "./map.data.ts";
import type { MapService } from "./map.ts";
import type { LlmSettings } from "./settings.ts";
import { maskNamesDeep, unmaskTargetPlaceholder, unknownPlaceholders } from "./view-names.ts";
import { askedNameTargetId, introducedPresentIds, viewerSpeech } from "./name-unlock.ts";
import type { SaveIndex } from "./saves.ts";
import type { TurnHistory } from "./turn-history.ts";
import { registerResumeRoutes } from "./resume.routes.ts";
import { registerSlotsRoutes } from "./slots.routes.ts";
import { registerAuthRoutes, type AuthService } from "./auth.ts";
import { registerAdminRoutes } from "./admin.routes.ts";
import { dailyLimitFor } from "./auth-store.ts";
import type { TurnLedger } from "./quota.ts";
import type { AdminLog } from "./admin-log.ts";
import { RoomBusyError, type RoomActivity } from "./room-activity.ts";
import { makeRoomExists } from "./room-exists.ts";
import { isSafeRoomId } from "../../../packages/engine/src/store.ts";
import { clampLimit } from "./limit.ts";
import { isRoomSyncFault, StoreCommitUnknownError } from "../../../packages/engine/src/store-write.ts";
import { EMPTY_SCENARIOS } from "./scenarios.ts";
import type { ScenarioCatalog } from "./scenarios.ts";
import { registerViewRoutes } from "./view.routes.ts";
import { adminTokenOf, guardRoom } from "./room-guard.ts";
import { AdminTokenGate, type TokenVerdict } from "./admin-token.ts";
import { isStoreFault, storeFaultMessage } from "./store-fault.ts";
import { parseCommitEvidence } from "@galgame/engine";
import type { TurnCommitEvidence } from "@galgame/engine";
import { registerDebugRoutes } from "./debug.routes.ts";
import type { DebugGate } from "./debug.ts";

export interface AppDeps {
  store: Store;
  turn: Turn;
  map: MapService;
  /** 运行时模型接入（玩家自备 key）：/api/v1/settings/llm */
  settings: LlmSettings;
  /** 注册表（属性声明）；/api/v1/registry 给前端按数据渲染面板用（I2） */
  registry: Registry;
  /** npcId → 外貌描述（content/scenarios/npcs.json 的 appearance）：未认识时的占位名 */
  appearance?: Map<string, string>;
  /** 解锁"玩家知道了这些 NPC 的名字"（回合文本里对方自报姓名后调用，见 name-unlock.ts） */
  learnNpcNames?(roomId: string, npcIds: string[]): Promise<void>;
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
    /** 带失败原因的同路径版本（PR #149 P2-4）：区分并发冲突与真正不可变 */
    tombstoneWithReason?(memoryId: string, reason: string): Promise<{ ok: boolean; code?: string }>;
    stats(): { worldId: string; version: number; writtenToday: number; writtenTotal: number; circuitOpen: boolean; consecutiveJudgeFailures: number };
    sample(limit: number): MemoryRecord[];
  };
  /** 管理员令牌；canonize 端点用它鉴权（地图端点由 MapService 自己校验） */
  adminToken?: string;
  /** 令牌校验 + 失败限流（registerRoutes 未提供时按 adminToken 新建；测试可注入独立实例） */
  adminGate?: AdminTokenGate;
  /** 请求级令牌判定缓存（registerRoutes 注入）：登录门/CSRF/room-guard/admin 共用，同一请求只计一次失败 */
  adminVerdict?: (req: FastifyRequest) => TokenVerdict;
  /** 世界印象（用户投影）：/me 只读，投递在 Turn 里 */
  impressions?: { pending(userId: string, roomId: string, limit: number): Promise<unknown[]>; count?(userId: string): Promise<number> };
  /** 回合历史（issue #7）：只记已提交回合，用于续玩重放 */
  history?: TurnHistory;
  /** 存档索引（issue #7）：账号 → 房间游标 */
  saves?: SaveIndex;
  /** 开局剧本 / NPC 公开档案（content/scenarios/*.json）；标题页与图鉴用，缺省 = 无预设 */
  scenarios?: ScenarioCatalog;
  /** 简易用户系统；缺省 = 不做会话鉴权（本地测试/旧调用） */
  auth?: AuthService;
  /** 行动额度账本（收敛稿 B1）；缺省 = 不做额度结算（本地测试） */
  ledger?: TurnLedger;
  /** dev/v2：微信私信宿主（未接线时不注册端点） */
  gossip?: {
    send(roomId: RoomId, from: ActorId, to: ActorId, content: string, opts?: { kind?: "player" | "system"; viewer?: ActorId }): Promise<GossipEvent[]>;
    inbox(roomId: RoomId, to: ActorId): MessageDigest[];
    subscribe(roomId: RoomId, viewer: ActorId, cb: (ev: GossipEvent) => void): () => void;
  };
  /** dev/v2：群聊会话宿主（未接线时不注册端点；#90 起会话从独立快照文件恢复，见 bootstrap.ts） */
  conversation?: { host: ConversationHostV2; modes?: Map<string, UtteranceModeDef>; dataDir?: string };
  /** 管理操作日志 */
  adminLog?: AdminLog;
  /** Cookie 写请求 CSRF 允许的 Origin（authRequired=1 时用） */
  publicOrigin?: string;
  /** 调试面板口令门；缺省/未配置时不注册调试端点 */
  debugGate?: DebugGate | null;
  /** 单次历史/事件响应行数上限（默认 200，GALGAME_HISTORY_LIMIT_MAX） */
  historyLimitMax?: number;
  /** 房间活动计数：玩家回合执行期间为忙，自动时钟/地图 tick 据此让路。 */
  roomActivity?: RoomActivity;
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

/** dev/v2 群聊回合请求：speaker 由 guardRoom 绑定后的 actorId 决定，客户端不能代别人发言 */
const ConversationBodySchema = z
  .object({
    actorId: z.string().min(1).optional(),
    clientTurnId: z.string().min(1).max(120),
    userId: z.string().optional(),
    interject: z.string().min(1).optional(),
    /** #136：玩家沉默时推进一轮 NPC-NPC 自主对话（与 utterance 互斥，由引擎裁决） */
    auto: z.boolean().optional(),
    utterance: z
      .object({
        id: z.string().min(1).optional(),
        speaker: z.string().min(1).optional(),
        mode: z.string().min(1),
        target: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
        content: z.string().max(2000).optional(),
        action: z.string().max(2000).optional(),
        coverAction: z.string().max(2000).optional(),
        notice: z.string().max(2000).optional(),
        // #135：关键台词提权（1–5）；docs/03 已登记，schema 漏了会让前端 400
        salience: z.number().min(1).max(5).optional(),
      })
      .optional(),
  })
  .strict();

/** 前端（#85）兼容别名：自然语言 input + 可选 targetNpcId → utterance，复用同一 SSE 回合 */
const ConversationTurnAliasSchema = z
  .object({
    actorId: z.string().min(1),
    input: z.string().min(1).max(2000),
    clientTurnId: z.string().min(1).max(120),
    targetNpcId: z.string().min(1).optional(),
    userId: z.string().optional(),
  })
  .strict();

type ConversationBody = z.infer<typeof ConversationBodySchema>;

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

function schemaError(message: string): GameError {
  return { ok: false, code: "E_SCHEMA_INVALID", message };
}

/**
 * 从 EventLog 找 turn.committed 提交证据（issue #76）。
 * 标记与状态事件同批落盘，是提交事实；坏标记跳过，绝不把未提交回合误判为已提交。
 */
async function findCommitEvidence(
  store: Store,
  roomId: string,
  clientTurnId: string,
  actorId?: string,
): Promise<TurnCommitEvidence | undefined> {
  const envs = await store.events(roomId, 0);
  for (const env of envs) {
    const evidence = parseCommitEvidence(env);
    if (!evidence) continue;
    if (evidence.clientTurnId !== clientTurnId) continue;
    if (actorId && evidence.actorId !== actorId) continue;
    return evidence;
  }
  return undefined;
}

/** 管理员鉴权失败超限：429 + Retry-After（不再暴露"这次令牌对不对"） */
function tooManyAdminAttempts(reply: FastifyReply, retryAfterMs?: number): FastifyReply {
  if (retryAfterMs && retryAfterMs > 0) reply.header("retry-after", String(Math.ceil(retryAfterMs / 1000)));
  return reply.code(429).send({ ok: false, code: "E_RATE_LIMITED", message: "管理员鉴权失败次数过多，请稍后再试" });
}

/**
 * 账号维度：优先 `X-User-Id` 头（联机/生产由登录态中间件注入），其次请求体，最后开发期默认值。
 * 只在服务端用；绝不把 userId 当权限凭据（它是"哪份记忆档案"的键，不是 token）。
 */
export function userIdOf(req: FastifyRequest, deps: AppDeps, body?: { userId?: string }): string | undefined {
  // 会话优先：登录后 userId 由服务端 Cookie 决定，客户端 header/body 不再参与。
  if (deps.auth) {
    const fromSession = deps.auth.resolveUserId(req);
    if (fromSession) return fromSession;
    if (deps.auth.required) return undefined;
  }
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
    if (isStoreFault(e)) {
      return reply.code(503).send({ ok: false, code: "E_STORE_FAULT", message: storeFaultMessage(e, "存储读写失败，请稍后重试") });
    }
    return reply.code(500).send({ ok: false, code: "E_MODULE_FAULT", message: "服务器内部错误" });
  }
}

export function registerRoutes(app: FastifyInstance, deps: AppDeps): void {
  // 未预期异常兜底：存储故障统一 503 E_STORE_FAULT 并脱敏（不把 fs 路径回显给客户端），
  // 其余 500 E_MODULE_FAULT；业务拒绝不经过这里。
  app.setErrorHandler((error, _req, reply) => {
    // Fastify 自己的可预期 4xx（非法 JSON 400 / body 过大 413 / 不支持的 Content-Type 415）
    // 必须保留状态码，不能被折叠成 500；只做脱敏，不回显底层解析细节。
    const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
    const status = typeof statusCode === "number" ? statusCode : 500;
    if (status >= 400 && status < 500) {
      const code = status === 401 ? "E_UNAUTHORIZED" : status === 403 ? "E_FORBIDDEN" : "E_SCHEMA_INVALID";
      const message = status === 413 ? "请求体过大" : status === 415 ? "不支持的 Content-Type" : "请求格式不正确";
      return reply.code(status).send({ ok: false, code, message });
    }
    console.error("[server] unhandled route error", error);
    if (isStoreFault(error)) {
      return reply.code(503).send({ ok: false, code: "E_STORE_FAULT", message: storeFaultMessage(error, "存储读写失败，请稍后重试") });
    }
    return reply.code(500).send({ ok: false, code: "E_MODULE_FAULT", message: "服务器内部错误" });
  });
  // 所有 admin-token 入口共用同一份失败计数：routes 守卫、room-guard、admin 端点都从这里取
  const adminGate = deps.adminGate ?? new AdminTokenGate(deps.adminToken ?? "");
  deps.adminGate = adminGate;
  // 同一请求的多个 hook/守卫会重复问令牌：缓存结果，避免一次坏令牌被计成多次失败
  const verdictCache = new WeakMap<FastifyRequest, ReturnType<AdminTokenGate["check"]>>();
  const adminVerdict = (req: FastifyRequest) => {
    // 没带令牌 = 走会话/管理员角色判定，不计失败（否则普通玩家的设置请求也会挤爆限流）
    const token = adminTokenOf(req.headers);
    if (!token) return { ok: false };
    const cached = verdictCache.get(req);
    if (cached) return cached;
    const verdict = adminGate.check(token, req.ip);
    verdictCache.set(req, verdict);
    return verdict;
  };
  // room-guard 与登录门/CSRF 共用同一份请求级判定：否则房间写入口会把同一次坏令牌再计一次
  deps.adminVerdict = adminVerdict;

  // 所有带 :roomId 的路径先过白名单：roomId 只允许作为 id，不能变成文件路径。
  // Fastify 会先解码 `%2F`，所以 `..%2F..%2Fpwn` 到这里已经是 `../../pwn`；必须在这里挡。
  app.addHook("preHandler", async (req, reply) => {
    const params = req.params as { roomId?: string } | undefined;
    const roomId = params?.roomId;
    if (roomId !== undefined && !isSafeRoomId(roomId)) {
      return reply.code(400).send({ ok: false, code: "E_SCHEMA_INVALID", message: "非法 roomId" });
    }
  });

  // 强制登录（部署时 GALGAME_AUTH_REQUIRED=1）：除公开端点外一律 401。
  // 公开端点只有 health / registry / scenarios / auth/*；房间、回合、存档、历史、图鉴、地图都要会话。
  // 例外：带有效 x-admin-token 的运维调用可访问 admin/settings（脚本无会话）。
  // 顺序很重要：hook 必须注册在 auth/admin 路由之前（Fastify 只对之后注册的路由生效）。
  const PUBLIC_PATHS = new Set(["/api/v1/health", "/api/v1/registry", "/api/v1/scenarios"]);
  const hasAdminToken = (req: FastifyRequest): boolean => adminVerdict(req).ok;
  app.addHook("preHandler", async (req, reply) => {
    if (!deps.auth?.required) return;
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (!path.startsWith("/api/")) return;
    if (path.startsWith("/api/v1/auth/") || PUBLIC_PATHS.has(path)) return;
    if ((path.startsWith("/api/v1/admin/") || path.startsWith("/api/v1/settings/") || path.startsWith("/api/v1/map/drafts") || path.startsWith("/api/v1/rooms/"))) {
      const verdict = adminVerdict(req);
      if (verdict.blocked) return tooManyAdminAttempts(reply, verdict.retryAfterMs);
      if (verdict.ok) return;
    }
    if (!deps.auth.resolve(req)) {
      return reply.code(401).send({ ok: false, code: "E_UNAUTHORIZED", message: "请先登录" });
    }
  });

  // CSRF（收敛稿 B1，docs/03 §5.2.8）：authRequired=1 时，Cookie 写请求必须带合法 Origin。
  // /auth/* 的写路由（含 login/register/reset）同样校验：否则攻击者可跨站把受害者登进攻击者账号。
  // x-admin-token 运维调用豁免；不信任 Host/转发头。
  app.addHook("preHandler", async (req, reply) => {
    if (!deps.auth?.required) return;
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return;
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (!path.startsWith("/api/")) return;
    if (hasAdminToken(req)) return;
    const isAuthWrite = path.startsWith("/api/v1/auth/");
    // 非 auth 写：无会话的请求（登录前的首次写）豁免；auth 写一律校验（login CSRF 面）
    if (!isAuthWrite && !deps.auth.resolve(req)) return;
    const origin = req.headers.origin;
    if (!deps.publicOrigin || origin !== deps.publicOrigin) {
      return reply.code(403).send({ ok: false, code: "E_FORBIDDEN", message: "跨站写请求被拒绝（Origin 校验）" });
    }
  });

  // 登录/注册/登出与管理端点放在 hook 之后注册，才能被上面的登录门与 CSRF 覆盖。
  if (deps.auth) registerAuthRoutes(app, deps.auth);
  if (deps.auth && deps.ledger && deps.adminLog) {
    registerAdminRoutes(app, { auth: deps.auth, ledger: deps.ledger, log: deps.adminLog, adminToken: deps.adminToken ?? "", gate: adminGate, verdictOf: adminVerdict });
  }

  const roomExists = makeRoomExists(deps.store);

  /**
   * 房间入口统一守卫（issue #37）：世界层房间与不存在的房间一律 404，且必须先于
   * body 校验、SSE 开流与任何写操作。存在性走 `listRooms()`（持久化事实），
   * 不再依赖 `snapshot()` 抛错——后者对缺失房间返回空状态，会把未知房间当 200。
   * 存在性（roomGate）在前，归属授权（guardRoom，issue #33）在后。
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

  /** 全局暂停：所有会写世界/历史的入口共用；地图 travel/tick/dialogue 不能绕过回合入口的开关 */
  const actionsPaused = (reply: FastifyReply): boolean => {
    if (deps.auth?.store.getSettings().actionsEnabled !== false) return false;
    reply.code(429).send({ ok: false, code: "E_RATE_LIMITED", message: "本轮体验已暂停新行动" });
    return true;
  };

  // 公开健康检查只回 ok + 契约版本（建议11）：canonize 的启用/judge 等运维细节
  // 移到鉴权后的 /admin/stats，避免向未登录者暴露内部 fail-closed 配置。
  app.get("/api/v1/health", async () => ({
    ok: true,
    contract: deps.version,
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

  // ---------------------------------------------------------------- 模型接入（docs/03 §5.2.2，管理员）
  // P1-1：auth 存在时要求 admin-token/管理员会话——反代下 req.ip 恒为 loopback，本机 IP 口径失效。
  const settingsGuard = (req: FastifyRequest): GameError | null => {
    if (deps.auth) {
      const verdict = adminVerdict(req);
      if (verdict.ok) return null;
      if (verdict.blocked) return { ok: false, code: "E_RATE_LIMITED", message: "管理员鉴权失败次数过多，请稍后再试" };
      if (deps.auth.resolve(req)?.role === "admin") return null;
      return { ok: false, code: "E_FORBIDDEN", message: "模型设置仅允许管理员操作" };
    }
    return requireLocal(req);
  };
  app.get("/api/v1/settings/llm", async (req) => {
    const deny = settingsGuard(req);
    if (deny) return deny;
    return { ok: true, view: deps.settings.view() };
  });

  // 暂缓开放（PR #19 P2）：玩家投稿入口已从界面移除，服务端同步收口——草案创建/详情仅管理员。
  // 接用户系统时按 admin-token 或 admin 会话判定；本地无 auth 保留单机开发能力。
  const adminOnly = (req: FastifyRequest, message: string): GameError | null => {
    if (!deps.auth) return null;
    const verdict = adminVerdict(req);
    if (verdict.ok) return null;
    if (verdict.blocked) return { ok: false, code: "E_RATE_LIMITED", message: "管理员鉴权失败次数过多，请稍后再试" };
    if (deps.auth.resolve(req)?.role === "admin") return null;
    return { ok: false, code: "E_FORBIDDEN", message };
  };
  /** 经 adminOnly 放行后再取令牌交给 MapService 二次校验；本身不作为鉴权凭据（#105）。 */
  const adminToken = (req: FastifyRequest): string => adminTokenOf(req.headers);

  app.post("/api/v1/settings/llm", async (req) => {
    const deny = settingsGuard(req);
    if (deny) return deny;
    const r = await deps.settings.apply(req.body);
    return r.ok ? { ok: true, view: r.view } : { ok: false, code: r.code, message: r.message };
  });

  app.delete("/api/v1/settings/llm", async (req) => {
    const deny = settingsGuard(req);
    if (deny) return deny;
    await deps.settings.clear();
    return { ok: true, view: deps.settings.view() };
  });

  app.post("/api/v1/rooms", async (req, reply) => {
    const body = (req.body ?? {}) as { mode?: "solo" | "coop"; userId?: string; scenarioId?: string };
    const userId = userIdOf(req, deps, body);
    if (deps.auth?.required && !userId) {
      return reply.code(401).send({ ok: false, code: "E_UNAUTHORIZED", message: "请先登录" });
    }
    const room = await deps.createRoom(body.mode === "coop" ? "coop" : "solo", userId);
    // 新房间已经落盘，丢掉存在性缓存（issue #78）：紧接着的 /state /turns 必须能看到它，
    // 否则缓存会把刚建的房间当不存在而回 404。
    roomExists.invalidate();
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
    if (!q.roomId || !q.actorId) return reply.code(400).send({ code: "E_SCHEMA_INVALID", message: "roomId/actorId 必填" });
    // 先定账号口径（缺身份是 schema 错），再走房间存在性 + 成员授权；
    // 否则非成员能借 `/me` 读到旧档/世界层房间的派生记忆（复审 P2）。
    const userId = userIdOf(req, deps);
    if (!userId) {
      return deps.auth?.required
        ? reply.code(401).send({ ok: false, code: "E_UNAUTHORIZED", message: "请先登录" })
        : reply.code(400).send({ code: "E_SCHEMA_INVALID", message: "缺少 X-User-Id（或 GALGAME_DEV_USER）" });
    }
    if (!(await roomGate(q.roomId, reply))) return reply;
    const access = await guardRoom(req, reply, deps, q.roomId, userIdOf);
    if (!access) return reply;
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
  const resumeHelpers = { userIdOf, isWorldRoom, roomExists };
  registerResumeRoutes(app, deps, resumeHelpers);
  // 命名槽（issue #98）：docs/03 §5.2.7 已登记，独立区块见 slots.routes.ts
  registerSlotsRoutes(app, deps, resumeHelpers);

  // ---------------------------------------------------------------- dev/v2 微信私信
  if (deps.gossip) {
    const gossip = deps.gossip;
    app.get("/api/v1/rooms/:roomId/messages", async (req, reply) => {
      const { roomId } = req.params as { roomId: string };
      if (!(await roomGate(roomId, reply))) return reply;
      const q = req.query as { actorId?: string };
      const viewer = q.actorId;
      if (!viewer) return reply.code(400).send({ ok: false, code: "E_SCHEMA_INVALID", message: "actorId 必填" });
      const access = await guardRoom(req, reply, deps, roomId, userIdOf, { actorId: viewer });
      if (!access) return reply;
      // 收件箱只按 actorId 查；玩家不是收发任一方的消息不会出现在响应里
      const messages = gossip.inbox(roomId, viewer);
      return { ok: true, messages };
    });

    app.post("/api/v1/rooms/:roomId/messages", async (req, reply) => {
      const { roomId } = req.params as { roomId: string };
      if (!(await roomGate(roomId, reply))) return reply;
      const body = (req.body ?? {}) as { from?: string; to?: string; content?: string; userId?: string };
      if (!body.from || !body.to || !body.content) {
        return reply.code(400).send({ ok: false, code: "E_SCHEMA_INVALID", message: "from/to/content 必填" });
      }
      const access = await guardRoom(req, reply, deps, roomId, userIdOf, { actorId: body.from, body: { userId: body.userId } });
      if (!access) return reply;
      const events = await gossip.send(roomId, body.from, body.to, body.content, { kind: "player", viewer: body.from });
      const error = events.find((e) => e.type === "gossip.error");
      if (error && error.type === "gossip.error") {
        return reply.code(200).send({ ok: false, code: error.code, message: error.message });
      }
      return { ok: true, events };
    });

    /** SSE：只推送该 actorId 收发的 gossip.message，其他人的私信不会到浏览器 */
    app.get("/api/v1/rooms/:roomId/messages/stream", async (req, reply) => {
      const { roomId } = req.params as { roomId: string };
      if (!(await roomGate(roomId, reply))) return reply;
      const q = req.query as { actorId?: string };
      const viewer = q.actorId;
      if (!viewer) return reply.code(400).send({ ok: false, code: "E_SCHEMA_INVALID", message: "actorId 必填" });
      const access = await guardRoom(req, reply, deps, roomId, userIdOf, { actorId: viewer });
      if (!access) return reply;
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const send = (ev: GossipEvent): void => {
        reply.raw.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      };
      send({ type: "gossip.committed", ids: [] });
      const off = gossip.subscribe(roomId, viewer, send);
      const ping = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);
      ping.unref?.();
      req.raw.on("close", () => { clearInterval(ping); off(); });
    });
  }

  // ---------------------------------------------------------------- dev/v2 群聊回合（issue #89）
  if (deps.conversation) {
    const host = deps.conversation.host;
    /** roomId → sessionId：进程内映射；会话本体/幂等缓存也在 host 内存里，重启即新会话 */
    const sessions = new Map<string, string>();
    // 淘汰阈值默认 256；env 仅供单测压低到个位数触发淘汰路径（与 GALGAME_GOSSIP_SCAN_MS 同风格）
    const configuredMax = Number(process.env.GALGAME_CONVERSATION_MAX_SESSIONS);
    const MAX_SESSIONS = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 256;

    /**
     * 房间级串行（MAJOR-2）：openOrReuse 的 get/open/insert 必须与本轮 host.run 共用一把锁，
     * 否则并发首回合会各自 open（实测 openCalls=2）。host.exclusive 是私有方法且只覆盖 runInner，
     * 这里另起一条 Promise 链把 open+run 整体包住，两层锁不同、不嵌套，不会自锁。
     */
    const turnChains = new Map<string, Promise<void>>();
    const serializeTurn = <T>(roomId: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
      const prev = turnChains.get(roomId) ?? Promise.resolve();
      // 只在回合真正执行时标记忙（排队等待不算），让自动时钟在排队阶段仍可推进。
      const run = async (): Promise<T> => {
        const leave = deps.roomActivity ? await deps.roomActivity.acquire(roomId, 30_000, signal) : undefined;
        try {
          return await fn();
        } finally {
          leave?.();
        }
      };
      const next = prev.then(run, run);
      const tail = next.then(() => undefined, () => undefined);
      turnChains.set(roomId, tail);
      void tail.finally(() => {
        if (turnChains.get(roomId) === tail) turnChains.delete(roomId);
      });
      return next;
    };

    const openOrReuse = async (roomId: string, actorId: string, state: WorldState) => {
      const cached = sessions.get(roomId);
      let session = cached ? host.get(cached) : undefined;
      if (!(session && session.roomId === roomId && session.status === "open")) {
        // #123 P0-C：进程内 Map 在重启后必然为空，但 bootstrap 已把快照恢复进 host。
        // 这里回退到 host.getByRoom，否则恢复的会话成孤儿、被新 open 的 conv 覆盖。
        const restored = host.getByRoom(roomId);
        if (restored && restored.roomId === roomId && restored.status === "open") {
          session = restored;
          sessions.set(roomId, restored.id);
        }
      }
      if (session && session.roomId === roomId && session.status === "open") {
        // #104：复用时 participants 以 host 内会话为准（这里不重算/不覆盖），
        // 后续回合的可见性投影读 host.get(sessionId).participants，而非本函数的入参快照。
        return { sessionId: session.id, opened: undefined as ConversationEvent | undefined };
      }
      const present = [...state.room.scene.presentIds];
      if (!present.includes(actorId)) present.unshift(actorId);
      // #104：participants 只是 open 时的初始猜测；host.open 内部按快照场景归一人后以 host 内为准。
      const fresh = await host.open({ roomId, participants: present });
      if (sessions.size >= MAX_SESSIONS) {
        const oldest = sessions.keys().next().value;
        if (oldest) {
          // #104：淘汰映射前先 close 旧 host 会话（标记 closed + 回收幂等缓存），避免会话泄漏。
          const evictedId = sessions.get(oldest);
          if (evictedId) host.close(evictedId);
          sessions.delete(oldest);
        }
      }
      sessions.set(roomId, fresh.id);
      const opened: ConversationEvent = { type: "conversation.opened", sessionId: fresh.id, participants: [...fresh.participants] };
      return { sessionId: fresh.id, opened };
    };

    /** 一回合 SSE 的共用实现；两种入参形状都归一到 ConversationBody 后走这里 */
    const runConversationTurn = async (req: FastifyRequest, reply: FastifyReply, roomId: string, body: ConversationBody) => {
      if (!(await roomGate(roomId, reply))) return reply;
      // interject 是"被插话的 NPC"，不是调用者本人：不能拿它推 actorId（否则可冒充 NPC）
      const actorId = body.actorId ?? body.utterance?.speaker;
      if (!actorId) return reply.code(400).send(schemaError("actorId / utterance.speaker 至少一个必填"));
      const access = await guardRoom(req, reply, deps, roomId, userIdOf, { actorId, body: { userId: body.userId } });
      if (!access) return reply;
      if (actionsPaused(reply)) return reply;

      // #104：与 v1 /turns 共用同一 TurnLedger 计量。按逻辑请求预留，拒绝必须在 SSE 头之前，
      // 未登录（本地无 auth/无 userId）不结算额度；成功后 committed，失败/提前 EOF 按状态机回收。
      const userId = access.userId;
      const turnScope = userId ? { userId, roomId, clientTurnId: body.clientTurnId } : undefined;
      const ledger = userId ? deps.ledger : undefined;
      // charged=false：本请求不新增计费（未登录，或 v2 的同 ID 重放命中 host 幂等缓存、无 LLM 调用）
      let charged = false;
      // #104：预留与 host.run 共用房间串行锁（MAJOR-2）。v2 并发首回合的多个不同 clientTurnId
      // 若在锁外 reserve，第二条会被 TurnLedger「同一用户同时只允许一个 running」抢先拒绝；
      // 而 host 层本就把它们串行执行。放进锁内让第二条等第一条 committed 后再 reserve，
      // 与 v1 /turns「按实际 LLM 调用计费」口径一致。reserve/settle 都在这把锁内完成。
      const reserveTurn = async (): Promise<boolean> => {
        if (!ledger || !userId || !turnScope) return true;
        const settings = deps.auth?.store.getSettings();
        const dailyLimit = settings ? dailyLimitFor(settings, userId) : null;
        const reserved = ledger.reserve({
          ...turnScope, actorId,
          dailyLimit, actionsEnabled: settings?.actionsEnabled ?? true,
        });
        if (!reserved.ok) {
          if (reserved.code === "E_PRECONDITION" && reserved.committedSeq !== undefined) {
            // #123 P1-1：ledger 说 committed 还不够——必须 host 幂等缓存里真有这条提交才算重放。
            // 快照丢失/崩溃窗口下 host 已无该 key：此时放行会生成新回合并且不计费（P1-1 原 bug），
            // 因此 fail-closed 返回 409，让客户端换新 clientTurnId 重试。
            if (host.hasCommittedByRoom(roomId, actorId, body.clientTurnId)) return true;
            reply.code(409).send({
              ok: false, code: "E_PRECONDITION",
              message: "该 clientTurnId 已提交但会话缓存已失效，请使用新的 clientTurnId 重试",
              committedSeq: reserved.committedSeq,
            });
            return false;
          }
          const status = reserved.code === "E_RATE_LIMITED" ? 429 : 409;
          reply.code(status).send({ ok: false, code: reserved.code, message: reserved.message, ...(reserved.committedSeq !== undefined ? { committedSeq: reserved.committedSeq } : {}) });
          return false;
        }
        charged = true;
        // running 必须先确认落盘再开跑，与 /turns 同口径（磁盘上不能只留 reserved）
        try {
          await ledger.transitionDurable(turnScope, "running");
        } catch {
          ledger.transition(turnScope, "failed");
          charged = false;
          reply.code(503).send({ ok: false, code: "E_STORE_FAULT", message: "额度账本写入失败，行动未开始，可重试" });
          return false;
        }
        return true;
      };

      const utterance = body.utterance
        ? { ...body.utterance, id: body.utterance.id ?? `utt_${body.clientTurnId}`, speaker: actorId }
        : undefined;
      // v2 别名路由的 input 与 v1 来自同一个前端拼法：「对<展示名>说：…」。同样在喂给
      // 引擎前把目标展示名换回真名（引擎按 content 原样进 NPC 提示词）。
      const utteranceTargetId =
        utterance?.target && typeof utterance.target === "string" ? utterance.target : undefined;
      const utteranceTarget = utteranceTargetId ? access.state.entities[utteranceTargetId] : undefined;
      // 与 v1 /turns 同口径：只有目标此刻在场才实名化，缺席的人不能被第三方客户端借这个字段点名
      const utteranceTargetPresent =
        utteranceTarget !== undefined && access.state.room.scene.presentIds.includes(utteranceTarget.id);
      if (utterance?.content && utteranceTarget && utteranceTargetPresent && utteranceTarget.kind === "npc") {
        const placeholder = unknownPlaceholders(access.state, deps.appearance).get(utteranceTarget.name);
        utterance.content = unmaskTargetPlaceholder(utterance.content, placeholder, utteranceTarget.name);
      }
      // D22：玩家对话/插话的 NPC 若正在执行动作，本轮对话期间冻结其租约；
      // 回合结束（含异常）恢复，剩余占用继续由 map tick 走完。target 与 interject
      // 可能同时在场，两者都要冻结，否则被插话的 NPC 会在说话时继续走日程。
      const talkNpcIds: string[] = [];
      // 契约允许 target 是 string 或 string[]（多目标），两种形态都要冻结。
      const targetIds = utterance?.target === undefined
        ? []
        : Array.isArray(utterance.target) ? utterance.target : [utterance.target];
      for (const id of targetIds) {
        if (typeof id !== "string") continue;
        const targetEntity = access.state.entities[id];
        if (targetEntity?.kind === "npc" && access.state.room.scene.presentIds.includes(id) && !talkNpcIds.includes(id)) {
          talkNpcIds.push(id);
        }
      }
      if (
        body.interject
        && access.state.entities[body.interject]?.kind === "npc"
        && access.state.room.scene.presentIds.includes(body.interject)
        && !talkNpcIds.includes(body.interject)
      ) {
        talkNpcIds.push(body.interject);
      }
      const suspendedNpcIds: string[] = [];
      let sessionId = "";
      let opened: ConversationEvent | undefined;
      const out: ConversationEvent[] = [];
      let caught: unknown;
      // 房间锁内：额度预留 → openOrReuse → host.run → 结算，全在同一把锁上。
      // 拒绝（额度不足/账本写失败）必须在 SSE 头之前返回，故先把锁内阶段的结果带出来。
      let denied = false;
      const acquireAbort = new AbortController();
      const onClientClose = () => acquireAbort.abort();
      req.raw.once("close", onClientClose);
      try {
        await serializeTurn(roomId, async () => {
          if (!(await reserveTurn())) { denied = true; return; }
          try {
            const r = await openOrReuse(roomId, actorId, access.state);
            sessionId = r.sessionId;
            opened = r.opened;
            for (const npcId of talkNpcIds) {
              const frozen = await deps.map.suspendNpcAction(roomId, npcId);
              if (frozen) suspendedNpcIds.push(npcId);
            }
            for await (const ev of host.run(r.sessionId, {
              clientTurnId: body.clientTurnId,
              ...(utterance ? { utterance } : {}),
              ...(body.interject ? { interject: body.interject } : {}),
              ...(body.auto ? { auto: true } : {}),
              ...(access.userId ? { userId: access.userId } : {}),
            })) out.push(ev);
            // #104：结算与事件流同源——只有真的 committed 才记 committed；
            // conversation.error（含插话/拒绝）按 failed；无 committed 也无 error 的提前结束按 unconfirmed。
            if (charged && turnScope && ledger) {
              const commitEv = out.find((e) => e.type === "conversation.committed");
              const errored = out.some((e) => e.type === "conversation.error");
              if (commitEv && commitEv.type === "conversation.committed") {
                // conversation.* 不写 EventLog（无 Envelope seq），用回合号作为 committedSeq 供重放识别；
                // 重放时 reserve 见到 committedSeq 即放行到 host 幂等缓存，不重复计费。
                ledger.transition(turnScope, "committed", { committedSeq: commitEv.turn });
                // #90：回合已提交后把会话快照原子落盘（独立文件，不进 EventLog）。
                // 快照只是恢复投影，写失败只记日志，不影响已提交的世界真源。
                const dataDir = deps.conversation?.dataDir;
                if (dataDir) {
                  try {
                    await saveSnapshot(sessionSnapshotPath(dataDir, roomId), host.exportSessions(roomId));
                  } catch (e) {
                    console.warn(`[conversation] 保存房间 ${roomId} 会话快照失败（不影响已提交回合）：`, e instanceof Error ? e.message : e);
                  }
                }
              } else if (errored) ledger.transition(turnScope, "failed");
              else if (body.auto && out.some((e) => e.type === "conversation.notice")) {
                // 只限 auto 超上限：既没调模型也没写世界，不能按 unconfirmed 占额度。
                // 审核拦截（blocked）也只回 notice，但那是真实发生过的一次审核调用，维持 unconfirmed 原语义。
                ledger.transition(turnScope, "failed");
              } else ledger.transition(turnScope, "unconfirmed");
            }
          } catch (e) {
            // #104：异常路径按失败回收额度（未 committed），与 v1 /turns 的 catch 同口径；重放命中不结算
            if (charged && turnScope && ledger) ledger.transition(turnScope, "failed");
            caught = e;
          } finally {
            if (suspendedNpcIds.length > 0) {
              let restoredAll = true;
              for (const npcId of suspendedNpcIds) {
                if (!(await deps.map.resumeNpcAction(roomId, npcId))) {
                  restoredAll = false;
                  console.warn(`[conversation] NPC ${npcId} 动作租约恢复失败`);
                }
              }
              // committed 事件里的 state 是回合中途快照，含 talk 租约；全部恢复成功后才替换，
              // 避免把仍有冻结 NPC 的状态当成“已恢复”下发。用新事件对象替换，不能改 host 缓存里的同一对象。
              if (restoredAll) {
                const snapshot = structuredClone(await deps.store.snapshot(roomId));
                const idx = out.findIndex((e) => e.type === "conversation.committed");
                const commitEv = idx >= 0 ? out[idx] : undefined;
                if (commitEv && commitEv.type === "conversation.committed") {
                  out[idx] = { ...commitEv, state: snapshot };
                }
              }
            }
          }
        }, acquireAbort.signal);
      } catch (e) {
        if (e instanceof RoomBusyError) {
          return reply.code(409).send({ ok: false, code: "E_TURN_BUSY", message: e.message });
        }
        throw e;
      } finally {
        req.raw.off("close", onClientClose);
      }
      if (denied) return reply;
      reply.raw.writeHead(200, SSE_HEADERS);
      // #106：心跳注释行（SSE comment，前端 parseSsePart 会忽略）。与 gossip SSE 同口径，
      // 每 15s 写一次 `: ping\n\n`，避免代理/浏览器把长时间无数据的 LLM 流判为死连接。
      // 前端无需额外超时检测：SSE 的 onUnconfirmed（正常 EOF 未收到 committed/error）已覆盖断流。
      const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);
      heartbeat.unref?.();
      try {
        if (caught !== undefined) throw caught;
        if (opened) sseWrite(reply.raw, opened.type, opened);
        // 与 /turns 同一口径：收齐后按最终状态脱敏再一次性写出（模型可能把真名写进台词）
        const committed = out.find((e) => e.type === "conversation.committed");
        let finalState = committed?.type === "conversation.committed" ? committed.state : access.state;
        // 与 v1 /turns 同一口径：先按回合结束后的状态解锁「玩家知道了谁的名字」，再算脱敏名单。
        // 否则玩家问「你叫什么」、对方答出真名的那一回合，答复仍会被遮成外貌占位名——表现上
        // 就成了「NPC 用外貌描述称呼自己」，玩家也永远学不到名字。
        if (deps.learnNpcNames && committed) {
          try {
            const snapshot = finalState;
            const learnedIds = new Set<string>();
            const asked = askedNameTargetId(
              snapshot,
              typeof utterance?.target === "string" ? utterance.target : undefined,
              utterance?.content ?? "",
            );
            if (asked) learnedIds.add(asked);
            // 台词判定：交付里没有说话人标签，按「真名：内容」还原后复用 v1 的自报姓名规则；
            // 只统计玩家实际收到的 delivery（viewerSpeech 内含可见性过滤）。
            for (const id of introducedPresentIds(snapshot, viewerSpeech(snapshot, actorId, out))) learnedIds.add(id);
            if (learnedIds.size > 0) {
              await deps.learnNpcNames(roomId, [...learnedIds]);
              finalState = await deps.store.snapshot(roomId);
            }
          } catch (e) {
            // 已提交回合不能被旁路失败改写：解锁失败只记日志，事件照常下发（宁可多遮一句）
            console.warn(`[names] v2 回合已提交，但姓名解锁失败：${roomId}`, e);
          }
        }
        const placeholders = unknownPlaceholders(finalState, deps.appearance);
        // BLOCKER-1：host.run 的事件是全量内部视图，下发前必须按已鉴权 viewer + 会话成员投影：
        // mental 永不下发，私聊只给目标本人，committed 的私忆/私有关系/GM 字段按可见性裁剪，最后再遮真名。
        const members = host.get(sessionId)?.participants ?? [actorId];
        const visible = projectConversationEvents(out, actorId, members, deps.registry);
        for (const ev of visible) sseWrite(reply.raw, ev.type, maskNamesDeep(ev, placeholders));
      } catch (e) {
        const roomSyncFault = isRoomSyncFault(e);
        // #104：异常路径按失败回收额度（未 committed），与 v1 /turns 的 catch 同口径；重放命中不结算
        // #117：日志可能已替换（StoreCommitUnknownError）时记 unconfirmed；房间只是被冻结则按 failed 释放
        const uncertain = e instanceof StoreCommitUnknownError;
        if (charged && turnScope && ledger) ledger.transition(turnScope, uncertain ? "unconfirmed" : "failed");
        const err: ConversationEvent = {
          type: "conversation.error", sessionId, code: roomSyncFault ? "E_STORE_FAULT" : "E_MODULE_FAULT",
          message: e instanceof Error ? e.message : String(e),
          ...(roomSyncFault ? { retryable: false } : {}),
        };
        sseWrite(reply.raw, err.type, err);
      } finally {
        clearInterval(heartbeat);
        reply.raw.end();
      }
    };

    // 前端（#85）用 GET 做 feature detect：有 host 装配时返回 200，老服务端 404 → 退回 v1 /turns。
    app.get("/api/v1/rooms/:roomId/conversation", async (req, reply) => {
      const { roomId } = req.params as { roomId: string };
      if (!(await roomGate(roomId, reply))) return reply;
      // 与另外两条 conversation 路由同口径（docs/03 §5.2.11）：探测也不能让非成员确认房间存在。
      if (!(await guardRoom(req, reply, deps, roomId, userIdOf))) return reply;
      return reply.code(200).send({ ok: true, v2: true });
    });

    // 前端 demo 的说话类型选择器（方案 A）：从引擎已加载的模式表读出 id/label 与"需要目标/动作/是否纯动作"。
    // 与探测端点同口径（roomGate + guardRoom），不让非成员借它确认房间存在；纯读数据，不改任何状态。
    app.get("/api/v1/rooms/:roomId/conversation/modes", async (req, reply) => {
      const { roomId } = req.params as { roomId: string };
      if (!(await roomGate(roomId, reply))) return reply;
      if (!(await guardRoom(req, reply, deps, roomId, userIdOf))) return reply;
      const modes = [...(deps.conversation?.modes?.values() ?? [])].map((m) => ({
        id: m.id,
        label: m.label,
        requiresTarget: m.requiresTarget === true,
        requiresAction: m.requiresAction === true,
        contentless: m.contentless === true,
        targetPresence: m.targetPresence ?? "present",
      }));
      return reply.code(200).send({ ok: true, modes });
    });

    // 规范端点（docs/03 §5.2.11）：body 是 utterance 形状
    app.post("/api/v1/rooms/:roomId/conversation", async (req, reply) => {
      const { roomId } = req.params as { roomId: string };
      const parsed = ConversationBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send(schemaError(zodMessage(parsed.error)));
      return runConversationTurn(req, reply, roomId, parsed.data);
    });

    // 前端（#85）兼容别名：{actorId, input, clientTurnId, targetNpcId?} → utterance。
    // input 是玩家自然语言，归到 broadcast（有 target 则 addressed）；speaker 仍由 guardRoom 绑定后覆盖。
    app.post("/api/v1/rooms/:roomId/conversation/turns", async (req, reply) => {
      const { roomId } = req.params as { roomId: string };
      const parsed = ConversationTurnAliasSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send(schemaError(zodMessage(parsed.error)));
      const b = parsed.data;
      return runConversationTurn(req, reply, roomId, {
        actorId: b.actorId,
        clientTurnId: b.clientTurnId,
        ...(b.userId ? { userId: b.userId } : {}),
        utterance: {
          id: `utt_${b.clientTurnId}`,
          speaker: b.actorId,
          mode: b.targetNpcId ? "addressed" : "broadcast",
          ...(b.targetNpcId ? { target: b.targetNpcId } : {}),
          content: b.input,
        },
      });
    });
  }

  app.get("/api/v1/rooms/:roomId/state", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    if (!(await roomGate(roomId, reply))) return reply;
    const access = await guardRoom(req, reply, deps, roomId, userIdOf);
    if (!access) return reply;
    // 原始快照里带着实体真名：未认识的人必须在这里也脱敏，否则"服务端不下发真名"
    // 只是口号——新建房间就能从 /state 看光所有 NPC（审阅 P0-1）。
    // plot 的 GM 字段（forbidReveal/leakPoints/goal…）不能随 /state 下发（PR #147 审阅 P0）
    return maskNamesDeep(projectStateForPlayer(access.state), unknownPlaceholders(access.state, deps.appearance));
  });

  app.get("/api/v1/rooms/:roomId/events", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    if (!(await roomGate(roomId, reply))) return reply;
    const q = req.query as { fromSeq?: string; limit?: string; actorId?: string };
    const viewer = q.actorId;
    const access = await guardRoom(req, reply, deps, roomId, userIdOf, viewer ? { actorId: viewer } : {});
    if (!access) return reply;
    const from = Number(q.fromSeq ?? 0);
    const limit = clampLimit(q.limit, deps.historyLimitMax ?? 200);
    const allEvents = await deps.store.events(roomId, from, limit);
    // dev/v2：msg.sent 带 audience，玩家非收发双方连历史事件都不能读（十审 P1）
    const events = allEvents.filter((e) => {
      if (e.type !== "msg.sent") return true;
      if (!viewer || !Array.isArray(e.audience)) return false;
      return e.audience.includes(viewer);
    });
    // 历史回放同样脱敏：旧回合的叙事里可能带着尚未认识的人的真名
    const snapshot = await deps.store.snapshot(roomId);
    const placeholders = unknownPlaceholders(snapshot, deps.appearance);
    // 秘密裁剪（PR #147 审阅 P0）：plot 事件剥 GM 字段，私忆只留 public 与玩家本人；
    // viewer 取服务端解析的玩家身份，不信任 query 里的 actorId。
    const visible = projectEventsForPlayer(events, playerOf(snapshot, access.userId));
    // 分页游标用原始事件末 seq：被过滤的私忆/租约事件也占 seq，不能让客户端卡在同一段。
    return { events: maskNamesDeep(visible, placeholders), lastSeq: allEvents.length ? allEvents[allEvents.length - 1]!.seq : from };
  });

  /** 一次行动 = 一条 SSE 流，事件名就是 TurnEvent.type */
  app.post("/api/v1/rooms/:roomId/turns", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    if (!(await roomGate(roomId, reply))) return reply;
    const body = (req.body ?? {}) as {
      actorId?: string;
      input?: string;
      clientTurnId?: string;
      userId?: string;
      /** 这次行动在跟哪个 NPC 说话（前端点 NPC 时给）：用于提示词换真名 + 问名字后解锁谁 */
      targetNpcId?: string;
      options?: Record<string, unknown>;
    };
    if (!body.actorId || !body.input || !body.clientTurnId) {
      return reply.code(400).send({ code: "E_SCHEMA_INVALID", message: "actorId/input/clientTurnId 必填" });
    }
    // 授权在 SSE 头之前：拒绝必须是普通 HTTP 响应，不能先宣布 200 流再反悔
    const access = await guardRoom(req, reply, deps, roomId, userIdOf, { actorId: body.actorId, body });
    if (!access) return reply;
    const userId = access.userId;
    // 幂等作用域：账号 + 房间 + 逻辑请求 ID（P1-1）。未登录（本地无 auth）不结算额度。
    const turnScope = userId ? { userId, roomId, clientTurnId: body.clientTurnId } : undefined;

    // 额度结算（收敛稿 B1，docs/03 §5.2.10）：按逻辑请求预留，拒绝也在 SSE 头之前
    const ledger = userId ? deps.ledger : undefined;
    if (ledger && userId && turnScope) {
      const settings = deps.auth?.store.getSettings();
      const dailyLimit = settings ? dailyLimitFor(settings, userId) : null;
      const reserved = ledger.reserve({
        ...turnScope, actorId: body.actorId,
        dailyLimit, actionsEnabled: settings?.actionsEnabled ?? true,
      });
      if (!reserved.ok) {
        const status = reserved.code === "E_RATE_LIMITED" ? 429 : 409;
        return reply.code(status).send({ ok: false, code: reserved.code, message: reserved.message, ...(reserved.committedSeq !== undefined ? { committedSeq: reserved.committedSeq } : {}) });
      }
      // running 必须先确认落盘再开跑：写失败时磁盘只有 reserved，重启会误判「未开跑」并放行重试
      try {
        await ledger.transitionDurable(turnScope, "running");
      } catch {
        ledger.transition(turnScope, "failed");
        return reply.code(503).send({ ok: false, code: "E_STORE_FAULT", message: "额度账本写入失败，行动未开始，可重试" });
      }
    }

    // 先拿锁再写 SSE 头：等锁失败必须还能回普通 409，不能先宣布 200 流再反悔。
    let leaveTurn: (() => void) | undefined;
    const acquireAbort = new AbortController();
    const onClientClose = () => acquireAbort.abort();
    req.raw.once("close", onClientClose);
    try {
      leaveTurn = deps.roomActivity ? await deps.roomActivity.acquire(roomId, 30_000, acquireAbort.signal) : undefined;
    } catch (e) {
      req.raw.off("close", onClientClose);
      if (ledger && userId && turnScope) ledger.transition(turnScope, "failed");
      if (e instanceof RoomBusyError) {
        return reply.code(409).send({ ok: false, code: "E_TURN_BUSY", message: e.message });
      }
      throw e;
    }
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let committed = false;
    let errored = false;
    try {
      // 玩家点的是某个 NPC：前端会把「对<展示名>说：…」写进行动语义。未认识时展示名是
      // 外貌占位名（appearance）或「第N位陌生的同学」，这里换回真名只影响喂给模型的 input，
      // 不影响下发给玩家的显示；否则模型看到一段外貌描述，根本不知道在跟谁说话。
      const snapshotForInput = await deps.store.snapshot(roomId);
      const target = body.targetNpcId ? snapshotForInput.entities[body.targetNpcId] : undefined;
      // 只有"目标此刻就在玩家所在场景"才允许实名化：不在场的人不能借这次行动被解锁/点名（P1-4）
      const targetPresent = target !== undefined && snapshotForInput.room.scene.presentIds.includes(target.id);
      // 占位名用与 /state 出站同一套算法（外貌优先、缺省序号），只替换目标那一个，
      // 不会把玩家顺带提到的其他陌生人也实名化。
      const targetPlaceholder =
        target && target.kind === "npc" && targetPresent
          ? unknownPlaceholders(snapshotForInput, deps.appearance).get(target.name)
          : undefined;
      const promptInput =
        target && target.kind === "npc" && targetPresent
          ? unmaskTargetPlaceholder(body.input, targetPlaceholder, target.name)
          : body.input;
      // D22：v1 回退路径同样在对话回合内冻结目标 NPC 的动作租约。
      const talkNpcId = target && target.kind === "npc" && targetPresent ? target.id : undefined;
      let suspendedTalkNpcId: string | undefined;
      if (talkNpcId && typeof deps.map.suspendNpcAction === "function") {
        if (await deps.map.suspendNpcAction(roomId, talkNpcId)) suspendedTalkNpcId = talkNpcId;
      }
      const it = deps.turn.run({
        roomId,
        actorId: body.actorId,
        input: promptInput,
        clientTurnId: body.clientTurnId,
        options: body.options as never,
        ...(userId ? { userId } : {}),
      });
      // 叙事/台词里模型会写出 NPC 真名（"严守一：嗯？…"）。不认识的人要遮成占位名，但
      // **必须按本回合结束后的状态判断**：玩家这一回合问「你叫什么」，NPC 回答"我叫林静"，
      // 此时已经认识——遮住反而会出现"陌生人自我介绍"这种荒谬结果。
      // 所以先收齐事件，再用最终 patch 的 state 算一次名单，然后统一写出。
      const events: TurnEvent[] = [];
      try {
        for await (const ev of it as AsyncIterable<TurnEvent>) {
          events.push(ev);
          if (ev.type === "turn.commit" || ev.type === "turn.error" || ev.type === "turn.rejected") break;
        }
      } finally {
        if (suspendedTalkNpcId && typeof deps.map.resumeNpcAction === "function") {
          if (await deps.map.resumeNpcAction(roomId, suspendedTalkNpcId)) {
            // turn.patch.state 是回合中途快照（含 talk 租约）；恢复后用最新状态替换。
            // 替换成新事件对象，避免改到调用方缓存的事件对象。
            const snapshot = structuredClone(await deps.store.snapshot(roomId));
            const idx = events.findIndex((ev) => ev.type === "turn.patch");
            const patch = idx >= 0 ? events[idx] : undefined;
            if (patch && patch.type === "turn.patch") {
              events[idx] = { ...patch, state: snapshot };
            }
          } else {
            console.warn(`[turns] NPC ${suspendedTalkNpcId} 动作租约恢复失败`);
          }
        }
      }
      // 额度结算与事件流同源：只有真的提交了才记 committed，其余按失败/待核对处理
      committed = events.some((ev) => ev.type === "turn.commit");
      errored = events.some((ev) => ev.type === "turn.error" || ev.type === "turn.rejected");
      if (turnScope) {
        if (committed) {
          const commitEv = events.find((ev) => ev.type === "turn.commit") as Extract<TurnEvent, { type: "turn.commit" }>;
          ledger?.transition(turnScope, "committed", { turnId: commitEv.turnId, committedSeq: commitEv.seq });
        } else if (errored) {
          ledger?.transition(turnScope, "failed");
        } else {
          // 提前 EOF（无 commit 也无 error）：结果待核对，不自动释放额度
          ledger?.transition(turnScope, "unconfirmed");
        }
      }
      let finalState: WorldState | undefined;
      for (const ev of events) {
        const state = (ev as { state?: WorldState }).state;
        if (ev.type === "turn.patch" && state) finalState = state;
      }
      // 「玩家知道了谁的名字」两条来源**并行**（review #63-1：不是二选一）：
      //   ① 这次行动有明确对话对象（targetNpcId）且玩家在问名字 → 解锁该 NPC；
      //   ② 台词判定：说话人台词里真的报出姓名 / 本人自述姓氏 → 也解锁。
      //      ② 不因存在 targetNpcId 而跳过——对方主动报名字的场景同样要解锁。
      //
      // 硬约束（审阅 P1-3/P1-4）：
      // - 只有回合真的提交（turn.commit）才解锁——失败回合不落状态；
      // - 目标必须此刻在玩家所在场景（presentIds）里——不在场的人解锁不了。
      if (deps.learnNpcNames && committed) {
        // 已提交回合不能再被旁路失败改写：姓名解锁失败只记日志，账本保持 committed、事件照常下发
        try {
          const snapshot = finalState ?? (await deps.store.snapshot(roomId));
          const learnedIds = new Set<string>();
          const asked = askedNameTargetId(snapshot, body.targetNpcId, body.input);
          if (asked) learnedIds.add(asked);
          const speech = events
            .flatMap((ev) => {
              const d = ev as { type?: string; field?: string; text?: string; facts?: string[] };
              if (d.type === "turn.delta" && typeof d.text === "string") return [d.text];
              if (d.type === "turn.facts" && Array.isArray(d.facts)) return d.facts;
              return [];
            })
            .join("\n");
          for (const id of introducedPresentIds(snapshot, speech)) learnedIds.add(id);
          if (learnedIds.size > 0) {
            await deps.learnNpcNames(roomId, [...learnedIds]);
            finalState = await deps.store.snapshot(roomId);
          }
        } catch (e) {
          console.warn(`[names] 回合已提交，但姓名解锁失败：${roomId}`, e);
        }
      }
      // 响应生成与提交状态解耦：脱敏快照失败时用回合开始前的快照兜底，
      // 宁可把刚解锁的人继续遮住，也不能漏真名或把已提交回合报成可重试失败。
      let placeholders: Map<string, string>;
      try {
        placeholders = unknownPlaceholders(finalState ?? (await deps.store.snapshot(roomId)), deps.appearance);
      } catch (e) {
        console.warn(`[names] 回合已提交，但脱敏快照失败，改用回合开始前快照：${roomId}`, e);
        placeholders = unknownPlaceholders(snapshotForInput, deps.appearance);
      }
      // turn.patch.state 也带 plots，必须和 /state 同口径剥秘密（PR #147 审阅 P0）
      for (const ev of events) sseWrite(reply.raw, ev.type, maskNamesDeep(projectTurnEventForPlayer(ev), placeholders));
    } catch (e) {
      errored = true;
      // 收到 turn.commit 后才会走到这里的旁路异常：账本保持 committed，也不给客户端可重试信号
      const roomSyncFault = isRoomSyncFault(e);
      if (!committed && turnScope) {
        ledger?.transition(turnScope, e instanceof StoreCommitUnknownError ? "unconfirmed" : "failed");
      }
      sseWrite(reply.raw, "turn.error", {
        type: "turn.error",
        code: roomSyncFault ? "E_STORE_FAULT" : "E_UPSTREAM",
        message: roomSyncFault ? e.message : String(e),
        retryable: !committed && !roomSyncFault,
      });
    } finally {
      leaveTurn?.();
      req.raw.off("close", onClientClose);
      reply.raw.end();
    }
    return reply;
  });

/** 行动核对（docs/03 §5.2.10）：重试前确认逻辑请求结果，避免重复扣费/行动 */
  app.get("/api/v1/rooms/:roomId/turns/:clientTurnId", async (req, reply) => {
    const { roomId, clientTurnId } = req.params as { roomId: string; clientTurnId: string };
    if (!(await roomGate(roomId, reply))) return reply;
    const access = await guardRoom(req, reply, deps, roomId, userIdOf);
    if (!access) return reply;
    const userId = access.userId;
    const scope = userId ? { userId, roomId, clientTurnId } : undefined;
    const entry = scope ? deps.ledger?.get(scope) : undefined;
    if (!entry) {
      return reply.code(404).send({ ok: false, code: "E_REF_NOT_FOUND", message: "没有该行动记录" });
    }
    const needsReconciliation = entry.state === "unconfirmed" || entry.state === "running" || entry.state === "reserved";
    const needsHistoryIdentity = entry.state === "committed" && !entry.turnId;
    let recoveredTurn: { turnId: string; committedSeq: number } | undefined;
    // 历史按账号、角色和逻辑 ID 匹配。人工结案已提交但缺 turnId 时，仅补充查询响应。
    if (scope && (needsReconciliation || needsHistoryIdentity)) {
      // 先查 EventLog 的 turn.committed 标记（issue #76）：它与状态事件同批落盘，
      // 即使进程在历史写入前被杀也能证明提交，避免 unconfirmed 永久卡住。
      const evidence = deps.store ? await findCommitEvidence(deps.store, roomId, clientTurnId, entry.actorId) : undefined;
      if (evidence) {
        // 房间日志已提交但历史/续玩索引在崩溃时没写：用标记里的内容补历史行。
        const exists = deps.history
          ? (await deps.history.readAll(roomId)).some(
              (l) => l.turnId === evidence.turnId && l.actorId === evidence.actorId,
            )
          : true;
        if (!exists && deps.history) {
          const line = {
            formatVersion: 1 as const, roomId,
            turnId: evidence.turnId, committedSeq: evidence.committedSeq,
            actorId: evidence.actorId,
            ...(userId ? { userId } : {}),
            clientTurnId: evidence.clientTurnId,
            input: "", narrative: evidence.narrative ?? "",
            speakers: [], facts: evidence.facts ?? [], createdAt: Date.now(),
          };
          await deps.history.append(line);
        }
        recoveredTurn = { turnId: evidence.turnId, committedSeq: evidence.committedSeq };
        if (needsReconciliation && scope && deps.ledger) {
          const reconciled = await deps.ledger.reconcileCommitted(scope, recoveredTurn);
          // 账本写失败不能伪装成"结果待核对"：玩家/运维需要区分存储故障与真的未决
          if (!reconciled.ok && reconciled.code === "E_STORE_FAULT") {
            return reply.code(503).send({ ok: false, code: "E_STORE_FAULT", message: reconciled.message });
          }
        }
      } else if (deps.history) {
        const line = (await deps.history.readAll(roomId)).find(
          (l) => l.clientTurnId === clientTurnId && l.userId === userId && l.actorId === entry.actorId,
        );
        if (line && needsHistoryIdentity) {
          recoveredTurn = { turnId: line.turnId, committedSeq: line.committedSeq };
        } else if (line) {
          const reconciled = await deps.ledger?.reconcileCommitted(scope, { turnId: line.turnId, committedSeq: line.committedSeq });
          if (reconciled && !reconciled.ok && reconciled.code === "E_STORE_FAULT") {
            return reply.code(503).send({ ok: false, code: "E_STORE_FAULT", message: reconciled.message });
          }
        }
      }
    }
    const current = (scope ? deps.ledger?.get(scope) : undefined) ?? entry;
    const turnId = current.turnId ?? recoveredTurn?.turnId;
    const committedSeq = current.committedSeq ?? recoveredTurn?.committedSeq;
    return { ok: true, state: current.state, ...(turnId ? { turnId } : {}), ...(committedSeq !== undefined ? { committedSeq } : {}) };
  });

  // ---------------------------------------------------------------- 世界层永久记忆（docs/08 §9.3，管理员）
  app.post("/api/v1/admin/canonize/run", async (req, reply) => {
    if (!deps.canonize) return reply.code(404).send({ ok: false, code: "E_FORBIDDEN", message: "canonize 未启用" });
    const verdict = adminVerdict(req);
    if (verdict.blocked) return tooManyAdminAttempts(reply, verdict.retryAfterMs);
    if (!verdict.ok) return reply.code(403).send({ ok: false, code: "E_FORBIDDEN", message: "需要管理员令牌" });
    const body = (req.body ?? {}) as { roomId?: string };
    if (!body.roomId) return reply.code(400).send({ ok: false, code: "E_SCHEMA_INVALID", message: "roomId 必填" });
    const report = await safe(reply, () => deps.canonize!.retireRoom(body.roomId!));
    return { ok: true, report };
  });

  app.post("/api/v1/admin/canonize/tombstone", async (req, reply) => {
    if (!deps.canonize) return reply.code(404).send({ ok: false, code: "E_FORBIDDEN", message: "canonize 未启用" });
    const verdict = adminVerdict(req);
    if (verdict.blocked) return tooManyAdminAttempts(reply, verdict.retryAfterMs);
    if (!verdict.ok) return reply.code(403).send({ ok: false, code: "E_FORBIDDEN", message: "需要管理员令牌" });
    const body = (req.body ?? {}) as { memoryId?: string; reason?: string };
    if (!body.memoryId) return reply.code(400).send({ ok: false, code: "E_SCHEMA_INVALID", message: "memoryId 必填" });
    const port = deps.canonize;
    const outcome = port.tombstoneWithReason
      ? await port.tombstoneWithReason(body.memoryId, body.reason ?? "管理员撤回")
      : { ok: await port.tombstone(body.memoryId, body.reason ?? "管理员撤回") };
    if (outcome.ok) return { ok: true };
    // 并发冲突 ≠ 不可变：世界层正被别的任务写入时，同一个请求重试就能成功（PR #149 P2-4）
    if (outcome.code === "E_SEQ_GAP") {
      return reply.code(503).send({ ok: false, code: "E_SEQ_GAP", message: "世界记忆正在被其他任务写入，请稍后重试", retryable: true });
    }
    // 撤回失败的真实原因从世界层记忆状态推：不存在 = 404 语义，已撤回 = 不可变
    // 存在性用记忆索引判（sample(200) 在世界层 >200 条时会误判 404，审阅 P2-⑤）
    const hit = deps.memory.get?.(body.memoryId);
    if (!hit) return reply.code(404).send({ ok: false, code: "E_REF_NOT_FOUND", message: `世界记忆 ${body.memoryId} 不存在` });
    return reply.code(409).send({ ok: false, code: "E_MEMORY_IMMUTABLE", message: `世界记忆 ${body.memoryId} 已撤回或不可变` });
  });

  /** 观测（P4）：只读指标 + 人工抽样复审用的永久记忆清单 */
  app.get("/api/v1/admin/stats", async (req, reply) => {
    const verdict = adminVerdict(req);
    if (verdict.blocked) return tooManyAdminAttempts(reply, verdict.retryAfterMs);
    if (!verdict.ok) return reply.code(403).send({ ok: false, code: "E_FORBIDDEN", message: "需要管理员令牌" });
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
    // fail-closed 要能被运维看见（审阅 P2-⑥）：没配 judge 时 canonize 仍启用但永远写不出世界层
    return { ok: true, canonize, canonizeEnabled: deps.canonize !== undefined, canonizeJudge: deps.canonizeJudge ?? "none", rooms: perRoom, sample };
  });

  // ---------------------------------------------------------------- 地图（docs/06 §4）
  app.get("/api/v1/rooms/:roomId/map", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    if (!(await roomGate(roomId, reply))) return reply;
    const access = await guardRoom(req, reply, deps, roomId, userIdOf);
    if (!access) return reply;
    const q = req.query as { actorId?: string };
    return safe(reply, () => deps.map.getMap(roomId, q.actorId));
  });

  app.post("/api/v1/rooms/:roomId/map/travel", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    if (!(await roomGate(roomId, reply))) return reply;
    const parsed = TravelBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return schemaError(zodMessage(parsed.error));
    const access = await guardRoom(req, reply, deps, roomId, userIdOf, { actorId: parsed.data.actorId });
    if (!access) return reply;
    if (actionsPaused(reply)) return reply;
    // 玩家回合/对话回合执行期间不接受地图写操作，避免与 Turn/Dialogue 抢同一份状态。
    if (deps.roomActivity?.isBusy(roomId)) {
      return reply.code(409).send({ ok: false, code: "E_TURN_BUSY", message: "房间正在处理玩家回合，稍后再试" });
    }
    return safe(reply, () => deps.map.travel(roomId, parsed.data.actorId, parsed.data.locId));
  });

  app.post("/api/v1/rooms/:roomId/map/tick", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    if (!(await roomGate(roomId, reply))) return reply;
    const parsed = TickBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return schemaError(zodMessage(parsed.error));
    const access = await guardRoom(req, reply, deps, roomId, userIdOf);
    if (!access) return reply;
    if (actionsPaused(reply)) return reply;
    if (deps.roomActivity?.isBusy(roomId)) {
      return reply.code(409).send({ ok: false, code: "E_TURN_BUSY", message: "房间正在处理玩家回合，稍后再推进时间" });
    }
    // viewer：出站事件按调用者自己的视角裁私忆（PR #149 P3）；未登录时由 MapService 回退到玩家角色
    const viewer = access.userId ? playerOf(access.state, access.userId) : undefined;
    return safe(reply, () => deps.map.tick(roomId, { ...parsed.data, ...(viewer ? { viewer } : {}) }));
  });

  app.post("/api/v1/rooms/:roomId/map/dialogue", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    if (!(await roomGate(roomId, reply))) return reply;
    const parsed = DialogueBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return schemaError(zodMessage(parsed.error));
    const access = await guardRoom(req, reply, deps, roomId, userIdOf, { actorId: parsed.data.actorId });
    if (!access) return reply;
    if (actionsPaused(reply)) return reply;
    return safe(reply, () =>
      deps.map.openDialogue(roomId, parsed.data.actorId, parsed.data.sceneId, parsed.data.dialogueId),
    );
  });

  app.post("/api/v1/map/drafts", (req, reply) => {
    const deny = adminOnly(req, "地图草案暂仅管理员可用");
    if (deny) return deny;
    return safe(reply, () => deps.map.createDraft(req.body));
  });

  // #105：所有草案端点统一走 AdminTokenGate（sha256+timingSafeEqual+10次/60s 限流），
  // 不再直接用原始令牌绕过 tokenEquals/限流。adminOnly 内部即 adminVerdict(req)，
  // 与登录门/CSRF/room-guard/admin.routes 共用同一请求级判定缓存。
  app.get("/api/v1/map/drafts", (req, reply) => {
    const deny = adminOnly(req, "地图草案暂仅管理员可用");
    if (deny) return reply.code(deny.code === "E_RATE_LIMITED" ? 429 : 200).send(deny);
    return safe(reply, () => deps.map.listDrafts(adminToken(req)));
  });

  app.get("/api/v1/map/drafts/:id", (req, reply) => {
    const deny = adminOnly(req, "地图草案暂仅管理员可用");
    if (deny) return reply.code(deny.code === "E_RATE_LIMITED" ? 429 : 200).send(deny);
    const { id } = req.params as { id: string };
    return safe(reply, () => deps.map.getDraft(id));
  });

  app.post("/api/v1/admin/map/drafts/:id/review", (req, reply) => {
    const deny = adminOnly(req, "地图草案暂仅管理员可用");
    if (deny) return reply.code(deny.code === "E_RATE_LIMITED" ? 429 : 200).send(deny);
    const { id } = req.params as { id: string };
    return safe(reply, () => deps.map.reviewDraft(id, adminToken(req), req.body));
  });

  app.post("/api/v1/admin/map/drafts/:id/publish", (req, reply) => {
    const deny = adminOnly(req, "地图草案暂仅管理员可用");
    if (deny) return reply.code(deny.code === "E_RATE_LIMITED" ? 429 : 200).send(deny);
    const { id } = req.params as { id: string };
    return safe(reply, () => deps.map.publishDraft(id, adminToken(req), req.body));
  });

  app.post("/api/v1/admin/map/drafts/:id/generate", (req, reply) => {
    const deny = adminOnly(req, "地图草案暂仅管理员可用");
    if (deny) return reply.code(deny.code === "E_RATE_LIMITED" ? 429 : 200).send(deny);
    const { id } = req.params as { id: string };
    return safe(reply, () => deps.map.retryGenerate(id, adminToken(req)));
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
authorize: async (req, reply, roomId) => (await guardRoom(req, reply, deps, roomId, userIdOf)) !== null,
    appearance: deps.appearance,
  });

  // ---------------------------------------------------------------- 调试面板（只读）
  // 只在配置了 GALGAME_DEBUG_PASSPHRASE 时注册；口令从未进过仓库，解锁后拿 TTL 令牌。
  if (deps.debugGate) {
    registerDebugRoutes(app, {
      gate: deps.debugGate,
      store: deps.store,
      memory: deps.memory,
      roomExists,
    });
  }
}
