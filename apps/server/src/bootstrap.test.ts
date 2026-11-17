/**
 * 装配层回归测试：真实 content/ + tempDir 存档。
 *
 * 覆盖三个曾经静默坏掉的点：
 *   ① canon 没写 startLocId 时开场场景必须是 locs[0]（否则建房的 move.to 全部不相邻）；
 *   ② 玩家与 NPC 的开场 located_in / presentIds 必须真的落库；
 *   ③ solo 房 members 为空时 tick 的 playerActorId 仍应是玩家而不是 "system"。
 */
import { describe, expect, it } from "vitest";
import { tempDir } from "@galgame/testkit";
import { createApp } from "./bootstrap.ts";
import type { ServerConfig } from "./config.ts";

function testConfig(): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: tempDir("galgame-bootstrap-test-"),
    contentDir: "content",
    adminToken: "dev-admin",
    trustUserHeader: true,
    llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
    // 审核器不配置 = NoopAudit（放行态），测试不联网
    audit: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1000 },
  };
}

describe("bootstrap", () => {
  it("建房把玩家与 NPC 的初始位置真正写进世界", async () => {
    const deps = await createApp(testConfig());
    const { roomId, actorId } = await deps.createRoom("solo");
    const state = await deps.store.snapshot(roomId);

    expect(state.room.scene.locId).toBe("loc_library");
    expect(state.room.scene.presentIds).toEqual([actorId]);
    for (const npcId of ["npc_zhou", "npc_lin", "npc_ma"]) {
      const link = state.links.find((l) => l.kind === "located_in" && l.from === npcId);
      expect(link?.to, `NPC ${npcId} 的初始 located_in`).toBe("loc_library");
    }
  });

  it("tick 用玩家 actorId 推进日程，且 NPC 真的移动", async () => {
    const deps = await createApp(testConfig());
    const { roomId, actorId } = await deps.createRoom("solo");
    const res = await deps.map.tick(roomId, { advance: true });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.map.clock.phase).toBe("noon");
    expect(res.map.player.actorId).toBe(actorId);
    expect(res.moved.length).toBe(3);
    expect(res.map.npcs.every((n) => n.locId === "loc_canteen")).toBe(true);
  });

  it("建房只播种 public 属性：默认值落库，secret/self 不预填", async () => {
    const deps = await createApp(testConfig());
    const { roomId } = await deps.createRoom("solo");
    const state = await deps.store.snapshot(roomId);

    const me = state.entities["plr_self"];
    expect(me?.attrs.money).toBe(200); // public 默认值落库
    expect(me?.attrs.stamina).toBe(100);

    // secret 绝不预填（guard/debt），self 由玩法写入（trust/mood）
    expect(me?.attrs.guard).toBeUndefined();
    expect(me?.attrs.debt).toBeUndefined();
    expect(me?.attrs.trust).toBeUndefined();
    expect(me?.attrs.mood).toBeUndefined();

    // 隐藏坐标属性也不预填（否则所有地点叠在原点）
    expect(me?.attrs.coord_x).toBeUndefined();
    expect(me?.attrs.coord_y).toBeUndefined();

    const npc = state.entities["npc_lin"];
    expect(npc?.attrs.stamina).toBe(100);
    expect(npc?.attrs.guard).toBeUndefined();
    expect(npc?.attrs.trust).toBeUndefined();
  });
});
