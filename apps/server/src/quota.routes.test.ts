/**
 * 额度结算的 HTTP 接线（收敛稿 B1，docs/03 §5.2.10）：turns 预留/拒绝在 SSE 头之前、
 * 提交结案、重复逻辑 ID 幂等、行动核对端点与历史对账。断言状态码/错误码/结构，不断言文案。
 */
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { tempDir } from "@galgame/testkit";
import { createApp } from "./bootstrap.ts";
import { registerRoutes } from "./routes.ts";
import type { ServerConfig } from "./config.ts";

const ORIGIN = { origin: "https://galgame.test" };
const ADMIN = { "x-admin-token": "dev-admin" };

function testConfig(): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: tempDir("galgame-quota-route-"),
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

async function setup() {
  const deps = await createApp(testConfig());
  const app = Fastify();
  registerRoutes(app, deps);
  const reg = await app.inject({ method: "POST", url: "/api/v1/auth/register", headers: ORIGIN, payload: { username: "alice", password: "password123", inviteCode: "invite-123" } });
  const cookie = cookieOf(reg);
  const created = await app.inject({ method: "POST", url: "/api/v1/rooms", headers: { cookie, ...ORIGIN }, payload: { mode: "solo" } });
  const { roomId, actorId } = created.json() as { roomId: string; actorId: string };
  const turn = (clientTurnId: string) => app.inject({
    method: "POST", url: `/api/v1/rooms/${roomId}/turns`,
    headers: { cookie, ...ORIGIN }, payload: { actorId, input: "你好", clientTurnId },
  });
  return { deps, app, cookie, roomId, actorId, turn };
}

describe("turns 额度结算", () => {
  it("每日额度用完 → 429 E_RATE_LIMITED（拒绝在 SSE 头之前）", async () => {
    const { app, turn } = await setup();
    await app.inject({ method: "PUT", url: "/api/v1/admin/settings", headers: { ...ADMIN, ...ORIGIN }, payload: { defaultDailyTurns: 1 } });
    const first = await turn("c1");
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain("turn.commit");
    const second = await turn("c2");
    expect(second.statusCode).toBe(429);
    expect((second.json() as { code: string }).code).toBe("E_RATE_LIMITED");
    await app.close();
  });

  it("总开关 actionsEnabled=false → 429", async () => {
    const { app, turn } = await setup();
    await app.inject({ method: "PUT", url: "/api/v1/admin/settings", headers: { ...ADMIN, ...ORIGIN }, payload: { actionsEnabled: false } });
    const res = await turn("c1");
    expect(res.statusCode).toBe(429);
    expect((res.json() as { code: string }).code).toBe("E_RATE_LIMITED");
    await app.close();
  });

  it("提交后结案 committed；重复逻辑 ID → 409 E_PRECONDITION 带 committedSeq", async () => {
    const { app, deps, roomId, turn } = await setup();
    const first = await turn("c1");
    expect(first.statusCode).toBe(200);
    expect(deps.ledger.get("c1")?.state).toBe("committed");
    const dup = await turn("c1");
    expect(dup.statusCode).toBe(409);
    const body = dup.json() as { code: string; committedSeq?: number };
    expect(body.code).toBe("E_PRECONDITION");
    expect(typeof body.committedSeq).toBe("number");
    await app.close();
  });
});

describe("行动核对端点", () => {
  it("已提交行动返回 committed + committedSeq；未知 ID 404；非成员 403", async () => {
    const { app, cookie, roomId, turn } = await setup();
    await turn("c1");
    const ok = await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/turns/c1`, headers: { cookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, state: "committed" });
    expect((ok.json() as { committedSeq: number }).committedSeq).toBeGreaterThan(0);

    const missing = await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/turns/nope`, headers: { cookie } });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { code: string }).code).toBe("E_REF_NOT_FOUND");

    const regB = await app.inject({ method: "POST", url: "/api/v1/auth/register", headers: ORIGIN, payload: { username: "bob", password: "password123", inviteCode: "invite-123" } });
    const cookieB = cookieOf(regB);
    const forbidden = await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/turns/c1`, headers: { cookie: cookieB } });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });

  it("待核对但历史已落盘 → 核对端点与提交事实对账结案 committed", async () => {
    const { app, deps, cookie, roomId, turn } = await setup();
    await turn("c1");
    // 模拟"流提前断开"留下的待核对态：历史里其实已有该逻辑回合的提交事实
    deps.ledger.transition("c1", "unconfirmed");
    expect(deps.ledger.get("c1")?.state).toBe("unconfirmed");
    const res = await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/turns/c1`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, state: "committed" });
    expect(deps.ledger.get("c1")?.state).toBe("committed");
    await app.close();
  });

  it("对账只认本账号+角色的历史：同房间同名 ID 不被他人回合冒充", async () => {
    const { app, deps, cookie, roomId, actorId } = await setup();
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });
    const userId = (me.json() as { user: { userId: string } }).user.userId;
    deps.ledger.reserve({ userId, roomId, actorId, clientTurnId: "c9", dailyLimit: null, actionsEnabled: true });
    deps.ledger.transition({ userId, roomId, clientTurnId: "c9" }, "unconfirmed");
    await deps.history!.append({
      formatVersion: 1, roomId, turnId: "turn_other", committedSeq: 99, actorId: "plr_other",
      userId: "u_other", clientTurnId: "c9", input: "", narrative: "", speakers: [], facts: [], createdAt: Date.now(),
    });
    const res = await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/turns/c9`, headers: { cookie } });
    expect(res.json()).toMatchObject({ ok: true, state: "unconfirmed" });
    await app.close();
  });

  it("running 落盘失败 → 503 E_STORE_FAULT，未开始执行且额度已释放", async () => {
    const { app, deps, turn } = await setup();
    deps.ledger.transitionDurable = async () => {
      throw new Error("disk full");
    };
    const res = await turn("c1");
    expect(res.statusCode).toBe(503);
    expect((res.json() as { code: string }).code).toBe("E_STORE_FAULT");
    expect(deps.ledger.get("c1")?.state).toBe("failed");
    await app.close();
  });
});