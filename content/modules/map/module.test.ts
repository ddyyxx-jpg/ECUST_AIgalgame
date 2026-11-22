/**
 * map 模块行为契约（docs/06 §3 / §8）。断言 Proposal 的结构与 facts 里的结构信息，
 * 不断言叙事文案；地图状态用 testkit 手搭（makeRoom 本身没有 loc 实体）。
 */
import { describe, expect, it } from "vitest";
import { OP_NAMES, type AttrDef, type Entity, type Link, type Proposal, type WorldState } from "@galgame/shared";
import { SELF_ID, makeCtx, makeRegistry, makeRoom } from "@galgame/testkit";
import mod from "./module";
const registry = makeRegistry([
  { key: "coord_x", type: "number", scope: ["loc", "npc", "plr"], min: 0, max: 2000, default: 0, visibility: "public", display: { label: "X", hidden: true } },
  { key: "coord_y", type: "number", scope: ["loc", "npc", "plr"], min: 0, max: 2000, default: 0, visibility: "public", display: { label: "Y", hidden: true } },
] satisfies AttrDef[]);

const COORDS: Record<string, { x: number; y: number }> = {
  loc_classroom: { x: 80, y: 600 },
  loc_library: { x: 260, y: 180 },
  loc_teaching_1: { x: 520, y: 140 },
  loc_canteen: { x: 560, y: 360 },
  loc_dorm3: { x: 240, y: 520 },
  loc_playground: { x: 760, y: 260 },
  loc_isolated: { x: 900, y: 620 },
};
const NAMES: Record<string, string> = {
  loc_classroom: "教室",
  loc_library: "图书馆",
  loc_teaching_1: "第一教学楼",
  loc_canteen: "一食堂",
  loc_dorm3: "宿舍 3 号楼",
  loc_playground: "操场",
  loc_isolated: "孤岛",
};

function entity(id: string, kind: Entity["kind"], name: string, attrs: Entity["attrs"] = {}): Entity {
  return { id, kind, name, attrs, tags: [], origin: "seed", canon: false, status: "active", createdAt: 0, updatedAt: 0 };
}

function loc(id: string): Entity {
  const c = COORDS[id]!;
  return entity(id, "loc", NAMES[id] ?? id, { coord_x: c.x, coord_y: c.y });
}

let linkSeq = 0;
function located(from: string, to: string): Link {
  return { id: `link_test_${++linkSeq}`, kind: "located_in", from, to, createdAt: 0 };
}

/**
 * 手搭地图（与 canon 同 id、便于对照数据里的坐标/描述）：
 * classroom — library — canteen — playground；canteen — teaching_1 — dorm3。
 */
function buildRoom(): WorldState {
  const state = makeRoom();
  for (const id of Object.keys(COORDS)) state.entities[id] = loc(id);
  state.entities["npc_ma"] = entity("npc_ma", "npc", "马骁");
  state.entities[SELF_ID] = { ...state.entities[SELF_ID]!, attrs: { coord_x: 80, coord_y: 600 } };
  // testkit 的默认名字不是 canon 名；统一成场景数据里的名字，断言只依赖数据
  state.entities["npc_lin"]!.name = "林静";
  state.entities["npc_zhou"]!.name = "周明远";
  state.links = [
    located("loc_classroom", "loc_library"),
    located("loc_library", "loc_canteen"),
    located("loc_canteen", "loc_playground"),
    located("loc_canteen", "loc_teaching_1"),
    located("loc_teaching_1", "loc_dorm3"),
    located("npc_lin", "loc_library"),
    located("npc_zhou", "loc_teaching_1"),
    located("npc_ma", "loc_playground"),
  ];
  state.room.scene = { locId: "loc_classroom", presentIds: [SELF_ID] };
  return state;
}

function ctxOf(state: WorldState, input = "") {
  return makeCtx({ state, registry, input });
}

function moveLocs(proposals: Proposal[]): string[] {
  return proposals.filter((p) => p.op === "move.to").map((p) => String(p.args.locId));
}

