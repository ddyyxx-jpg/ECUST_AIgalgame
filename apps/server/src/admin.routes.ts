/**
 * 管理端点（收敛稿 B1，docs/03 §5.2.9）：有效 x-admin-token（运维兼容）或 role=admin 会话。
 * 首版以端点 + 脚本交付（B1），完整管理页面（B2）后置。所有写操作记入操作日志（不记密码/token）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthService } from "./auth.ts";
import { dailyLimitFor } from "./auth-store.ts";
import type { TurnLedger } from "./quota.ts";
import type { AdminLog } from "./admin-log.ts";
import type { AdminTokenGate, TokenVerdict } from "./admin-token.ts";
import { adminTokenOf } from "./room-guard.ts";

export interface AdminDeps {
  auth: AuthService;
  ledger: TurnLedger;
  log: AdminLog;
  adminToken: string;
  /** 与主路由共用同一实例：令牌失败计数要在所有管理入口间累计，否则限制形同虚设 */
  gate?: AdminTokenGate;
  /** 与主路由共用请求级缓存：同一请求的登录门/CSRF/管理路由只计一次失败 */
  verdictOf?: (req: FastifyRequest) => TokenVerdict;
}

const StateBody = z.object({ state: z.enum(["active", "suspended", "archived"]), reason: z.string().default("") });
const RoleBody = z.object({ role: z.enum(["player", "admin"]), reason: z.string().default("") });
const ReasonBody = z.object({ reason: z.string().default("") });
const InviteBody = z.object({ note: z.string().optional(), maxUses: z.number().int().positive().optional(), ttlHours: z.number().positive().optional() });
const SettingsBody = z.object({
  registrationOpen: z.boolean().optional(),
  actionsEnabled: z.boolean().optional(),
  defaultDailyTurns: z.number().int().nonnegative().nullable().optional(),
  perUserDailyTurns: z.record(z.string(), z.number().int().nonnegative().nullable()).optional(),
});
const ResolveBody = z.object({
  resolution: z.enum(["committed", "failed"]),
  reason: z.string().default(""),
  committedSeq: z.number().optional(),
  // 同一 clientTurnId 可能出现在不同账号/房间（P1-1 作用域键）：带上二者可精确定位
  userId: z.string().optional(),
  roomId: z.string().optional(),
});

