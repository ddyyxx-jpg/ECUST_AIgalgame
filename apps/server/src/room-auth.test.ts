/**
 * 房间授权（issue #33）：登录只解决身份，成员资格决定能不能进房间。
 * 断言 HTTP 状态码 / 错误码 / seq 不变，不断言文案。
 */
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { tempDir } from "@galgame/testkit";
import { createApp } from "./bootstrap.ts";
import { registerRoutes } from "./routes.ts";
import type { ServerConfig } from "./config.ts";

function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: tempDir("galgame-room-auth-"),
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
    ...overrides,
  };
}

/** Cookie 写请求的合法 Origin（CSRF 校验）；成员资格测试要越过 CSRF 才能测到 guardRoom */
const ORIGIN = { origin: "https://galgame.test" };

async function makeApp(overrides: Partial<ServerConfig> = {}) {
  const deps = await createApp(testConfig(overrides));
  const app = Fastify();
  registerRoutes(app, deps);
  return { deps, app };
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== "string") throw new Error("set-cookie missing");
  return first.split(";")[0] ?? "";
}

async function register(app: Awaited<ReturnType<typeof makeApp>>["app"], username: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    headers: ORIGIN,
    payload: { username, password: "password123", inviteCode: "invite-123" },
  });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

async function eventCount(deps: Awaited<ReturnType<typeof makeApp>>["deps"], roomId: string): Promise<number> {
  return (await deps.store.events(roomId, 0, 500)).length;
}

