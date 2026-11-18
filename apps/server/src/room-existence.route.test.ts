/**
 * issue #37：房间存在性回归。
 *
 * `FileStore.snapshot` 对未知 roomId 返回初始 WorldState（不抛错），
 * 旧路由因此会 200 + 空状态，map/tick 还会写出没有 seed/members 的幽灵日志。
 * 这里断言：所有读/写房间端点先认 `listRooms()` 的持久化事实，未知房间一律
 * 404 E_ROOM_NOT_FOUND，且不落盘；既有房间 / 世界层边界不受影响。
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { tempDir } from "@galgame/testkit";
import { createApp } from "./bootstrap.ts";
import { registerRoutes } from "./routes.ts";
import { roomExists } from "./room-existence.ts";
import type { ServerConfig } from "./config.ts";

const MISSING = "room_missing_test";

function testConfig(dataDir: string): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir,
    contentDir: "content",
    adminToken: "dev-admin",
    trustUserHeader: true,
    llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
    audit: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1000 },
  };
}

async function makeApp() {
  const dataDir = tempDir("galgame-existence-");
  const deps = await createApp(testConfig(dataDir));
  const app = Fastify();
  registerRoutes(app, deps);
  await app.ready();
  const roomsDir = path.join(dataDir, "rooms");
  return { app, deps, dataDir, roomsDir, ghostLog: path.join(roomsDir, `${MISSING}.jsonl`) };
}

describe("房间存在性（issue #37）", () => {
  it("未知房间的只读端点一律 404 E_ROOM_NOT_FOUND，且不存在房间列表里", async () => {
    const { app, deps, ghostLog } = await makeApp();
    const paths = [
      `/api/v1/rooms/${MISSING}/state`,
      `/api/v1/rooms/${MISSING}/events`,
      `/api/v1/rooms/${MISSING}/history`,
      `/api/v1/rooms/${MISSING}/gallery`,
      `/api/v1/rooms/${MISSING}/map`,
    ];
    for (const url of paths) {
      const res = await app.inject({ method: "GET", url, headers: { "x-user-id": "u_a" } });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toMatchObject({ ok: false, code: "E_ROOM_NOT_FOUND" });
    }
    const lister = deps.store as unknown as { listRooms(): Promise<string[]> };
    expect(await lister.listRooms()).not.toContain(MISSING);
    expect(existsSync(ghostLog)).toBe(false);
    await app.close();
  });

  it("未知房间的写入端点全部 404：不创建日志、不追加事件（seq 不变）", async () => {
    const { app, deps, roomsDir, ghostLog } = await makeApp();
    const seqOf = (deps.store as unknown as { seq(roomId: string): number }).seq.bind(deps.store);
    expect(seqOf(MISSING)).toBe(0);
    expect(existsSync(ghostLog)).toBe(false);

    const writes: { url: string; payload: Record<string, unknown> }[] = [
      { url: `/api/v1/rooms/${MISSING}/map/tick`, payload: { advance: true } },
      { url: `/api/v1/rooms/${MISSING}/map/travel`, payload: { locId: "loc_lib" } },
      { url: `/api/v1/rooms/${MISSING}/map/dialogue`, payload: { sceneId: "loc_lib", dialogueId: "d1" } },
      { url: `/api/v1/rooms/${MISSING}/turns`, payload: { actorId: "plr_x", input: "看看四周", clientTurnId: "c1" } },
    ];
    for (const { url, payload } of writes) {
      const res = await app.inject({ method: "POST", url, payload, headers: { "x-user-id": "u_a" } });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toMatchObject({ ok: false, code: "E_ROOM_NOT_FOUND" });
    }

    expect(seqOf(MISSING)).toBe(0);
    expect(await deps.store.events(MISSING, 0)).toEqual([]);
    expect(existsSync(ghostLog)).toBe(false);
    // 目录可能压根没建（更强的证据：连 rooms/ 都没碰过）
    expect(!existsSync(roomsDir) || !readdirSync(roomsDir).some((name) => name.startsWith(MISSING))).toBe(true);
    await app.close();
  });

  it("helper 只认持久化的房间列表：snapshot 成功不算存在，世界房间一律 false", async () => {
    const state = { room: { members: [{ actorId: "plr_x" }] } } as never;
    expect(await roomExists({ listRooms: async () => [], snapshot: async () => state }, MISSING)).toBe(false);
    expect(await roomExists({ listRooms: async () => [MISSING] }, MISSING)).toBe(true);
    expect(await roomExists({ listRooms: async () => { throw new Error("list down"); } }, MISSING)).toBe(false);
    expect(await roomExists({}, MISSING)).toBe(false);
    expect(await roomExists({ listRooms: async () => ["room_world_x"] }, "room_world_x")).toBe(false);
  });

  it("既有房间的 state/events/history/map/tick/turns 仍正常，世界层房间仍 404", async () => {
    const { app, deps } = await makeApp();
    const created = await app.inject({ method: "POST", url: "/api/v1/rooms", headers: { "x-user-id": "u_a" }, payload: { mode: "solo" } });
    expect(created.statusCode).toBe(200);
    const { roomId, actorId } = created.json() as { roomId: string; actorId: string };

    const state = await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/state` });
    expect(state.statusCode).toBe(200);
    expect((state.json() as { room: { id: string } }).room.id).toBe(roomId);

    const events = await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/events` });
    expect(events.statusCode).toBe(200);
    expect((events.json() as { events: unknown[] }).events.length).toBeGreaterThan(0);

    const history = await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/history`, headers: { "x-user-id": "u_a" } });
    expect(history.statusCode).toBe(200);

    const map = await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/map` });
    expect(map.statusCode).toBe(200);
    expect((map.json() as { ok: boolean }).ok).toBe(true);

    const seqOf = (deps.store as unknown as { seq(roomId: string): number }).seq.bind(deps.store);
    const before = seqOf(roomId);
    const tick = await app.inject({ method: "POST", url: `/api/v1/rooms/${roomId}/map/tick`, payload: { advance: true } });
    expect(tick.statusCode).toBe(200);
    expect((tick.json() as { ok: boolean }).ok).toBe(true);
    expect(seqOf(roomId)).toBeGreaterThan(before);

    const turn = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/turns`,
      headers: { "x-user-id": "u_a" },
      payload: { actorId, input: "看看四周", clientTurnId: "c1" },
    });
    expect(turn.statusCode).toBe(200);
    expect(turn.body).toContain("event: turn.commit");

    for (const url of [`/api/v1/rooms/${deps.worldRoom}/state`, `/api/v1/rooms/${deps.worldRoom}/map`]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toMatchObject({ ok: false, code: "E_ROOM_NOT_FOUND" });
    }
    const worldTick = await app.inject({ method: "POST", url: `/api/v1/rooms/${deps.worldRoom}/map/tick`, payload: { advance: true } });
    expect(worldTick.statusCode).toBe(404);
    await app.close();
  });
});
