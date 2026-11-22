import { describe, expect, it } from "vitest";
import type { ViewPatch, WorldState } from "../../../packages/shared/src/contract/types.ts";
import { positionFromState, turnSuggestions } from "./suggestions.ts";
import { buildCandidates } from "./candidates.ts";

function pos(over: Partial<ViewPatch["position"]> = {}): ViewPatch["position"] {
  return {
    locId: "loc_lib",
    name: "图书馆",
    exits: [],
    actors: [],
    ...over,
  } as ViewPatch["position"];
}

describe("positionFromState（v2 会话事实投影，P2-7）", () => {
  // 只放推导函数需要的字段；类型断言用于测试夹具，不把局部 fixture 当成服务端全量契约。
  const state = {
    room: { scene: { locId: "loc_lib", presentIds: ["plr_self", "npc_lin", "npc_zhou"] } },
    entities: {
      loc_lib: { name: "图书馆" },
      plr_self: { name: "我" },
      npc_lin: { name: "林静" },
      npc_zhou: { name: "周明远" },
    },
  } as unknown as WorldState;

  it("v2 无 view.position 时：用 state.room.scene.presentIds + 展示名推导，不编造出口", () => {
    const p = positionFromState(state, "plr_self");
    expect(p).toMatchObject({ locId: "loc_lib", name: "图书馆" });
    expect(p!.exits).toEqual([]);
    const first = turnSuggestions(p, 1, "plr_self", 5);
    const second = turnSuggestions(p, 2, "plr_self", 5);
    const texts = [...first, ...second].map((s) => s.text);
    expect(texts).toHaveLength(2);
    expect(new Set(texts)).toEqual(new Set(["和林静说话", "和周明远说话"]));
    expect([...first, ...second].every((s) => s.kind === "talk")).toBe(true);
  });

  it("v2 玩过一回合后：候选来自会话事实，不再是开局固定的三条剧本建议（P2-7 验收）", () => {
    const opening = ["去图书馆", "和林静说话", "环顾四周"];
    const afterOnePlayerTurn = buildCandidates(turnSuggestions(positionFromState(state, "plr_self"), 1, "plr_self"));
    expect(afterOnePlayerTurn.map((c) => c.text)).not.toEqual(opening);
    expect(afterOnePlayerTurn.every((c) => !opening.includes(c.text))).toBe(true);
  });

  it("无 state 时返回 undefined；buildPool 通过 round 使用的位置含在场 NPC", () => {
    expect(positionFromState(null, "plr_self")).toBeUndefined();
    const p = positionFromState(state, "plr_self")!;
    expect(p.actors.map((a) => a.name)).toContain("林静");
    expect(p.actors.map((a) => a.actorId)).toContain("npc_lin");
  });
});

describe("turnSuggestions（来源侧带 kind）", () => {
  it("出口 → move，在场 NPC → talk；自己与不在场的人不算", () => {
    const p = pos({
      exits: [{ locId: "loc_lab", name: "实验楼 302" }],
      actors: [
        { actorId: "plr_self", name: "我", present: true },
        { actorId: "npc_lin", name: "林静", present: true },
        { actorId: "npc_zhou", name: "周明远", present: false },
      ],
    });
    // pool=2 时每轮只取 1 条（结构性不重叠）；两轮合起来覆盖出口与在场 NPC 两种来源
    const first = turnSuggestions(p, 1, "plr_self", 5);
    const second = turnSuggestions(p, 2, "plr_self", 5);
    expect([...first, ...second]).toEqual([
      { text: "和林静说话", kind: "talk" },
      { text: "去实验楼 302", kind: "move" },
    ]);
    // 渲染层直通，不重新分类
    expect(buildCandidates([...first, ...second]).map((c) => c.kind)).toEqual(["talk", "move"]);
  });

  it("空场景 → 空数组", () => {
    expect(turnSuggestions(undefined, 1, "self")).toEqual([]);
    expect(turnSuggestions(pos(), 1, "self")).toEqual([]);
  });

  it("相邻回合候选下标不重叠（既有轮转语义不变）", () => {
    const p = pos({
      exits: [
        { locId: "a", name: "A" },
        { locId: "b", name: "B" },
        { locId: "c", name: "C" },
        { locId: "d", name: "D" },
      ],
    });
    const first = turnSuggestions(p, 1, "self", 2);
    const second = turnSuggestions(p, 2, "self", 2);
    expect(first.every((s) => s.kind === "move")).toBe(true);
    expect(second.every((s) => s.kind === "move")).toBe(true);
    expect(new Set([...first, ...second].map((s) => s.text)).size).toBe(4);
  });
});
