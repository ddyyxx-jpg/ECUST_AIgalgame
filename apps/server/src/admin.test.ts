/**
 * 管理端点 / 邀请 / 重置凭证 / 设置守卫 / health 脱敏（收敛稿 B1，docs/03 §5.2.9）。
 * 断言状态码 / 错误码 / 结构，不断言文案。
 */
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { tempDir } from "@galgame/testkit";
import { createApp } from "./bootstrap.ts";
import { registerRoutes } from "./routes.ts";
import { AdminTokenGate } from "./admin-token.ts";
import type { ServerConfig } from "./config.ts";

const ORIGIN = { origin: "https://galgame.test" };
const ADMIN = { "x-admin-token": "dev-admin" };

function testConfig(): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: tempDir("galgame-admin-"),
    contentDir: "content",
    adminToken: "dev-admin",
    trustUserHeader: true,
    authRequired: true,
    inviteCode: "invite-123",
    secureCookies: false,
    sessionTtlDays: 7,
    publicOrigin: "https://galgame.test",
    llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
    audit: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1000 },
  };
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== "string") throw new Error("set-cookie missing");
  return first.split(";")[0] ?? "";
}

async function makeApp() {
  const deps = await createApp(testConfig());
  const app = Fastify();
  registerRoutes(app, deps);
  return { deps, app };
}

async function registerPlayer(app: Awaited<ReturnType<typeof makeApp>>["app"], username: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/register", headers: ORIGIN, payload: { username, password: "password123", inviteCode: "invite-123" } });
  expect(res.statusCode).toBe(200);
  const cookie = cookieOf(res);
  const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });
  const userId = (me.json() as { user: { userId: string } }).user.userId;
  return { cookie, userId };
}

describe("管理端点鉴权", () => {
  it("无凭证 401；普通玩家会话 403；admin-token 200", async () => {
    const { app } = await makeApp();
    const { cookie } = await registerPlayer(app, "alice");
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/users" })).statusCode).toBe(401);
    const player = await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: { cookie } });
    expect(player.statusCode).toBe(403);
    expect((player.json() as { code: string }).code).toBe("E_FORBIDDEN");
    const admin = await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: ADMIN });
    expect(admin.statusCode).toBe(200);
    expect((admin.json() as { users: unknown[] }).users.length).toBe(1);
    await app.close();
  });

  it("admin-role 会话也可访问；普通玩家改密后仍非 admin", async () => {
    const { app, deps } = await makeApp();
    const { cookie, userId } = await registerPlayer(app, "alice");
    await deps.auth.store.setUserRole(userId, "admin");
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("admin-token 连续失败达阈值 → 429 E_RATE_LIMITED + Retry-After（窗口内正确令牌也拒绝）", async () => {
    const { app } = await makeApp();
    for (let i = 0; i < 10; i += 1) {
      const res = await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: { "x-admin-token": `wrong-${i}` } });
      expect(res.statusCode, `attempt ${i}`).toBe(401);
    }
    const blocked = await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: ADMIN });
    expect(blocked.statusCode).toBe(429);
    expect((blocked.json() as { code: string }).code).toBe("E_RATE_LIMITED");
    expect(blocked.headers["retry-after"]).toBeDefined();
    await app.close();
  });

  it("同一请求的令牌失败只计一次（登录门 + 管理路由共用请求级缓存）", async () => {
    const deps = await createApp(testConfig());
    // 阈值 1：若同一请求在两个入口各记一次，第一个请求就会被判 429
    deps.adminGate = new AdminTokenGate("dev-admin", 1, 60_000);
    const app = Fastify();
    registerRoutes(app, deps);
    const { cookie } = await registerPlayer(app, "alice");

    const first = await app.inject({
      method: "GET", url: "/api/v1/admin/users",
      headers: { cookie, "x-admin-token": "wrong-once" },
    });
    expect(first.statusCode).toBe(403);
    expect((first.json() as { code: string }).code).toBe("E_FORBIDDEN");

    // 第二个请求才应触发 429：证明上一条只累计了 1 次失败
    const second = await app.inject({
      method: "GET", url: "/api/v1/admin/users",
      headers: { "x-admin-token": "wrong-twice" },
    });
    expect(second.statusCode).toBe(429);
    expect((second.json() as { code: string }).code).toBe("E_RATE_LIMITED");
    await app.close();
  });
});

