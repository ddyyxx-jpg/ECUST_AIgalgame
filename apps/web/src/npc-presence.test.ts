import { describe, expect, it } from "vitest";
import { npcLocIdFromLinks, planNpcTalk, targetStillInScene } from "./npc-presence.ts";
import type { NpcLite, SceneLite } from "./npc-presence.ts";

const SCENES: SceneLite[] = [
  { id: "loc_lib", name: "图书馆" },
  { id: "loc_dorm", name: "宿舍" },
];
const NPCS: NpcLite[] = [
  { id: "npc_a", name: "周明远", locId: "loc_lib" },
  { id: "npc_b", name: "林静", locId: "loc_dorm" },
  { id: "npc_ghost", name: "马骁", locId: "" },
  { id: "npc_offmap", name: "未安装的人", locId: "loc_unknown" },
];

describe("planNpcTalk（点 NPC 的场景隔离判定）", () => {
  it("同一场景：打开对话", () => {
    expect(planNpcTalk(NPCS, SCENES, "npc_a", "周明远", "loc_lib")).toMatchObject({
      kind: "present",
      npc: { id: "npc_a", name: "周明远" },
    });
  });

  it("在别的场景：给出所在地，可前往", () => {
    expect(planNpcTalk(NPCS, SCENES, "npc_b", "林静", "loc_lib")).toMatchObject({
      kind: "elsewhere",
      locId: "loc_dorm",
      locName: "宿舍",
      npc: { id: "npc_b" },
    });
  });

  it("locId 缺失：不可定位，不提供前往", () => {
    const plan = planNpcTalk(NPCS, SCENES, "npc_ghost", "马骁", "loc_lib");
    expect(plan.kind).toBe("unlocatable");
    if (plan.kind === "unlocatable") {
      expect(plan.name).toBe("马骁");
      expect(plan.reason).toContain("不知道");
    }
  });

  it("场景表里查不到 locId：不可定位（避免 travel 到不存在场景）", () => {
    const plan = planNpcTalk(NPCS, SCENES, "npc_offmap", "未安装的人", "loc_lib");
    expect(plan.kind).toBe("unlocatable");
    if (plan.kind === "unlocatable") expect(plan.reason).toContain("地图点位");
  });

  it("NPC 不在 map.npcs 里：用点击时给的名字，不崩", () => {
    const plan = planNpcTalk(NPCS, SCENES, "npc_missing", "某人", "loc_lib");
    expect(plan).toMatchObject({ kind: "unlocatable", npc: null, name: "某人" });
  });

  it("空的 npc 名字回退到点击时给的名字", () => {
    const plan = planNpcTalk([{ id: "npc_x", name: "", locId: "" }], SCENES, "npc_x", "无名氏", "loc_lib");
    expect(plan).toMatchObject({ kind: "unlocatable", name: "无名氏" });
  });

  it("当前场景为空（还没拿到位置）时不判成在场", () => {
    const plan = planNpcTalk(NPCS, SCENES, "npc_a", "周明远", "");
    expect(plan.kind).toBe("elsewhere");
  });
});

describe("npcLocIdFromLinks（从世界状态取 NPC 所在地）", () => {
  const LINKS = [
    { kind: "knows", from: "npc_a", to: "npc_b" },
    { kind: "located_in", from: "npc_a", to: "loc_lib" },
    { kind: "located_in", from: "npc_b", to: "loc_dorm" },
  ];

  it("取 located_in 指向的点位，忽略其它关系", () => {
    expect(npcLocIdFromLinks("npc_a", LINKS)).toBe("loc_lib");
    expect(npcLocIdFromLinks("npc_b", LINKS)).toBe("loc_dorm");
  });

  it("没有 located_in / 点为空：返回空串（由调用方按「不可定位」处理）", () => {
    expect(npcLocIdFromLinks("npc_ghost", LINKS)).toBe("");
    expect(npcLocIdFromLinks("npc_a", [{ kind: "located_in", from: "npc_a", to: "" }])).toBe("");
  });
});

describe("targetStillInScene（重试前复核对话目标）", () => {
  it("没有对话目标：与场景无关，允许重试", () => {
    expect(targetStillInScene(null, "loc_lib", "", [])).toBe(true);
  });

  it("目标在 scene.presentIds 里：允许重试", () => {
    expect(targetStillInScene({ id: "npc_a" }, "loc_lib", "loc_dorm", ["npc_a"])).toBe(true);
  });

  it("目标的 located_in 正好是脚下场景：允许重试", () => {
    expect(targetStillInScene({ id: "npc_a" }, "loc_lib", "loc_lib")).toBe(true);
  });

  it("目标已在别的场景：禁用重试（防隔空聊天）", () => {
    expect(targetStillInScene({ id: "npc_b" }, "loc_lib", "loc_dorm")).toBe(false);
  });

  it("当前位置未知 / 目标不可定位：保守禁用", () => {
    expect(targetStillInScene({ id: "npc_a" }, "", "loc_lib")).toBe(false);
    expect(targetStillInScene({ id: "npc_ghost" }, "loc_lib", "")).toBe(false);
  });
});
