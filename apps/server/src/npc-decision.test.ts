import { describe, expect, it } from "vitest";
import type { WorldState } from "../../../packages/shared/src/contract/types.ts";
import {
  NpcDecisionService,
  buildDecisionOptions,
  buildPerception,
  fallbackChoice,
  parseDecision,
} from "./npc-decision.ts";

function state(overrides: Partial<WorldState> = {}): WorldState {
  return {
    schemaVersion: 2,
    room: {
      id: "room_a",
      mode: "solo",
      worldId: "w",
      members: [{ actorId: "plr", role: "player", joinedSeq: 1 }],
      scene: { locId: "loc_player", presentIds: ["plr"] },
      createdAt: 1,
      lastActiveAt: 1,
    },
    entities: {
      loc_a: { id: "loc_a", kind: "loc", name: "图书馆", attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 },
      loc_b: { id: "loc_b", kind: "loc", name: "食堂", attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 },
      loc_c: { id: "loc_c", kind: "loc", name: "宿舍", attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 },
      loc_player: { id: "loc_player", kind: "loc", name: "操场", attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 },
      npc_1: { id: "npc_1", kind: "npc", name: "林静", attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 },
      plr: { id: "plr", kind: "plr", name: "你", attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 },
    },
    links: [
      { id: "l1", kind: "located_in", from: "loc_a", to: "loc_b", createdAt: 0 },
      { id: "l2", kind: "located_in", from: "loc_b", to: "loc_c", createdAt: 0 },
      { id: "l3", kind: "located_in", from: "npc_1", to: "loc_a", createdAt: 0 },
      { id: "l4", kind: "located_in", from: "plr", to: "loc_player", createdAt: 0 },
    ],
    clock: { day: 1, phase: "morning", tick: 0 },
    plots: [],
    moduleState: {},
    ...overrides,
  };
}

describe("npc-decision 纯函数", () => {
  it("菜单只给留下 + 相邻地点；感知只含公开信息", () => {
    const options = buildDecisionOptions(state(), "npc_1", 4);
    expect(options.map((o) => o.locId)).toEqual(["loc_a", "loc_b"]);
    const perception = buildPerception(state(), "npc_1", options)!;
    expect(perception.text).toContain("图书馆");
    expect(perception.text).toContain("1. 留在图书馆");
    expect(perception.text).not.toContain("secret");
  });

  it("解析 1-based choice；坏 JSON/越界返回 null；fallback 确定性", () => {
    expect(parseDecision({ choice: 2, reason: "去吃饭" }, 2)).toEqual({ choice: 2, reason: "去吃饭" });
    expect(parseDecision('```json\n{"choice":1}\n```', 2)).toEqual({ choice: 1 });
    expect(parseDecision({ choice: 3 }, 2)).toBeNull();
    expect(parseDecision("not json", 2)).toBeNull();
    const s = state();
    expect(fallbackChoice("room_a", "npc_1", s, 3)).toBe(fallbackChoice("room_a", "npc_1", s, 3));
    expect(fallbackChoice("room_a", "npc_1", s, 3)).toBeGreaterThanOrEqual(0);
    expect(fallbackChoice("room_a", "npc_1", s, 3)).toBeLessThan(3);
  });
});

describe("NpcDecisionService", () => {
  it("开启后调用一次模型并把选择写成 move 租约", async () => {
    const applied: unknown[] = [];
    const service = new NpcDecisionService({
      store: { snapshot: async () => state() },
      arbiter: { apply: async (_room, ops) => { applied.push(ops); return { ok: true }; } },
      llm: {
        chat: async () => ({ raw: '{"choice":2}', json: { choice: 2 }, usage: { promptTokens: 1, completionTokens: 1, calls: 1 }, model: "fake", latencyMs: 1 }),
      },
      policy: { enabled: true, maxPerBeat: 1, intervalTicks: 1, hourlyCalls: 10, maxOptions: 4 },
    });
    await service.run("room_a", state());
    expect(applied).toHaveLength(1);
    const ops = applied[0] as { args: { entityId: string; key: string; value: string } }[];
    expect(ops[0].args.entityId).toBe("npc_1");
    expect(ops[0].args.key).toBe("sim_lease");
    expect(JSON.parse(ops[0].args.value)).toMatchObject({ action: "move", target: "loc_b", phase: "morning" });
  });

  it("关闭时不调模型、不写状态", async () => {
    let calls = 0;
    const service = new NpcDecisionService({
      store: { snapshot: async () => state() },
      arbiter: { apply: async () => { throw new Error("should not write"); } },
      llm: { chat: async () => { calls += 1; throw new Error("should not call"); } },
      policy: { enabled: false, maxPerBeat: 1, intervalTicks: 1, hourlyCalls: 10, maxOptions: 4 },
    });
    await service.run("room_a", state());
    expect(calls).toBe(0);
  });
});
