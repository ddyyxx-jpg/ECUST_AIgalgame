/**
 * introduce 模块的回归测试：姓名抽取（含"我是XX"的身份词排除）+ 提案结构。
 * 只断言 proposals，不断言文案。
 */
import { describe, expect, it } from "vitest";
import type { Entity, ModuleContext, WorldState } from "../../../packages/shared/src/contract/types.ts";
import { extractName } from "./module.ts";
import introduceModule from "./module.ts";

const ROOM = "room_intro";
const PLR = "plr_me";
const NPC = "npc_lin";

function npcEntity(): Entity {
  return {
    id: NPC,
    kind: "npc",
    name: "林静",
    attrs: { stamina: 100, knows_name: false },
    tags: [],
    origin: "seed",
    canon: true,
    status: "active",
    createdAt: 0,
    updatedAt: 0,
  };
}

function ctxOf(input: string, presentIds: string[] = [NPC]): ModuleContext {
  const state: WorldState = {
    schemaVersion: 2,
    room: {
      id: ROOM,
      mode: "solo",
      worldId: "w",
      members: [],
      scene: { locId: "loc_library", presentIds: [PLR, ...presentIds] },
      createdAt: 0,
      lastActiveAt: 0,
    },
    entities: { [NPC]: npcEntity() },
    links: [],
    clock: { day: 1, phase: "morning", tick: 0 },
    plots: [],
    moduleState: {},
  };
  return {
    roomId: ROOM,
    actorId: PLR,
    input,
    state,
    clock: state.clock,
    query: { entity: (id: string) => state.entities[id] },
  } as unknown as ModuleContext;
}

describe("extractName", () => {
  it("识别常见自述", () => {
    expect(extractName("我叫林然")).toBe("林然");
    expect(extractName("你好，我叫 陈晨。")).toBe("陈晨");
    expect(extractName("叫我小林就行")).toBe("小林");
    expect(extractName("我的名字叫周远")).toBe("周远");
  });

  it("不把身份当名字", () => {
    expect(extractName("我是新生")).toBeUndefined();
    expect(extractName("我是转学生")).toBeUndefined();
    expect(extractName("我叫什么来着")).toBeUndefined();
    expect(extractName("你好啊")).toBeUndefined();
  });
});

describe("introduce.intent", () => {
  it("自述姓名：只让 NPC 记住玩家叫什么，不解锁 knows_name（方向不同）", () => {
    const out = introduceModule.intent?.(ctxOf("我叫林然")) as { ok: boolean; proposals: { op: string; args: Record<string, unknown> }[]; facts?: string[] };
    expect(out.ok).toBe(true);
    expect(out.proposals.some((p) => p.op === "attr.set")).toBe(false);
    const mem = out.proposals.find((p) => p.op === "memory.write");
    expect(mem?.args).toMatchObject({ ownerId: NPC, visibility: "private" });
    expect(String(mem?.args.content)).toContain("林然");
    // facts 不泄露 NPC 真名（玩家此刻还不知道）
    expect(out.facts?.join("") ?? "").not.toContain("林静");
  });

  it("没识别到名字时不认领，交回模型", () => {
    const out = introduceModule.intent?.(ctxOf("随便走走")) as { ok: boolean };
    expect(out.ok).toBe(false);
  });

  it("问名字：写'谁问过我的名字'的记忆；真名解锁交给服务端按台词判定", () => {
    const out = introduceModule.intent?.(ctxOf("你叫什么名字？")) as {
      ok: boolean;
      proposals: { op: string; args: Record<string, unknown> }[];
      facts?: string[];
    };
    expect(out.ok).toBe(true);
    expect(out.proposals.some((p) => p.op === "attr.set")).toBe(false);
    expect(out.proposals.some((p) => p.op === "memory.write" && p.args.ownerId === NPC)).toBe(true);
    expect(out.facts?.join("") ?? "").not.toContain("林静");
  });
});
