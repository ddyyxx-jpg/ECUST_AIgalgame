import { describe, expect, it } from "vitest";
import type { WorldState } from "../../shared/src/contract/types.ts";
import { buildTurnPrompt } from "./turn.prompt.ts";

const state: WorldState = {
  schemaVersion: 2,
  room: {
    id: "room_prompt",
    mode: "solo",
    worldId: "world_campus",
    members: [{ actorId: "plr_me", role: "player", joinedSeq: 1 }],
    scene: { locId: "loc_lib", presentIds: ["plr_me"] },
    createdAt: 1,
    lastActiveAt: 1,
  },
  entities: {
    loc_lib: { id: "loc_lib", kind: "loc", name: "图书馆", attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 },
    plr_me: { id: "plr_me", kind: "plr", name: "你", attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 },
  },
  links: [],
  clock: { day: 1, phase: "morning", tick: 0 },
  plots: [],
  moduleState: {},
};

describe("buildTurnPrompt · 作者注 / 世界设定", () => {
  it("作者注在稳定前缀，worldInfo 按传入顺序成段；缺省时两段都不出现", () => {
    const withExtra = buildTurnPrompt(state, "plr_me", "去图书馆", {
      authorNote: "保持克制",
      worldInfo: ["22:00 闭馆", "二楼不开放"],
    });
    expect(withExtra).toContain("【作者注】保持克制");
    expect(withExtra).toContain("【世界设定·关键词触发】\n- 22:00 闭馆\n- 二楼不开放");
    const plain = buildTurnPrompt(state, "plr_me", "去图书馆");
    expect(plain).not.toContain("【作者注】");
    expect(plain).not.toContain("【世界设定·关键词触发】");
  });
});
