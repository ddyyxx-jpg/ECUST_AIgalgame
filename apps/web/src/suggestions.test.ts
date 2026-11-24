import { describe, expect, it } from "vitest";
import type { ViewPatch, WorldState } from "../../../packages/shared/src/contract/types.ts";
import { candidatePosition, positionFromState, turnSuggestions } from "./suggestions.ts";
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
    room: { scene: { locId: "loc_lib", presentIds: ["plr_self", "npc_lin", "npc_zhou", "loc_lib", "item_book", "npc_gone"] } },
    entities: {
      loc_lib: { id: "loc_lib", kind: "loc", status: "active", name: "图书馆" },
      loc_lab: { id: "loc_lab", kind: "loc", status: "active", name: "实验楼 302" },
      loc_dorm: { id: "loc_dorm", kind: "loc", status: "dormant", name: "宿舍" },
      plr_self: { id: "plr_self", kind: "plr", status: "active", name: "我" },
      npc_lin: { id: "npc_lin", kind: "npc", status: "active", name: "林静" },
      npc_zhou: { id: "npc_zhou", kind: "npc", status: "active", name: "周明远" },
      npc_gone: { id: "npc_gone", kind: "npc", status: "dormant", name: "不在场的人" },
      item_book: { id: "item_book", kind: "item", status: "active", name: "书" },
    },
    links: [
      { kind: "located_in", from: "loc_lab", to: "loc_lib" },
      { kind: "located_in", from: "loc_lib", to: "loc_dorm" },
      { kind: "located_in", from: "npc_lin", to: "loc_lib" },
      { kind: "knows", from: "loc_lib", to: "loc_lab" },
    ],
  } as unknown as WorldState;

  it("v2 无 view.position 时：从 located_in 推导真实出口，只取活跃 NPC 作为在场者", () => {
    const p = positionFromState(state, "plr_self");
    expect(p).toMatchObject({ locId: "loc_lib", name: "图书馆" });
    // 双向邻接成立；dormant loc、NPC→loc、非 located_in 边都不算出口
    expect(p!.exits).toEqual([{ locId: "loc_lab", name: "实验楼 302" }]);
    expect(p!.actors.map((a) => a.actorId)).toEqual(["npc_lin", "npc_zhou"]);
    // pool=2 时每轮只取 1 条（结构性不重叠），三轮轮转覆盖两个在场 NPC
    const rounds = [1, 2, 3].map((r) => turnSuggestions(p, r, "plr_self", 5));
    const all = rounds.flat();
    const texts = all.map((s) => s.text);
    expect(new Set(texts)).toEqual(new Set(["和林静说话", "和周明远说话"]));
    // 场景移动不进候选：走哪扇门由玩家自己操作（试玩反馈）
    expect(texts.some((t) => t.startsWith("去"))).toBe(false);
    expect(texts.some((t) => t.includes("说话") && (t.includes("图书馆") || t.includes("书")))).toBe(false);
  });

  it("v2 玩过一回合后：候选来自会话事实，不再是开局固定的三条剧本建议（P2-7 验收）", () => {
    const opening = ["去图书馆", "和林静说话", "环顾四周"];
    const afterOnePlayerTurn = buildCandidates(turnSuggestions(positionFromState(state, "plr_self"), 1, "plr_self"));
    expect(afterOnePlayerTurn.map((c) => c.text)).not.toEqual(opening);
    // 真实投影含活跃 NPC「林静」，她本来就该可说话；但固定剧本里的「环顾四周」不再出现
    expect(afterOnePlayerTurn.every((c) => c.text !== "环顾四周")).toBe(true);
    expect(afterOnePlayerTurn.every((c) => !c.text.includes("不在场的人") && !c.text.includes("宿舍"))).toBe(true);
  });

  it("无 state 时返回 undefined；buildPool 通过 round 使用的位置含在场 NPC", () => {
    expect(positionFromState(null, "plr_self")).toBeUndefined();
    const p = positionFromState(state, "plr_self")!;
    expect(p.actors.map((a) => a.name)).toContain("林静");
    expect(p.actors.map((a) => a.actorId)).toContain("npc_lin");
  });

  it("P3：presentIds 含地点/物品时不生成「和地点说话」候选", () => {
    const p = positionFromState(state, "plr_self")!;
    const pool = [...turnSuggestions(p, 1, "plr_self", 10), ...turnSuggestions(p, 2, "plr_self", 10)];
    const talks = pool.filter((s) => s.kind === "talk").map((s) => s.text);
    expect([...talks].sort()).toEqual(["和林静说话", "和周明远说话"].sort());
    // 地点/物品即使出现在 presentIds 里也不能变成「和地点说话」
    expect(talks.some((t) => t.includes("图书馆") || t.includes("纸条"))).toBe(false);
  });

  it("P2-2：pos 的 actors/exits 皆空但 state 可推导时，用 state 推导结果；有效 pos 不覆盖", () => {
    const empty = pos();
    const picked = candidatePosition(empty, state, "plr_self");
    expect(picked).toEqual(positionFromState(state, "plr_self"));
    const real = pos({ exits: [{ locId: "loc_custom", name: "自定义地点" }] });
    expect(candidatePosition(real, state, "plr_self")).toBe(real);
    expect(candidatePosition(undefined, null, "plr_self")).toBeUndefined();
  });
});

