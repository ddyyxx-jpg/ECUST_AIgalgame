/**
 * 用户系统（3.4.0，收敛稿 B1）：邀请注册、用户名密码登录、HttpOnly Cookie 会话、
 * 一次性重置凭证、改密。身份只从会话来；每次受保护请求校验**当前**账号状态。
 * 存储见 auth-store.ts（单一 auth 域文件）；限流见 rate-limit.ts。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { normalizeUsername, validatePassword, type Account, type AccountState, type Role } from "./users.ts";
import type { AuthStore } from "./auth-store.ts";
import { clearSessionCookie, sessionCookie, SessionStore } from "./sessions.ts";
import { progressiveDelayMs, RateLimiter, sleep } from "./rate-limit.ts";

export interface AuthUser {
  userId: string;
  username: string;
  role: Role;
  state: AccountState;
  nickname?: string;
}

export interface AuthOptions {
  store: AuthStore;
  sessions: SessionStore;
  /** 开发兼容共享邀请码；空 = 仅管理员签发的一次性邀请 */
  envCode: string;
  required: boolean;
  secureCookies: boolean;
  ttlDays: number;
  resetTtlMs: number;
}

export type AuthResult =
  | { ok: true; user: AuthUser; token: string }
  | { ok: false; status: number; code: string; message: string };

const RegisterBody = z.object({ username: z.string(), password: z.string(), inviteCode: z.string().optional() });
const LoginBody = z.object({ username: z.string(), password: z.string() });
const ResetBody = z.object({ username: z.string(), credential: z.string(), newPassword: z.string() });
const PasswordBody = z.object({ currentPassword: z.string(), newPassword: z.string() });

function publicUser(user: Account): AuthUser {
  return { userId: user.userId, username: user.username, role: user.role, state: user.state, ...(user.nickname ? { nickname: user.nickname } : {}) };
}

function fail(status: number, code: string, message: string): AuthResult {
  return { ok: false, status, code, message };
}

export class AuthService {
  private readonly loginLimiter = new RateLimiter(5, 60_000);
  private readonly accountLimiter = new RateLimiter(30, 5 * 60_000);
  private readonly registerLimiter = new RateLimiter(10, 60_000);
  private readonly resetLimiter = new RateLimiter(5, 60_000);

  constructor(readonly opts: AuthOptions) {}

  get required(): boolean {
    return this.opts.required;
  }

  get store(): AuthStore {
    return this.opts.store;
  }

  get sessions(): SessionStore {
    return this.opts.sessions;
  }

  /** 会话 + 当前账号状态校验：suspended/archived 的旧会话立即失效（不只信登录时快照） */
  resolve(req: FastifyRequest): AuthUser | null {
    const session = this.opts.sessions.userFromHeader(req.headers.cookie);
    if (!session) return null;
    const account = this.opts.store.getUser(session.userId);
    if (!account || account.state !== "active") return null;
    return publicUser(account);
  }

  resolveUserId(req: FastifyRequest): string | undefined {
    return this.resolve(req)?.userId;
  }

  me(req: FastifyRequest): AuthUser | null {
    return this.resolve(req);
  }

  status(): { required: boolean; registrationOpen: boolean } {
    return { required: this.opts.required, registrationOpen: this.opts.store.getSettings().registrationOpen };
  }

  async register(raw: unknown, ip: string): Promise<AuthResult> {
    const parsed = RegisterBody.safeParse(raw ?? {});
    if (!parsed.success) return fail(400, "E_SCHEMA_INVALID", "用户名和密码必填");
    if (!this.registerLimiter.hit(`reg:${ip}`).allowed) return fail(429, "E_RATE_LIMITED", "注册尝试过于频繁，请稍后再试");
    const username = normalizeUsername(parsed.data.username);
    if (!username) return fail(400, "E_SCHEMA_INVALID", "用户名需 3–24 位小写字母/数字/下划线/连字符");
    const password = validatePassword(parsed.data.password);
    if (!password) return fail(400, "E_SCHEMA_INVALID", "密码需 8–128 位");

    const created = await this.opts.store.register(username, password, {
      inviteCode: parsed.data.inviteCode,
      envCode: this.opts.envCode,
      registrationOpen: this.opts.store.getSettings().registrationOpen,
    });
    if (!created.ok) {
      const status = created.code === "E_ID_TAKEN" ? 409 : created.code === "E_STORE_FAULT" ? 503 : 403;
      return fail(status, created.code, created.message);
    }
    const user = publicUser(created.user);
    return { ok: true, user, token: this.opts.sessions.create(user) };
  }

  async login(raw: unknown, ip: string): Promise<AuthResult> {
    const parsed = LoginBody.safeParse(raw ?? {});
    if (!parsed.success) return fail(401, "E_UNAUTHORIZED", "用户名或密码错误");
    const username = normalizeUsername(parsed.data.username) ?? parsed.data.username.trim().toLowerCase();
    if (!this.loginLimiter.hit(`${ip}:${username}`).allowed) {
      return fail(429, "E_RATE_LIMITED", "尝试过于频繁，请稍后再试");
    }
    // 账号级渐进延迟（跨 IP 累计，封顶 2s）：缓解针对用户名的撞库/DoS，不长期占住连接
    await sleep(progressiveDelayMs(this.accountLimiter.count(`acct:${username}`)));

    const account = await this.opts.store.verify(username, parsed.data.password);
    if (!account) {
      this.accountLimiter.hit(`acct:${username}`);
      return fail(401, "E_UNAUTHORIZED", "用户名或密码错误");
    }
    this.loginLimiter.reset(`${ip}:${username}`);
    this.accountLimiter.reset(`acct:${username}`);
    const user = publicUser(account);
    return { ok: true, user, token: this.opts.sessions.create(user) };
  }

