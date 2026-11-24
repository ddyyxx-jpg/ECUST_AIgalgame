/**
 * PR #123 P0-B / P1-3 的 HTTP 级回归。
 *
 * 真实链路：Fastify app.inject → routes.ts 的 turn 端点（消费器收到 turn.commit 即 break）
 * → 真实 DefaultTurn / Arbiter / FileStore / AuditGate。审核端口注入"必拦"实现，其余
 * 依赖全部复用 bootstrap 的真实例。断言事件类型、错误码与事件日志计数，不断言文案。
 */
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { tempDir } from "@galgame/testkit";
import { DEFAULT_AUDIT_POLICY } from "../../../packages/engine/src/audit.ts";
import { ModuleHost } from "../../../packages/engine/src/modules.ts";
import { DefaultTurn } from "../../../packages/engine/src/turn.ts";
import type { EventLog } from "../../../packages/engine/src/store.ts";
import type { LlmPort, LlmRequest, LlmResult } from "../../../packages/shared/src/index.ts";
import { createApp } from "./bootstrap.ts";
import type { ServerConfig } from "./config.ts";
import { registerRoutes } from "./routes.ts";
import { RoomBusyError } from "./room-activity.ts";

const ORIGIN = { origin: "https://galgame.test" };

function testConfig(): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: tempDir("galgame-blocked-idem-"),
    contentDir: "content",
    adminToken: "dev-admin",
    trustUserHeader: true,
    llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
    audit: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1000 },
  };
}

async function setup() {
  const deps = await createApp(testConfig());
  const app = Fastify();
  registerRoutes(app, deps);
  const created = await app.inject({ method: "POST", url: "/api/v1/rooms", headers: ORIGIN, payload: { mode: "solo" } });
  expect(created.statusCode).toBe(200);
  const { roomId, actorId } = created.json() as { roomId: string; actorId: string };

  // 只有审核端口换成"必拦"；其他全是 bootstrap 的真实组件，路由的消费器 break 语义保持原样
  const modules = new ModuleHost({ dir: path.join(process.cwd(), "content", "modules") });
  await modules.load();
  const llm: LlmPort = {
    async chat(_req: LlmRequest): Promise<LlmResult> {
      return {
        raw: JSON.stringify({ narrative: "待审叙事", dialogue: "", proposals: [] }),
        usage: { promptTokens: 1, completionTokens: 1, calls: 1 }, model: "blocked-test", latencyMs: 0,
      };
    },
  };
  deps.turn = new DefaultTurn({
    store: deps.store as EventLog,
    arbiter: deps.arbiter,
    registry: deps.registry,
    modules,
    memory: deps.memory,
    llm,
    audit: { review: async () => ({ allow: false, categories: ["violence"], severity: 3, reason: "blocked-test" }) },
    auditPolicy: DEFAULT_AUDIT_POLICY,
  });
  const turn = (clientTurnId: string) => app.inject({
    method: "POST", url: `/api/v1/rooms/${roomId}/turns`,
    headers: ORIGIN, payload: { actorId, input: "你好", clientTurnId },
  });
  return { app, deps, roomId, turn };
}

async function counts(store: EventLog, roomId: string) {
  const envs = await store.events(roomId, 0);
  return {
    markers: envs.filter((e) => e.type === "turn.committed").length,
    memWrites: envs.filter((e) => e.type === "memory.written").length,
    seq: store.seq(roomId),
  };
}

describe("房间锁等待失败", () => {
  it("等锁超时/取消时返回 409，而不是先写 200 SSE 头", async () => {
    const { app, deps, roomId, turn } = await setup();
    deps.roomActivity = {
      acquire: async () => { throw new RoomBusyError(roomId, "等待超时"); },
      tryAcquire: () => null,
      enter: () => () => {},
      isBusy: () => true,
    } as never;
    const res = await turn("c_room_busy");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ ok: false, code: "E_TURN_BUSY" });
  });
});

describe("锁等待失败不留账本副作用（复审 P1-2）", () => {
  it("v1 /turns 等锁失败时 409，且账本没有 reserved/failed 记录", async () => {
    const { app, deps, roomId } = await setup();
    deps.roomActivity = {
      acquire: async () => { throw new RoomBusyError(roomId, "等待超时"); },
      tryAcquire: () => null,
      enter: () => () => {},
      isBusy: () => true,
    } as never;
    const res = await app.inject({
      method: "POST", url: `/api/v1/rooms/${roomId}/turns`,
      headers: { ...ORIGIN, "x-user-id": "u_ledger" },
      payload: { actorId: "plr_1", input: "你好", clientTurnId: "c_lock_no_ledger" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ ok: false, code: "E_TURN_BUSY" });
    expect(deps.ledger?.get({ userId: "u_ledger", roomId, clientTurnId: "c_lock_no_ledger" })).toBeUndefined();
    await app.close();
  });
});

describe("地图写端点与回合共用房间锁（复审 P1-3）", () => {
  it("travel/tick 等锁失败返回 409，而不是绕过锁直接写", async () => {
    const { app, deps, roomId } = await setup();
    deps.roomActivity = {
      acquire: async () => { throw new RoomBusyError(roomId, "等待超时"); },
      tryAcquire: () => null,
      enter: () => () => {},
      isBusy: () => false,
    } as never;
    const travel = await app.inject({
      method: "POST", url: `/api/v1/rooms/${roomId}/map/travel`,
      headers: ORIGIN, payload: { actorId: "plr_1", locId: "loc_library" },
    });
    expect(travel.statusCode).toBe(409);
    expect(travel.json()).toMatchObject({ ok: false, code: "E_TURN_BUSY" });
    const tick = await app.inject({
      method: "POST", url: `/api/v1/rooms/${roomId}/map/tick`,
      headers: ORIGIN, payload: { advance: false },
    });
    expect(tick.statusCode).toBe(409);
    expect(tick.json()).toMatchObject({ ok: false, code: "E_TURN_BUSY" });
    await app.close();
  });
});

describe("审核阻断回合的 HTTP 幂等（PR #123 P0-B / P1-3）", () => {
  it("消费器在 turn.commit 处 break 后同 key 重发：惩罚/记忆/seq 都不再增长", async () => {
    const { app, deps, roomId, turn } = await setup();
    const first = await turn("c_block_http");
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain("turn.commit");
    const before = await counts(deps.store as EventLog, roomId);
    expect(before.markers).toBe(1);
    expect(before.memWrites).toBeGreaterThan(0);

    const second = await turn("c_block_http");
    expect(second.statusCode).toBe(200);
    expect(second.body).toContain("turn.commit");
    expect(await counts(deps.store as EventLog, roomId)).toEqual(before);

    // P1-3：被拦叙事/证据不得进 marker，否则跨重启重建会把违规文本读回 /events
    const marker = (await (deps.store as EventLog).events(roomId, 0)).find((e) => e.type === "turn.committed");
    expect(marker).toBeDefined();
    const payload = marker!.payload as { clientTurnId: string; narrative?: string; facts?: string[] };
    expect(payload.clientTurnId).toBe("c_block_http");
    expect(payload.narrative).toBeUndefined();
    expect(payload.facts).toBeUndefined();
    await app.close();
  });
});
