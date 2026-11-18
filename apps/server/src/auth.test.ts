/**
 * 简易用户系统：邀请注册 / 登录 / 会话 / 强制登录 / 会话优先于 header。
 * 断言状态与 Cookie 行为，不断言文案。
 */
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { tempDir } from "@galgame/testkit";
import { createApp } from "./bootstrap.ts";
import { registerRoutes } from "./routes.ts";
import type { ServerConfig } from "./config.ts";

function testConfig(): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: tempDir("galgame-auth-"),
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
  const cfg = testConfig();
  const deps = await createApp(cfg);
  const app = Fastify();
  registerRoutes(app, deps);
  return { cfg, deps, app };
}

/** auth 写路由同样过 CSRF：与普通写请求一样必须带合法 Origin */
const ORIGIN = { origin: "https://galgame.test" };

const reg = (body: Record<string, unknown>, headers: Record<string, string> = ORIGIN) => ({ method: "POST" as const, url: "/api/v1/auth/register", headers, payload: body });

describe("简易用户系统", () => {
  it("邀请注册 → 自动登录；受保护接口无 Cookie 401，有 Cookie 200", async () => {
    const { app } = await makeApp();
    const before = await app.inject({ method: "POST", url: "/api/v1/rooms", payload: { mode: "solo" } });
    expect(before.statusCode).toBe(401);
    expect((before.json() as { code: string }).code).toBe("E_UNAUTHORIZED");

    const registered = await app.inject(reg({ username: "Alice", password: "password123", inviteCode: "invite-123" }));
    expect(registered.statusCode).toBe(200);
    const cookie = cookieOf(registered);
    // Cookie 属性（建议5）：HttpOnly + SameSite=Lax；secureCookies=false 不带 Secure
    const setCookie = String(registered.headers["set-cookie"]);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Secure");
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    const meUser = (me.json() as { user: { username: string; userId: string; role: string; state: string } }).user;
    expect(meUser).toMatchObject({ username: "alice", role: "player", state: "active" });

    // header 伪造不能覆盖会话 userId
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      headers: { cookie, origin: "https://galgame.test", "x-user-id": "attacker" },
      payload: { mode: "solo" },
    });
    expect(created.statusCode).toBe(200);
    const { roomId } = created.json() as { roomId: string };
    const state = await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/state`, headers: { cookie } });
    const member = (state.json() as { room: { members: { userId?: string }[] } }).room.members[0];
    expect(member?.userId).toBe(meUser.userId);
    expect(member?.userId).not.toBe("attacker");

    // 公开端点不需要登录
    expect((await app.inject({ method: "GET", url: "/api/v1/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/registry" })).statusCode).toBe(200);
    await app.close();
  });

  it("登录失败 401、登录成功 200、登出后 me 401；邀请码/重复用户名/弱密码被拒", async () => {
    const { app } = await makeApp();
    const badInvite = await app.inject(reg({ username: "bob", password: "password123", inviteCode: "no" }));
    expect(badInvite.statusCode).toBe(403);

    const weak = await app.inject(reg({ username: "bob", password: "short", inviteCode: "invite-123" }));
    expect(weak.statusCode).toBe(400);

    const first = await app.inject(reg({ username: "bob", password: "password123", inviteCode: "invite-123" }));
    expect(first.statusCode).toBe(200);
    const duplicate = await app.inject(reg({ username: "BOB", password: "password123", inviteCode: "invite-123" }));
    expect(duplicate.statusCode).toBe(409);

    const wrong = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: ORIGIN, payload: { username: "bob", password: "wrongpass" } });
    expect(wrong.statusCode).toBe(401);

    const ok = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: ORIGIN, payload: { username: "Bob", password: "password123" } });
    expect(ok.statusCode).toBe(200);
    const cookie = cookieOf(ok);
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } })).statusCode).toBe(200);

    const out = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie, ...ORIGIN } });
    expect(out.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } })).statusCode).toBe(401);
    await app.close();
  });

  it("CSRF：Cookie 写请求缺 Origin / Origin 不符 → 403；带合法 Origin → 放行", async () => {
    const { app } = await makeApp();
    const registered = await app.inject(reg({ username: "carol", password: "password123", inviteCode: "invite-123" }));
    const cookie = cookieOf(registered);
    const noOrigin = await app.inject({ method: "POST", url: "/api/v1/rooms", headers: { cookie }, payload: { mode: "solo" } });
    expect(noOrigin.statusCode).toBe(403);
    const badOrigin = await app.inject({ method: "POST", url: "/api/v1/rooms", headers: { cookie, origin: "https://evil.test" }, payload: { mode: "solo" } });
    expect(badOrigin.statusCode).toBe(403);
    const ok = await app.inject({ method: "POST", url: "/api/v1/rooms", headers: { cookie, origin: "https://galgame.test" }, payload: { mode: "solo" } });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });

  it("CSRF：auth 写路由（register/login/logout/password/reset）跨源或缺失 Origin 一律 403", async () => {
    const { app, deps } = await makeApp();
    const cross = { origin: "https://evil.test" };
    const writes = [
      { url: "/api/v1/auth/register", payload: { username: "eve", password: "password123", inviteCode: "invite-123" } },
      { url: "/api/v1/auth/login", payload: { username: "eve", password: "password123" } },
      { url: "/api/v1/auth/logout", payload: {} },
      { url: "/api/v1/auth/password", payload: { oldPassword: "password123", newPassword: "newpassword123" } },
      { url: "/api/v1/auth/reset-password", payload: { username: "eve", credential: "x", newPassword: "newpassword123" } },
    ];
    for (const w of writes) {
      for (const headers of [cross, {}]) {
        const res = await app.inject({ method: "POST", url: w.url, headers, payload: w.payload });
        expect(res.statusCode, `${w.url} ${JSON.stringify(headers)}`).toBe(403);
        expect((res.json() as { code: string }).code).toBe("E_FORBIDDEN");
      }
    }
    // 跨站注册没有落库（不是"先建号再拒绝"）
    expect(deps.auth.store.listUsers().length).toBe(0);
    await app.close();
  });

  it("登录连续失败 5 次/分钟 → 429（建议5）", async () => {
    const { app } = await makeApp();
    await app.inject(reg({ username: "dave", password: "password123", inviteCode: "invite-123" }));
    let last = 0;
    for (let i = 0; i < 6; i += 1) {
      last = (await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: ORIGIN, payload: { username: "dave", password: "wrongpass" } })).statusCode;
    }
    expect(last).toBe(429);
    await app.close();
  });

  it("auth/status 公开返回 required/registrationOpen（P1-2）", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, required: true, registrationOpen: true });
    await app.close();
  });

  it("AUTH_REQUIRED=0 时保留旧 header 兜底（本地测试/旧调用）", async () => {
    const cfg = { ...testConfig(), authRequired: false };
    const deps = await createApp(cfg);
    const app = Fastify();
    registerRoutes(app, deps);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      headers: { "x-user-id": "u_legacy" },
      payload: { mode: "solo" },
    });
    expect(created.statusCode).toBe(200);
    await app.close();
  });
});