function operatorOf(req: FastifyRequest, deps: AdminDeps): { operator: string | null; verdict?: TokenVerdict } {
  const user = deps.auth.resolve(req);
  const fromSession = user?.role === "admin" ? user.userId : null;
  const token = adminTokenOf(req.headers);
  if (!token) return { operator: fromSession };
  const verdict = deps.verdictOf
    ? deps.verdictOf(req)
    : deps.gate
      ? deps.gate.check(token, req.ip)
      : { ok: !!deps.adminToken && token === deps.adminToken };
  if (verdict.ok) return { operator: "token" };
  // 令牌失败仍可退回管理员会话；但被限流时一律 429（fail closed），不给猜令牌留窗口
  return { operator: fromSession, verdict };
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const guard = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const { operator, verdict } = operatorOf(req, deps);
    if (verdict?.blocked) {
      if (verdict.retryAfterMs) reply.header("retry-after", Math.max(1, Math.ceil(verdict.retryAfterMs / 1000)));
      reply.code(429).send({ ok: false, code: "E_RATE_LIMITED", message: "管理员鉴权失败次数过多，请稍后再试" });
      return null;
    }
    if (operator) return operator;
    reply.code(deps.auth.resolve(req) ? 403 : 401).send({ ok: false, code: deps.auth.resolve(req) ? "E_FORBIDDEN" : "E_UNAUTHORIZED", message: "需要管理员权限" });
    return null;
  };
  const notFound = (reply: FastifyReply) => reply.code(404).send({ ok: false, code: "E_REF_NOT_FOUND", message: "目标不存在" });
  const publicUser = (u: { userId: string; username: string; role: string; state: string; nickname?: string; createdAt: number }) => ({
    userId: u.userId, username: u.username, role: u.role, state: u.state, createdAt: u.createdAt, ...(u.nickname ? { nickname: u.nickname } : {}),
  });

  app.get("/api/v1/admin/users", async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const q = (req.query as { q?: string }).q;
    const settings = deps.auth.store.getSettings();
    const users = deps.auth.store.listUsers(q).map((u) => ({
      ...publicUser(u),
      usage: { todayTurns: deps.ledger.todayTurns(u.userId), dailyLimit: dailyLimitFor(settings, u.userId) },
    }));
    return { ok: true, users };
  });

  app.post("/api/v1/admin/users/:userId/state", async (req, reply) => {
    const operator = guard(req, reply);
    if (!operator) return reply;
    const parsed = StateBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "E_SCHEMA_INVALID", message: "state 需为 active/suspended/archived" });
    const { userId } = req.params as { userId: string };
    const user = await deps.auth.store.setUserState(userId, parsed.data.state);
    if (!user) return notFound(reply);
    if (parsed.data.state !== "active") deps.auth.sessions.revokeUser(userId);
    deps.log.record({ operator, target: userId, action: "user.state", reason: parsed.data.reason, result: parsed.data.state });
    return { ok: true, user: publicUser(user) };
  });

  app.post("/api/v1/admin/users/:userId/role", async (req, reply) => {
    const operator = guard(req, reply);
    if (!operator) return reply;
    const parsed = RoleBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "E_SCHEMA_INVALID", message: "role 需为 player/admin" });
    const { userId } = req.params as { userId: string };
    const user = await deps.auth.store.setUserRole(userId, parsed.data.role);
    if (!user) return notFound(reply);
    deps.log.record({ operator, target: userId, action: "user.role", reason: parsed.data.reason, result: parsed.data.role });
    return { ok: true, user: publicUser(user) };
  });

  app.post("/api/v1/admin/users/:userId/reset-credential", async (req, reply) => {
    const operator = guard(req, reply);
    if (!operator) return reply;
    const parsed = ReasonBody.safeParse(req.body ?? {});
    const { userId } = req.params as { userId: string };
    const issued = await deps.auth.store.issueReset(userId, deps.auth.opts.resetTtlMs, operator);
    if (!issued) return notFound(reply);
    deps.log.record({ operator, target: userId, action: "user.reset-credential", reason: parsed.data?.reason ?? "", result: "issued" });
    return { ok: true, credential: issued.credential, expiresAt: issued.expiresAt };
  });

  app.post("/api/v1/admin/users/:userId/revoke-sessions", async (req, reply) => {
    const operator = guard(req, reply);
    if (!operator) return reply;
    const parsed = ReasonBody.safeParse(req.body ?? {});
    const { userId } = req.params as { userId: string };
    if (!deps.auth.store.getUser(userId)) return notFound(reply);
    const revoked = deps.auth.sessions.revokeUser(userId);
    deps.log.record({ operator, target: userId, action: "user.revoke-sessions", reason: parsed.data?.reason ?? "", result: String(revoked) });
    return { ok: true, revoked };
  });

  app.get("/api/v1/admin/invites", async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const invites = deps.auth.store.listInvites().map(({ codeHash: _codeHash, ...rest }) => rest);
    return { ok: true, invites };
  });

  app.post("/api/v1/admin/invites", async (req, reply) => {
    const operator = guard(req, reply);
    if (!operator) return reply;
    const parsed = InviteBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "E_SCHEMA_INVALID", message: "邀请参数不正确" });
    const { invite, code } = await deps.auth.store.createInvite(parsed.data, operator);
    deps.log.record({ operator, target: invite.id, action: "invite.create", reason: parsed.data.note ?? "", result: `maxUses=${invite.maxUses}` });
    const { codeHash: _codeHash, ...rest } = invite;
    return { ok: true, invite: rest, code };
  });

  app.post("/api/v1/admin/invites/:id/revoke", async (req, reply) => {
    const operator = guard(req, reply);
    if (!operator) return reply;
    const parsed = ReasonBody.safeParse(req.body ?? {});
    const { id } = req.params as { id: string };
    const revoked = await deps.auth.store.revokeInvite(id);
    if (!revoked) return notFound(reply);
    deps.log.record({ operator, target: id, action: "invite.revoke", reason: parsed.data?.reason ?? "", result: "revoked" });
    return { ok: true };
  });

  app.get("/api/v1/admin/settings", async (req, reply) => {
    if (!guard(req, reply)) return reply;
    return { ok: true, settings: deps.auth.store.getSettings() };
  });

  app.put("/api/v1/admin/settings", async (req, reply) => {
    const operator = guard(req, reply);
    if (!operator) return reply;
    const parsed = SettingsBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "E_SCHEMA_INVALID", message: "设置参数不正确" });
    const settings = await deps.auth.store.updateSettings(parsed.data);
    deps.log.record({ operator, target: "settings", action: "settings.update", reason: "", result: JSON.stringify(parsed.data) });
    return { ok: true, settings };
  });

  app.get("/api/v1/admin/actions", async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const limit = Number((req.query as { limit?: string }).limit ?? 50);
    return { ok: true, actions: await deps.log.list(limit) };
  });

  app.get("/api/v1/admin/quota", async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const q = req.query as { userId?: string; state?: string };
    const state = q.state as import("./quota.ts").LedgerState | undefined;
    // skippedLines > 0：上次崩溃留下不可解析行，幂等/对账可能缺记录，需人工确认
    return { ok: true, entries: deps.ledger.list({ userId: q.userId, state }), skippedLines: deps.ledger.skippedLines };
  });

  app.post("/api/v1/admin/quota/:clientTurnId/resolve", async (req, reply) => {
    const operator = guard(req, reply);
    if (!operator) return reply;
    const parsed = ResolveBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "E_SCHEMA_INVALID", message: "resolution 需为 committed/failed" });
    const { clientTurnId } = req.params as { clientTurnId: string };
    const scope = parsed.data.userId && parsed.data.roomId
      ? { userId: parsed.data.userId, roomId: parsed.data.roomId, clientTurnId }
      : clientTurnId;
    const result = await deps.ledger.resolve(scope, parsed.data.resolution, parsed.data.committedSeq);
    if (!result.ok) {
      if (result.code === "E_STORE_FAULT") {
        return reply.code(503).send({ ok: false, code: result.code, message: result.message });
      }
      if (result.code === "E_ILLEGAL_OP") {
        return reply.code(409).send({ ok: false, code: result.code, message: result.message });
      }
      return notFound(reply);
    }
    deps.log.record({ operator, target: clientTurnId, action: "quota.resolve", reason: parsed.data.reason, result: parsed.data.resolution });
    return { ok: true, entry: result.entry };
  });
}