  async resetPassword(raw: unknown, ip: string): Promise<{ ok: boolean; status?: number; code?: string; message?: string }> {
    const parsed = ResetBody.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false, status: 400, code: "E_SCHEMA_INVALID", message: "用户名/凭证/新密码必填" };
    const username = normalizeUsername(parsed.data.username);
    if (!username) return { ok: false, status: 400, code: "E_SCHEMA_INVALID", message: "用户名格式不正确" };
    if (!this.resetLimiter.hit(`rst:${ip}:${username}`).allowed) {
      return { ok: false, status: 429, code: "E_RATE_LIMITED", message: "重置尝试过于频繁，请稍后再试" };
    }
    const password = validatePassword(parsed.data.newPassword);
    if (!password) return { ok: false, status: 400, code: "E_SCHEMA_INVALID", message: "密码需 8–128 位" };
    const result = await this.opts.store.consumeReset(username, parsed.data.credential, password);
    if (!result.ok) return { ok: false, status: 401, code: result.code ?? "E_UNAUTHORIZED", message: result.message ?? "重置失败" };
    const account = this.opts.store.findUser(username);
    if (account) this.opts.sessions.revokeUser(account.userId);
    return { ok: true };
  }

  async changePassword(req: FastifyRequest, raw: unknown): Promise<{ ok: boolean; status?: number; code?: string; message?: string }> {
    const user = this.resolve(req);
    if (!user) return { ok: false, status: 401, code: "E_UNAUTHORIZED", message: "请先登录" };
    const parsed = PasswordBody.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false, status: 400, code: "E_SCHEMA_INVALID", message: "当前密码与新密码必填" };
    const password = validatePassword(parsed.data.newPassword);
    if (!password) return { ok: false, status: 400, code: "E_SCHEMA_INVALID", message: "密码需 8–128 位" };
    const result = await this.opts.store.changePassword(user.userId, parsed.data.currentPassword, password);
    if (!result.ok) return { ok: false, status: result.code === "E_UNAUTHORIZED" ? 401 : 400, code: result.code, message: result.message };
    this.opts.sessions.revokeOthers(user.userId, this.opts.sessions.cookieToken(req.headers.cookie));
    return { ok: true };
  }

  logout(req: FastifyRequest): void {
    this.opts.sessions.destroy(this.opts.sessions.cookieToken(req.headers.cookie));
  }

  cookieFor(token: string): string {
    return sessionCookie(token, this.opts.ttlDays * 24 * 60 * 60, this.opts.secureCookies);
  }

  clearCookie(): string {
    return clearSessionCookie(this.opts.secureCookies);
  }
}

function sendFail(reply: FastifyReply, result: Extract<AuthResult, { ok: false }>): FastifyReply {
  return reply.code(result.status).send({ ok: false, code: result.code, message: result.message });
}

export function registerAuthRoutes(app: FastifyInstance, auth: AuthService): void {
  app.post("/api/v1/auth/register", async (req, reply) => {
    const result = await auth.register(req.body, req.ip ?? "?");
    if (!result.ok) return sendFail(reply, result);
    reply.header("set-cookie", auth.cookieFor(result.token));
    return { ok: true, user: result.user };
  });

  app.post("/api/v1/auth/login", async (req, reply) => {
    const result = await auth.login(req.body, req.ip ?? "?");
    if (!result.ok) return sendFail(reply, result);
    reply.header("set-cookie", auth.cookieFor(result.token));
    return { ok: true, user: result.user };
  });

  app.post("/api/v1/auth/logout", async (req, reply) => {
    auth.logout(req);
    reply.header("set-cookie", auth.clearCookie());
    return { ok: true };
  });

  app.get("/api/v1/auth/me", async (req, reply) => {
    const user = auth.me(req);
    if (!user) return reply.code(401).send({ ok: false, code: "E_UNAUTHORIZED", message: "未登录" });
    return { ok: true, user };
  });

  // 公开：前端据此决定登录门 / 本地访客入口（PR #19 P1-2）
  app.get("/api/v1/auth/status", async () => ({ ok: true, ...auth.status() }));

  app.post("/api/v1/auth/reset-password", async (req, reply) => {
    const result = await auth.resetPassword(req.body, req.ip ?? "?");
    if (!result.ok) return reply.code(result.status ?? 400).send({ ok: false, code: result.code, message: result.message });
    return { ok: true };
  });

  app.post("/api/v1/auth/password", async (req, reply) => {
    const result = await auth.changePassword(req, req.body);
    if (!result.ok) return reply.code(result.status ?? 400).send({ ok: false, code: result.code, message: result.message });
    return { ok: true };
  });
}