describe("邀请注册", () => {
  it("管理员签发一次性邀请：首次注册成功，复用被拒；列表不回显 codeHash", async () => {
    const { app } = await makeApp();
    const created = await app.inject({ method: "POST", url: "/api/v1/admin/invites", headers: { ...ADMIN, ...ORIGIN }, payload: { note: "测试" } });
    expect(created.statusCode).toBe(200);
    const { invite, code } = created.json() as { invite: { id: string; codeHash?: string }; code: string };
    expect(invite.codeHash).toBeUndefined();
    expect(typeof code).toBe("string");

    const ok = await app.inject({ method: "POST", url: "/api/v1/auth/register", headers: ORIGIN, payload: { username: "bob", password: "password123", inviteCode: code } });
    expect(ok.statusCode).toBe(200);
    const reuse = await app.inject({ method: "POST", url: "/api/v1/auth/register", headers: ORIGIN, payload: { username: "carol", password: "password123", inviteCode: code } });
    expect(reuse.statusCode).toBe(403);

    const list = await app.inject({ method: "GET", url: "/api/v1/admin/invites", headers: ADMIN });
    const invites = (list.json() as { invites: { codeHash?: string }[] }).invites;
    expect(invites.every((i) => i.codeHash === undefined)).toBe(true);

    const revoked = await app.inject({ method: "POST", url: `/api/v1/admin/invites/${invite.id}/revoke`, headers: { ...ADMIN, ...ORIGIN }, payload: {} });
    expect(revoked.statusCode).toBe(200);
    await app.close();
  });
});

describe("重置凭证", () => {
  it("管理员签发 → 用户重置密码 → 新密码可登录、旧会话失效", async () => {
    const { app } = await makeApp();
    const { cookie, userId } = await registerPlayer(app, "alice");
    const issued = await app.inject({ method: "POST", url: `/api/v1/admin/users/${userId}/reset-credential`, headers: { ...ADMIN, ...ORIGIN }, payload: {} });
    expect(issued.statusCode).toBe(200);
    const { credential, expiresAt } = issued.json() as { credential: string; expiresAt: number };
    expect(typeof credential).toBe("string");
    expect(expiresAt).toBeGreaterThan(Date.now());

    const reset = await app.inject({ method: "POST", url: "/api/v1/auth/reset-password", headers: ORIGIN, payload: { username: "alice", credential, newPassword: "newpassword123" } });
    expect(reset.statusCode).toBe(200);
    // 旧会话被撤销
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } })).statusCode).toBe(401);
    // 旧密码失效、新密码可登录
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: ORIGIN, payload: { username: "alice", password: "password123" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: ORIGIN, payload: { username: "alice", password: "newpassword123" } })).statusCode).toBe(200);
    // 凭证一次性：复用被拒
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/reset-password", headers: ORIGIN, payload: { username: "alice", credential, newPassword: "another12345" } })).statusCode).toBe(401);
    await app.close();
  });
});

describe("账号状态 / 设置", () => {
  it("suspend 立即吊销该用户会话；active 恢复后可重新登录", async () => {
    const { app } = await makeApp();
    const { cookie, userId } = await registerPlayer(app, "alice");
    const suspended = await app.inject({ method: "POST", url: `/api/v1/admin/users/${userId}/state`, headers: { ...ADMIN, ...ORIGIN }, payload: { state: "suspended", reason: "违规" } });
    expect(suspended.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: ORIGIN, payload: { username: "alice", password: "password123" } })).statusCode).toBe(401);
    await app.close();
  });

  it("关闭 registrationOpen 后注册 403；settings 可读回", async () => {
    const { app } = await makeApp();
    const put = await app.inject({ method: "PUT", url: "/api/v1/admin/settings", headers: { ...ADMIN, ...ORIGIN }, payload: { registrationOpen: false, defaultDailyTurns: 5 } });
    expect(put.statusCode).toBe(200);
    const reg = await app.inject({ method: "POST", url: "/api/v1/auth/register", headers: ORIGIN, payload: { username: "bob", password: "password123", inviteCode: "invite-123" } });
    expect(reg.statusCode).toBe(403);
    const status = await app.inject({ method: "GET", url: "/api/v1/auth/status" });
    expect(status.json()).toMatchObject({ required: true, registrationOpen: false });
    const got = await app.inject({ method: "GET", url: "/api/v1/admin/settings", headers: ADMIN });
    expect((got.json() as { settings: { defaultDailyTurns: number } }).settings.defaultDailyTurns).toBe(5);
    await app.close();
  });

  it("操作日志记录管理动作（不含密码/token）", async () => {
    const { app } = await makeApp();
    const { userId } = await registerPlayer(app, "alice");
    await app.inject({ method: "POST", url: `/api/v1/admin/users/${userId}/role`, headers: { ...ADMIN, ...ORIGIN }, payload: { role: "admin", reason: "提拔" } });
    const log = await app.inject({ method: "GET", url: "/api/v1/admin/actions", headers: ADMIN });
    const actions = (log.json() as { actions: { action: string; reason: string }[] }).actions;
    expect(actions.some((a) => a.action === "user.role")).toBe(true);
    expect(JSON.stringify(actions)).not.toContain("dev-admin");
    await app.close();
  });
});