function movesOf(proposals: Proposal[], actorId: string): string[] {
  return proposals.filter((p) => p.op === "move.to" && p.args.actorId === actorId).map((p) => String(p.args.locId));
}

function expectLegalOps(proposals: Proposal[]): void {
  for (const p of proposals) expect(OP_NAMES, `非法 op: ${p.op}`).toContain(p.op);
}

describe("map.travel", () => {
  it("多跳：沿 located_in 逐跳 move.to，末跳是目标，末尾写坐标并恢复镜头", async () => {
    const state = buildRoom();
    const out = await mod.intent!(ctxOf(state, "map.travel loc_playground"));
    expect(out.ok).toBe(true);
    expectLegalOps(out.proposals);
    expect(out.proposals.map((p) => p.op)).toEqual(["move.to", "move.to", "move.to", "attr.set", "attr.set", "scene.set"]);
    expect(moveLocs(out.proposals)).toEqual(["loc_library", "loc_canteen", "loc_playground"]);
    expect(out.proposals[0]!.args.actorId).toBe(SELF_ID);
    const sets = out.proposals.filter((p) => p.op === "attr.set");
    expect(sets.map((p) => [p.args.entityId, p.args.key, p.args.value])).toEqual([
      [SELF_ID, "coord_x", 4860],
      [SELF_ID, "coord_y", 3130],
    ]);
    const scene = out.proposals.at(-1)!;
    expect(scene.op).toBe("scene.set");
    expect(scene.args).toMatchObject({ locId: "loc_playground", presentIds: [SELF_ID, "npc_ma"] });
  });

  it("tool 入口：map.travel 用 args.locId，行为与文本入口一致", async () => {
    const out = await mod.tool!("map.travel", { locId: "loc_playground" }, ctxOf(buildRoom()));
    expect(out.ok).toBe(true);
    expect(moveLocs(out.proposals)).toEqual(["loc_library", "loc_canteen", "loc_playground"]);
    expect(out.proposals.at(-1)!.op).toBe("scene.set");
  });

  it("中文输入：去一食堂 按名字解析目标", async () => {
    const out = await mod.intent!(ctxOf(buildRoom(), "去一食堂"));
    expect(out.ok).toBe(true);
    expectLegalOps(out.proposals);
    expect(moveLocs(out.proposals)).toEqual(["loc_library", "loc_canteen"]);
    expect(out.proposals.filter((p) => p.op === "attr.set").map((p) => p.args.value)).toEqual([5260, 2220]);
    expect(out.proposals.at(-1)!.args).toMatchObject({ locId: "loc_canteen", presentIds: [SELF_ID] });
  });

  it("同点：不产任何 op、不抛错", async () => {
    const state = buildRoom();
    const before = JSON.stringify(state);
    const out = await mod.intent!(ctxOf(state, "map.travel loc_classroom"));
    expect(out).toMatchObject({ ok: true, proposals: [] });
    expect(out.facts?.length).toBeGreaterThan(0);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("不可达：ok:true + 空 proposals，不产非法 op", async () => {
    const out = await mod.intent!(ctxOf(buildRoom(), "map.travel loc_isolated"));
    expect(out).toMatchObject({ ok: true, proposals: [] });
    expectLegalOps(out.proposals);
  });

  it("未知地点：弃权（ok:false）而不是抛错，让别的模块接手", async () => {
    const out = await mod.intent!(ctxOf(buildRoom(), "map.travel loc_atlantis"));
    expect(out).toMatchObject({ ok: false, proposals: [] });
    expect(out.error?.code).toBe("E_REF_NOT_FOUND");
  });

  it("裸关键词 travel：引擎只按英文关键词派发，模块也要认", async () => {
    const out = await mod.intent!(ctxOf(buildRoom(), "travel loc_playground"));
    expect(out.ok).toBe(true);
    expect(moveLocs(out.proposals)).toEqual(["loc_library", "loc_canteen", "loc_playground"]);
  });

  it("tool 调用缺 locId 且输入里也没有地点：弃权而不是随便挑一个", async () => {
    const out = await mod.tool!("map.travel", {}, ctxOf(buildRoom()));
    expect(out).toMatchObject({ ok: false, proposals: [] });
    expect(out.error?.code).toBe("E_REF_NOT_FOUND");
  });
});

describe("map.look", () => {
  it("返回场景名/坐标/描述/在场者/可做链接，且不产 Proposal、不改状态", async () => {
    const state = buildRoom();
    state.room.scene = { locId: "loc_library", presentIds: [SELF_ID, "npc_lin"] };
    const before = JSON.stringify(state);
    const out = await mod.intent!(ctxOf(state, "map.look"));
    expect(out).toMatchObject({ ok: true, proposals: [] });
    const facts = out.facts ?? [];
    expect(facts[0]).toContain("图书馆");
    expect(facts[0]).toContain("(3220,2320)");
    expect(facts[0]).toContain("旧馆三层");
    expect(facts[1]).toContain("林静");
    expect(facts[2]).toContain("馆内小卖部(module)");
    expect(JSON.stringify(state)).toBe(before);
  });

  it("裸关键词 look：不产 Proposal，facts 有场景名", async () => {
    const state = buildRoom();
    state.room.scene = { locId: "loc_library", presentIds: [SELF_ID, "npc_lin"] };
    const out = await mod.intent!(ctxOf(state, "look"));
    expect(out).toMatchObject({ ok: true, proposals: [] });
    expect((out.facts ?? [])[0]).toContain("图书馆");
  });
});

describe("tick（NPC 日程）", () => {
  it("night：三个 NPC 各自沿最短路移动、坐标落到终点，末尾 scene.set 保住玩家镜头", async () => {
    const state = buildRoom();
    const out = await mod.tick!(ctxOf(state), "night");
    expectLegalOps(out);
    expect(movesOf(out, "npc_zhou")).toEqual(["loc_dorm3"]);
    expect(movesOf(out, "npc_lin")).toEqual(["loc_canteen", "loc_teaching_1", "loc_dorm3"]);
    expect(movesOf(out, "npc_ma")).toEqual(["loc_canteen", "loc_teaching_1", "loc_dorm3"]);
    // 每个 NPC 的最终坐标 = 终点场景坐标（dorm3 240,520）
    for (const npcId of ["npc_zhou", "npc_lin", "npc_ma"]) {
      const sets = out.filter((p) => p.op === "attr.set" && p.args.entityId === npcId);
      expect(sets.slice(-2).map((p) => [p.args.key, p.args.value])).toEqual([
        ["coord_x", 4300],
        ["coord_y", 1650],
      ]);
    }
    // 镜头保护：最后一条必须是玩家所在地，presentIds 只含玩家（没有 NPC 留在教室）
    const last = out.at(-1)!;
    expect(last.op).toBe("scene.set");
    expect(last.args).toMatchObject({ locId: "loc_classroom", presentIds: [SELF_ID] });
    expect(out.length).toBeLessThanOrEqual(64); // manifest.limits.proposalsPerTurn（每 NPC 一条 move + 一条 scene.set）
  });

  it("无路径的 NPC 被跳过，同 phase 的其他 NPC 照常移动", async () => {
    const state = buildRoom();
    state.links = state.links.filter((l) => !(l.kind === "located_in" && l.from === "npc_ma"));
    state.links.push(located("npc_ma", "loc_isolated"));
    const out = await mod.tick!(ctxOf(state), "night");
    expectLegalOps(out);
    expect(movesOf(out, "npc_ma")).toEqual([]);
    expect(movesOf(out, "npc_zhou")).toEqual(["loc_dorm3"]);
    expect(out.at(-1)!.op).toBe("scene.set");
  });

  it("所有人已在目标地点：只写停留租约，不产生移动，也不动玩家镜头", async () => {
    const state = buildRoom();
    state.links = state.links.filter((l) => !(l.kind === "located_in" && ["npc_lin", "npc_zhou", "npc_ma"].includes(l.from)));
    state.links.push(located("npc_lin", "loc_dorm3"), located("npc_zhou", "loc_dorm3"), located("npc_ma", "loc_dorm3"));
    const out = await mod.tick!(ctxOf(state), "night");
    expect(movesOf(out, "npc_lin")).toEqual([]);
    const leases = out.filter((p) => p.op === "attr.set" && p.args.key === "sim_lease");
    expect(leases).toHaveLength(3);
    for (const p of leases) expect(JSON.parse(String(p.args.value))).toMatchObject({ action: "stay", remaining: 2, phase: "night" });
    expect(out.some((p) => p.op === "scene.set")).toBe(false);
  });

  it("租约未到期时只递减，不重新排日程（NPC 正在占用时间）", async () => {
    const state = buildRoom();
    const npc = state.entities["npc_lin"]!;
    npc.attrs.sim_lease = JSON.stringify({ action: "stay", target: "loc_dorm3", remaining: 2, phase: "night" });
    state.links = state.links.filter((l) => !(l.kind === "located_in" && l.from === "npc_lin"));
    state.links.push(located("npc_lin", "loc_library"));
    const out = await mod.tick!(ctxOf(state), "night");
    const lease = out.find((p) => p.op === "attr.set" && p.args.entityId === "npc_lin" && p.args.key === "sim_lease");
    expect(lease).toBeTruthy();
    expect(JSON.parse(String(lease!.args.value))).toMatchObject({ action: "stay", remaining: 1, phase: "night" });
    expect(movesOf(out, "npc_lin")).toEqual([]);
  });

  it("坏租约 JSON 当空闲处理，不阻塞 NPC 重排", async () => {
    const state = buildRoom();
    state.entities["npc_lin"]!.attrs.sim_lease = "{not json";
    state.links = state.links.filter((l) => !(l.kind === "located_in" && l.from === "npc_lin"));
    state.links.push(located("npc_lin", "loc_library"));
    const out = await mod.tick!(ctxOf(state), "night");
    expect(movesOf(out, "npc_lin")).toEqual(["loc_canteen", "loc_teaching_1", "loc_dorm3"]);
    const lease = out.find((p) => p.op === "attr.set" && p.args.entityId === "npc_lin" && p.args.key === "sim_lease");
    expect(JSON.parse(String(lease!.args.value))).toMatchObject({ action: "move", target: "loc_dorm3", phase: "night" });
  });

  it("租约到期后清空，不把旧动作带进下一个 phase", async () => {
    const state = buildRoom();
    const npc = state.entities["npc_lin"]!;
    npc.attrs.sim_lease = JSON.stringify({ action: "stay", target: "loc_canteen", remaining: 1, phase: "evening" });
    state.links = state.links.filter((l) => !(l.kind === "located_in" && l.from === "npc_lin"));
    state.links.push(located("npc_lin", "loc_library"));
    const out = await mod.tick!(ctxOf(state), "night");
    const lease = out.find((p) => p.op === "attr.set" && p.args.entityId === "npc_lin" && p.args.key === "sim_lease");
    // phase 不匹配 → 旧租约作废，直接按 night 重排（图书馆→食堂→…→宿舍），而不是执行 evening 的停留
    expect(JSON.parse(String(lease!.args.value))).toMatchObject({ action: "move", target: "loc_dorm3", phase: "night" });
  });
});

describe("view", () => {
  it("返回 map/npc 两个只读列表，场景元数据来自实体或场景数据", async () => {
    const state = buildRoom();
    const before = JSON.stringify(state);
    const view = mod.view!(ctxOf(state));
    expect(view?.lists?.map((l) => l.id)).toEqual(["map", "npc"]);
    const mapList = view!.lists![0]!;
    const library = mapList.items.find((i) => i.key === "loc_library");
    expect(library?.text).toBe("图文信息中心");
    expect(library?.meta).toMatchObject({ x: 3220, y: 2320, presentNpcIds: ["npc_lin"] });
    const npcList = view!.lists![1]!;
    expect(npcList.items.map((i) => i.key)).toEqual(["npc_lin", "npc_ma", "npc_zhou"]);
    expect(npcList.items.find((i) => i.key === "npc_ma")?.meta).toMatchObject({ locId: "loc_playground" });
    expect(JSON.stringify(state)).toBe(before); // 只读：view 不能改世界
  });
});