describe("turnSuggestions（来源侧带 kind）", () => {
  it("只给在场 NPC 的 talk 候选；出口与不在场/自己都不算", () => {
    const p = pos({
      exits: [{ locId: "loc_lab", name: "实验楼 302" }],
      actors: [
        { actorId: "plr_self", name: "我", present: true },
        { actorId: "npc_lin", name: "林静", present: true },
        { actorId: "npc_zhou", name: "周明远", present: false },
      ],
    });
    // 池里只剩 1 条 talk：每轮都给同一句（无法再拆），但绝不出现 move
    expect(turnSuggestions(p, 1, "plr_self", 5)).toEqual([{ text: "和林静说话", kind: "talk" }]);
    expect(turnSuggestions(p, 2, "plr_self", 5)).toEqual([{ text: "和林静说话", kind: "talk" }]);
    // 渲染层直通，不重新分类
    expect(buildCandidates(turnSuggestions(p, 1, "plr_self", 5)).map((c) => c.kind)).toEqual(["talk"]);
  });

  it("空场景 → 空数组", () => {
    expect(turnSuggestions(undefined, 1, "self")).toEqual([]);
    expect(turnSuggestions(pos(), 1, "self")).toEqual([]);
  });

  it("相邻回合候选下标不重叠（既有轮转语义不变）", () => {
    const p = pos({
      actors: [
        { actorId: "npc_a", name: "A", present: true },
        { actorId: "npc_b", name: "B", present: true },
        { actorId: "npc_c", name: "C", present: true },
        { actorId: "npc_d", name: "D", present: true },
      ],
    });
    const first = turnSuggestions(p, 1, "self", 2);
    const second = turnSuggestions(p, 2, "self", 2);
    expect(first.every((s) => s.kind === "talk")).toBe(true);
    expect(second.every((s) => s.kind === "talk")).toBe(true);
    expect(new Set([...first, ...second].map((s) => s.text)).size).toBe(4);
  });
});

describe("candidatePosition（travel 后的过期位置，PR #149 复审 P2-2）", () => {
  it("pos 与权威 state 不在同一场景：用 state 投影，而不是旧地点的 NPC/出口", () => {
    const stale = pos({ locId: "loc_lab", name: "实验楼 302", actors: [{ actorId: "npc_old", name: "旧地点的人", present: true }] });
    const state2 = {
      room: { scene: { locId: "loc_lib", presentIds: ["plr_self", "npc_lin"] } },
      entities: {
        loc_lib: { id: "loc_lib", kind: "loc", status: "active", name: "图书馆" },
        plr_self: { id: "plr_self", kind: "plr", status: "active", name: "我" },
        npc_lin: { id: "npc_lin", kind: "npc", status: "active", name: "林静" },
      },
      links: [],
    } as unknown as WorldState;
    const p = candidatePosition(stale, state2, "plr_self");
    expect(p?.locId).toBe("loc_lib");
    expect(p?.actors.map((a) => a.actorId)).toEqual(["npc_lin"]);
  });

  it("pos 与 state 同场景且非空：保留服务端下发的 pos", () => {
    const same = pos({ actors: [{ actorId: "npc_lin", name: "林静", present: true }] });
    const here = { room: { scene: { locId: "loc_lib", presentIds: ["plr_self"] } }, entities: {}, links: [] } as unknown as WorldState;
    expect(candidatePosition(same, here, "plr_self")).toBe(same);
  });
});
