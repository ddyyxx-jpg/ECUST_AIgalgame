/**
 * 房间存在性守卫回归测试（issue #37）。
 *
 * 之前：`FileStore.snapshot` 对未知房间返回空 WorldState（不抛错），所以
 * `/state` 200、`/map/tick` 甚至会把幽灵日志写进磁盘。这里用真实 `FileStore`
 * + 临时目录从 HTTP 层验证：未知房间的所有房间入口一律 404，且无日志落盘；
 * 已有房间不受影响。
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { tempDir } from "@galgame/testkit";
import type { Store } from "../../../packages/shared/src/contract/types.ts";
import { createApp } from "./bootstrap.ts";
import type { App } from "./bootstrap.ts";
import type { ServerConfig } from "./config.ts";
import { registerRoutes } from "./routes.ts";

function testConfig(): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: tempDir("galgame-room-guard-"),
    contentDir: "content",
    adminToken: "dev-admin",
    trustUserHeader: true,
    llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
    audit: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1000 },
  };
}

async function appWith(): Promise<{ app: FastifyInstance; deps: App; cfg: ServerConfig }> {
  const cfg = testConfig();
  const deps = await createApp(cfg);
  const app = Fastify();
  registerRoutes(app, deps);
  return { app, deps, cfg };
}

/** FileStore 的 listRooms 是引擎内部能力，不在 Store 契约里 */
function listRooms(deps: App): Promise<string[]> {
  return (deps.store as Store & { listRooms: () => Promise<string[]> }).listRooms();
}

describe("房间存在性守卫（issue #37）", () => {
  it("未知房间的所有房间入口一律 404 E_ROOM_NOT_FOUND，且不会隐式落盘", async () => {
    const { app, deps, cfg } = await appWith();
    const missing = "room_missing_0001";
    const before = await listRooms(deps);

    const cases: { method: "GET" | "POST"; url: string; payload?: object }[] = [
      { method: "GET", url: `/api/v1/rooms/${missing}/state` },
      { method: "GET", url: `/api/v1/rooms/${missing}/events` },
      { method: "GET", url: `/api/v1/rooms/${missing}/map` },
      { method: "GET", url: `/api/v1/rooms/${missing}/history` },
      { method: "POST", url: `/api/v1/rooms/${missing}/turns`, payload: { actorId: "plr_self", input: "看看", clientTurnId: "c1" } },
      { method: "POST", url: `/api/v1/rooms/${missing}/map/travel`, payload: { actorId: "plr_self", locId: "loc_library" } },
      { method: "POST", url: `/api/v1/rooms/${missing}/map/tick`, payload: { advance: true } },
      { method: "POST", url: `/api/v1/rooms/${missing}/map/dialogue`, payload: { actorId: "plr_self", sceneId: "loc_library", dialogueId: "dlg_x" } },
    ];
    for (const c of cases) {
      const res = await app.inject({ method: c.method, url: c.url, ...(c.payload ? { payload: c.payload } : {}) });
      expect({ url: c.url, status: res.statusCode }).toEqual({ url: c.url, status: 404 });
      expect(res.json()).toMatchObject({ ok: false, code: "E_ROOM_NOT_FOUND" });
    }

    // 持久化事实：房间表没变、rooms/ 目录里没有幽灵日志
    expect(await listRooms(deps)).toEqual(before);
    expect(await listRooms(deps)).not.toContain(missing);
    const roomsDir = path.join(path.resolve(cfg.dataDir), "rooms");
    const files = existsSync(roomsDir) ? await readdir(roomsDir) : [];
    expect(files).not.toContain(`${missing}.jsonl`);
    await app.close();
  });

  it("世界层房间的地图端点同样 404，不写世界记忆日志", async () => {
    const { app } = await appWith();
    const world = "room_world_test_world";
    for (const url of [`/api/v1/rooms/${world}/map`, `/api/v1/rooms/${world}/state`]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: "E_ROOM_NOT_FOUND" });
    }
    await app.close();
  });

  it("已有房间不受影响：state/map/tick 正常，tick 真的落库", async () => {
    const { app, deps } = await appWith();
    const created = await app.inject({ method: "POST", url: "/api/v1/rooms", payload: { mode: "solo" } });
    expect(created.statusCode).toBe(200);
    const roomId = (created.json() as { roomId: string }).roomId;

    const state = await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/state` });
    expect(state.statusCode).toBe(200);
    expect((state.json() as { room: { scene: { locId: string } } }).room.scene.locId).toBe("loc_library");

    const map = await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/map` });
    expect(map.statusCode).toBe(200);

    const tick = await app.inject({ method: "POST", url: `/api/v1/rooms/${roomId}/map/tick`, payload: { advance: true } });
    expect(tick.statusCode).toBe(200);
    expect(tick.json()).toMatchObject({ ok: true });
    expect((await deps.store.snapshot(roomId)).clock.phase).toBe("noon");

    // 对未知房间的调用不会在房间表里留下任何东西
    await app.inject({ method: "POST", url: "/api/v1/rooms/room_nope_1/map/tick", payload: { advance: true } });
    expect(await listRooms(deps)).not.toContain("room_nope_1");
    await app.close();
  });
});
