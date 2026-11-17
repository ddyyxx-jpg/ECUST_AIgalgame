/**
 * HTTP/SSE 层：只做两件事——把请求变成 service/turn 调用、把结果原样返回。
 * 不含业务规则；游戏层拒绝一律 HTTP 200 + {ok:false,code,message}，500 只表示未预期异常。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Memory, Store, Turn, TurnEvent } from "../../../packages/shared/src/contract/types.ts";
import { DialogueBodySchema, TickBodySchema, TravelBodySchema, zodMessage } from "./map.data.ts";
import type { MapService } from "./map.ts";
import type { LlmSettings } from "./settings.ts";

export interface AppDeps {
  store: Store;
  turn: Turn;
  map: MapService;
  /** 运行时模型接入（玩家自备 key）：/api/v1/settings/llm */
  settings: LlmSettings;
  /** 读取账号维度的私忆档案（GET /api/v1/me）；记忆是日志投影，这里只读 */
  memory: Memory;
  createRoom(mode: "solo" | "coop", userId?: string): Promise<{ roomId: string; actorId: string }>;
  /** 开发期账号：没有登录态时用 GALGAME_DEV_USER 兜底（上线接登录中间件后删掉） */
  devUser?: string;
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
function userIdOf(req: FastifyRequest, deps: AppDeps, body?: { userId?: string }): string | undefined {
  const raw = req.headers["x-user-id"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const fromBody = body?.userId;
  const id = (header ?? fromBody ?? deps.devUser ?? "").trim();
  return id === "" ? undefined : id.slice(0, 64);
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
  app.get("/api/v1/health", async () => ({ ok: true, contract: deps.version }));

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
    const body = (req.body ?? {}) as { mode?: "solo" | "coop"; userId?: string };
    const userId = userIdOf(req, deps, body);
    const room = await deps.createRoom(body.mode === "coop" ? "coop" : "solo", userId);
    return { ...room, ...(userId ? { userId } : {}) };
  });

  /** 玩家档案（记忆的派生视图，不写状态）：私忆只按 userId+ownerId 过滤后返回 */
  app.get("/api/v1/me", async (req, reply) => {
    const q = req.query as { roomId?: string; actorId?: string };
    const userId = userIdOf(req, deps);
    if (!q.roomId || !q.actorId) return reply.code(400).send({ code: "E_SCHEMA_INVALID", message: "roomId/actorId 必填" });
    if (!userId) return reply.code(400).send({ code: "E_SCHEMA_INVALID", message: "缺少 X-User-Id（或 GALGAME_DEV_USER）" });
    const profile = await deps.memory.profile(userId, q.actorId, q.roomId);
    return { ok: true, userId, profile };
  });

  app.get("/api/v1/rooms/:roomId/state", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    try {
      return await deps.store.snapshot(roomId);
    } catch {
      return reply.code(404).send({ error: "E_ROOM_NOT_FOUND" });
    }
  });

  app.get("/api/v1/rooms/:roomId/events", async (req) => {
    const { roomId } = req.params as { roomId: string };
    const q = req.query as { fromSeq?: string; limit?: string };
    const from = Number(q.fromSeq ?? 0);
    const limit = Math.min(Number(q.limit ?? 200), 200);
    const events = await deps.store.events(roomId, from, limit);
    return { events, lastSeq: events.length ? events[events.length - 1]!.seq : from };
  });

  /** 一次行动 = 一条 SSE 流，事件名就是 TurnEvent.type */
  app.post("/api/v1/rooms/:roomId/turns", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
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

  // ---------------------------------------------------------------- 地图（docs/06 §4）
  app.get("/api/v1/rooms/:roomId/map", (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    const q = req.query as { actorId?: string };
    return safe(reply, () => deps.map.getMap(roomId, q.actorId ?? "plr_self"));
  });

  app.post("/api/v1/rooms/:roomId/map/travel", (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    const parsed = TravelBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return schemaError(zodMessage(parsed.error));
    return safe(reply, () => deps.map.travel(roomId, parsed.data.actorId ?? "plr_self", parsed.data.locId));
  });

  app.post("/api/v1/rooms/:roomId/map/tick", (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    const parsed = TickBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return schemaError(zodMessage(parsed.error));
    return safe(reply, () => deps.map.tick(roomId, parsed.data));
  });

  app.post("/api/v1/rooms/:roomId/map/dialogue", (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    const parsed = DialogueBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return schemaError(zodMessage(parsed.error));
    return safe(reply, () =>
      deps.map.openDialogue(roomId, parsed.data.actorId ?? "plr_self", parsed.data.sceneId, parsed.data.dialogueId),
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
}