describe("额度对账端点", () => {
  it("admin 可把待核对条目 resolve 为 committed/failed", async () => {
    const { app, deps } = await makeApp();
    const { userId } = await registerPlayer(app, "alice");
    deps.ledger.reserve({ userId, roomId: "room_x", clientTurnId: "c1", dailyLimit: null, actionsEnabled: true });
    deps.ledger.transition("c1", "unconfirmed");
    const resolved = await app.inject({ method: "POST", url: "/api/v1/admin/quota/c1/resolve", headers: { ...ADMIN, ...ORIGIN }, payload: { resolution: "committed", committedSeq: 4 } });
    expect(resolved.statusCode).toBe(200);
    expect((resolved.json() as { entry: { state: string; committedSeq: number } }).entry).toMatchObject({ state: "committed", committedSeq: 4 });
    const missing = await app.inject({ method: "POST", url: "/api/v1/admin/quota/nope/resolve", headers: { ...ADMIN, ...ORIGIN }, payload: { resolution: "failed" } });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("只允许结案 unconfirmed：running/committed → 409 E_ILLEGAL_OP", async () => {
    const { app, deps } = await makeApp();
    const { userId } = await registerPlayer(app, "alice");
    deps.ledger.reserve({ userId, roomId: "room_x", clientTurnId: "done", dailyLimit: null, actionsEnabled: true });
    deps.ledger.transition("done", "committed", { committedSeq: 3 });
    deps.ledger.reserve({ userId, roomId: "room_x", clientTurnId: "run", dailyLimit: null, actionsEnabled: true });
    deps.ledger.transition("run", "running");

    for (const id of ["run", "done"]) {
      const res = await app.inject({ method: "POST", url: `/api/v1/admin/quota/${id}/resolve`, headers: { ...ADMIN, ...ORIGIN }, payload: { resolution: "failed" } });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { code: string }).code).toBe("E_ILLEGAL_OP");
    }
    expect(deps.ledger.get("run")?.state).toBe("running");
    expect(deps.ledger.get("done")?.state).toBe("committed");
    await app.close();
  });
});

describe("P1-1 设置守卫 / 建议11 health 脱敏", () => {
  it("settings：普通玩家会话 403，admin-token 200（反代下不靠本机 IP）", async () => {
    const { app } = await makeApp();
    const { cookie } = await registerPlayer(app, "alice");
    const player = await app.inject({ method: "GET", url: "/api/v1/settings/llm", headers: { cookie } });
    expect(player.statusCode).toBe(200); // HTTP 200 + ok:false（业务拒绝）
    expect(player.json()).toMatchObject({ ok: false, code: "E_FORBIDDEN" });
    const admin = await app.inject({ method: "GET", url: "/api/v1/settings/llm", headers: ADMIN });
    expect(admin.json()).toMatchObject({ ok: true });
    await app.close();
  });

  it("公开 health 不含 canonize；admin/stats 暴露 canonizeJudge", async () => {
    const { app } = await makeApp();
    const health = await app.inject({ method: "GET", url: "/api/v1/health" });
    const body = health.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.canonize).toBeUndefined();
    const stats = await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers: ADMIN });
    expect(stats.json()).toHaveProperty("canonizeJudge");
    await app.close();
  });
});

describe("P2 草案授权收口（服务端再校验）", () => {
  it("创建/详情：无会话 401；玩家会话 E_FORBIDDEN；admin-token 放行到业务层", async () => {
    const { app } = await makeApp();
    const { cookie } = await registerPlayer(app, "alice");

    const anon = await app.inject({ method: "POST", url: "/api/v1/map/drafts", payload: {} });
    expect(anon.statusCode).toBe(401);

    const playerCreate = await app.inject({
      method: "POST",
      url: "/api/v1/map/drafts",
      headers: { cookie, ...ORIGIN },
      payload: { name: "x", idea: "y", anchorLocId: "loc_missing" },
    });
    expect(playerCreate.json()).toMatchObject({ ok: false, code: "E_FORBIDDEN" });

    const playerDetail = await app.inject({ method: "GET", url: "/api/v1/map/drafts/draft_missing", headers: { cookie } });
    expect(playerDetail.json()).toMatchObject({ ok: false, code: "E_FORBIDDEN" });

    // admin-token 通过授权边界，进入 map 业务校验
    const admin = await app.inject({ method: "POST", url: "/api/v1/map/drafts", headers: { ...ADMIN, ...ORIGIN }, payload: {} });
    expect(admin.json()).toMatchObject({ ok: false, code: "E_SCHEMA_INVALID" });
    await app.close();
  });
});