describe("房间授权（issue #33，强制登录模式）", () => {
  it("B 跨账号读 A 的房间：state/events/map/gallery/history 一律 403，seq 不变；A 自己全通", async () => {
    const { deps, app } = await makeApp();
    const cookieA = await register(app, "alice");
    const cookieB = await register(app, "bob");
    const created = await app.inject({ method: "POST", url: "/api/v1/rooms", headers: { cookie: cookieA, ...ORIGIN }, payload: { mode: "solo" } });
    const { roomId } = created.json() as { roomId: string };
    const before = await eventCount(deps, roomId);

    for (const path of ["state", "events", "map", "gallery", "history"]) {
      const res = await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/${path}`, headers: { cookie: cookieB } });
      expect(res.statusCode, path).toBe(403);
      expect((res.json() as { code: string }).code, path).toBe("E_FORBIDDEN");
    }
    expect(await eventCount(deps, roomId)).toBe(before);

    for (const path of ["state", "events", "map", "gallery", "history"]) {
      const res = await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/${path}`, headers: { cookie: cookieA } });
      expect(res.statusCode, path).toBe(200);
    }
    await app.close();
  });

  it("B 不能代 A 操作：turns/travel/tick/dialogue 全 403；body.userId 与 X-User-Id 不能切换身份", async () => {
    const { deps, app } = await makeApp();
    const cookieA = await register(app, "alice");
    const cookieB = await register(app, "bob");
    const created = await app.inject({ method: "POST", url: "/api/v1/rooms", headers: { cookie: cookieA, ...ORIGIN }, payload: { mode: "solo" } });
    const { roomId, actorId } = created.json() as { roomId: string; actorId: string };
    const userIdA = (await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: cookieA } }).then((r) => r.json())) as { user: { userId: string } };
    const before = await eventCount(deps, roomId);

    const turn = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/turns`,
      headers: { cookie: cookieB, ...ORIGIN, "x-user-id": userIdA.user.userId },
      payload: { actorId, input: "你好", clientTurnId: "b1", userId: userIdA.user.userId },
    });
    expect(turn.statusCode).toBe(403);
    expect((turn.json() as { code: string }).code).toBe("E_FORBIDDEN");

    const travel = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/map/travel`,
      headers: { cookie: cookieB, ...ORIGIN },
      payload: { actorId, locId: "loc_library" },
    });
    expect(travel.statusCode).toBe(403);

    const tick = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/map/tick`,
      headers: { cookie: cookieB, ...ORIGIN },
      payload: { advance: true },
    });
    expect(tick.statusCode).toBe(403);

    const dialogue = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/map/dialogue`,
      headers: { cookie: cookieB, ...ORIGIN },
      payload: { actorId, sceneId: "sc_x", dialogueId: "d1" },
    });
    expect(dialogue.statusCode).toBe(403);

    expect(await eventCount(deps, roomId)).toBe(before);
    await app.close();
  });

  it("A 用自己的 actorId 提交回合正常 commit", async () => {
    const { app } = await makeApp();
    const cookieA = await register(app, "alice");
    const created = await app.inject({ method: "POST", url: "/api/v1/rooms", headers: { cookie: cookieA, ...ORIGIN }, payload: { mode: "solo" } });
    const { roomId, actorId } = created.json() as { roomId: string; actorId: string };
    const turn = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/turns`,
      headers: { cookie: cookieA, ...ORIGIN },
      payload: { actorId, input: "你好", clientTurnId: "a1" },
    });
    expect(turn.statusCode).toBe(200);
    expect(turn.body).toContain("turn.commit");
    await app.close();
  });

  it("旧档（成员表无 userId）强制登录默认不开放；管理员令牌是显式例外", async () => {
    const { deps, app } = await makeApp();
    const cookieA = await register(app, "alice");
    const legacy = await deps.createRoom("solo", undefined);

    const denied = await app.inject({ method: "GET", url: `/api/v1/rooms/${legacy.roomId}/state`, headers: { cookie: cookieA } });
    expect(denied.statusCode).toBe(403);

    const admin = await app.inject({
      method: "GET",
      url: `/api/v1/rooms/${legacy.roomId}/state`,
      headers: { cookie: cookieA, "x-admin-token": "dev-admin" },
    });
    expect(admin.statusCode).toBe(200);

    const badToken = await app.inject({
      method: "GET",
      url: `/api/v1/rooms/${legacy.roomId}/state`,
      headers: { cookie: cookieA, "x-admin-token": "wrong" },
    });
    expect(badToken.statusCode).toBe(403);
    await app.close();
  });
  it("存档读取故障 → 503 E_STORE_FAULT，不折叠成 404（也不触发任何写）", async () => {
    const { deps, app } = await makeApp();
    const cookieA = await register(app, "alice");
    const created = await app.inject({ method: "POST", url: "/api/v1/rooms", headers: { cookie: cookieA, ...ORIGIN }, payload: { mode: "solo" } });
    const { roomId } = created.json() as { roomId: string };
    const before = await eventCount(deps, roomId);
    const realSnapshot = deps.store.snapshot.bind(deps.store);
    deps.store.snapshot = async () => {
      throw new Error("corrupt jsonl");
    };
    for (const path of ["state", "events", "map", "gallery", "history"]) {
      const res = await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/${path}`, headers: { cookie: cookieA } });
      expect(res.statusCode, path).toBe(503);
      expect((res.json() as { code: string }).code, path).toBe("E_STORE_FAULT");
    }
    deps.store.snapshot = realSnapshot;
    expect(await eventCount(deps, roomId)).toBe(before);
    // 房间仍然存在，故障恢复后照常可读（客户端不会因 404 清掉房间指针）
    expect((await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/state`, headers: { cookie: cookieA } })).statusCode).toBe(200);
    await app.close();
  });
});

describe("房间授权（本地开发模式 AUTH_REQUIRED=0）", () => {
  it("有归属房间仍按成员隔离；旧房间保持旧开放度", async () => {
    const { deps, app } = await makeApp({ authRequired: false });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      headers: { "x-user-id": "u_a" },
      payload: { mode: "solo" },
    });
    const { roomId, actorId } = created.json() as { roomId: string; actorId: string };

    expect((await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/state`, headers: { "x-user-id": "u_a" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/state`, headers: { "x-user-id": "u_b" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/state` })).statusCode).toBe(403);

    const before = await eventCount(deps, roomId);
    const turn = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/turns`,
      headers: { "x-user-id": "u_b" },
      payload: { actorId, input: "你好", clientTurnId: "b1" },
    });
    expect(turn.statusCode).toBe(403);
    expect(await eventCount(deps, roomId)).toBe(before);

    const legacy = await deps.createRoom("solo", undefined);
    expect((await app.inject({ method: "GET", url: `/api/v1/rooms/${legacy.roomId}/state` })).statusCode).toBe(200);
    await app.close();
  });
});