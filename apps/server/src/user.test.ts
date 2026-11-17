/**
 * P2 用户库：账号维度贯通（建房成员 / 回合请求 / 档案视图）。
 * 断言的是"哪个 userId 能看到哪份记忆"，不是文案。
 */
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { tempDir } from "@galgame/testkit";
import type { TurnEvent } from "../../../packages/shared/src/index.ts";
import { createApp, type App } from "./bootstrap.ts";
import type { ServerConfig } from "./config.ts";
import { registerRoutes } from "./routes.ts";

function testConfig(): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: tempDir("galgame-user-test-"),
    contentDir: "content",
    adminToken: "dev-admin",
    trustUserHeader: true,
    llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
    audit: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1000 },
  };
}

/** 把玩家"走到"某个 NPC 面前（地图模块的真实做法也是 scene.set） */
async function focusNpc(deps: App, roomId: string, npcId: string): Promise<void> {
  const events = await deps.store.events(roomId, 0);
  const seq = events.length ? events[events.length - 1]!.seq : 0;
  const res = await deps.arbiter.apply(
    roomId,
    [{ op: "scene.set", args: { locId: "loc_library", presentIds: ["plr_self", npcId] }, reason: "走近" }],
    { v: 1, id: "evt_focus", roomId, seq: seq + 1, ts: Date.now(), actorId: "system", type: "map.focus", payload: {} },
  );
  expect(res.ok).toBe(true);
}

async function collect(it: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe("用户维度（P2）", () => {
  it("建房把 userId 写进成员表（solo 就是只有 1 个成员的合作房）", async () => {
    const deps = await createApp(testConfig());
    const { roomId } = await deps.createRoom("solo", "u_a");
    const state = await deps.store.snapshot(roomId);
    const member = state.room.members.find((m) => m.actorId === "plr_self");
    expect(member?.role).toBe("player");
    expect(member?.userId).toBe("u_a");
  });

  it("回合写入的记忆带 userId；另一个账号的档案是空的（私忆隔离）", async () => {
    const deps = await createApp(testConfig());
    const { roomId } = await deps.createRoom("solo", "u_a");
    await focusNpc(deps, roomId, "npc_lin");
    const evs = await collect(deps.turn.run({ roomId, actorId: "plr_self", input: "你好", clientTurnId: "c1", userId: "u_a" }));
    expect(evs.at(-1)?.type).toBe("turn.commit");

    const events = await deps.store.events(roomId, 0);
    const memories = events.filter((e) => e.type === "memory.written");
    expect(memories.length).toBeGreaterThan(0);
    expect(memories.every((e) => (e.payload as { userId?: string }).userId === "u_a")).toBe(true);

    const mine = await deps.memory.profile("u_a", "npc_lin", roomId);
    expect(mine).not.toBeNull();
    expect(mine?.impressions).toBe(0);
    expect(mine?.lastTopics.length).toBeGreaterThan(0);
    expect(await deps.memory.profile("u_b", "npc_lin", roomId)).toBeNull();
  });

  it("GET /api/v1/me：没有 X-User-Id 报 schema 错；带了对应用户返回档案", async () => {
    const deps = await createApp(testConfig());
    const { roomId } = await deps.createRoom("solo", "u_a");
    await focusNpc(deps, roomId, "npc_lin");
    await collect(deps.turn.run({ roomId, actorId: "plr_self", input: "你好", clientTurnId: "c1", userId: "u_a" }));

    const app = Fastify();
    registerRoutes(app, deps);
    const missing = await app.inject({ method: "GET", url: `/api/v1/me?roomId=${roomId}&actorId=npc_lin` });
    expect(missing.statusCode).toBe(400);

    const ok = await app.inject({
      method: "GET",
      url: `/api/v1/me?roomId=${roomId}&actorId=npc_lin`,
      headers: { "x-user-id": "u_a" },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { ok: boolean; userId: string; profile: { familiarity: number } | null };
    expect(body.userId).toBe("u_a");
    expect(body.profile).not.toBeNull();
    await app.close();
  });
});
