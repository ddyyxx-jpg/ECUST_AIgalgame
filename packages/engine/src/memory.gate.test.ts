/**
 * 工作记忆（"最近对话"）的信任边界与配额（PR #24 P2-1、#36）。
 *
 * 背景：工作记忆每回合都写；如果它参与 G6 配额，会先把自己撑到 sessionCap=30，
 * 之后模型的重要记忆与最近对话互相挤掉。
 *
 * #36 之后信任边界改为**调用结构**：只有 `workingDrafts`（引擎内部构造）能跳过去重/配额；
 * 模型草稿即使带 WORKING_MEMORY_TAG 也按普通情节记忆走 G3/G4/G6，且标签会被清洗。
 */
import { describe, expect, it } from "vitest";
import type { Envelope, Entity, MemoryDraft, MemoryRecord } from "../../shared/src/index.ts";
import { EventSourcedStore } from "./store.ts";
import { applyMemoryGates, isWorkingMemory, WORKING_MEMORY_TAG } from "./memory.gate.ts";

const ROOM = "room_g";
const PLR = "plr_self";
const LIN = "npc_lin";
const LIB = "loc_lib";

function entity(id: string, kind: string, name: string): Entity {
  return { id, kind: kind as Entity["kind"], name, attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 };
}

function env(seq: number, type: string, payload: unknown): Envelope {
  return { v: 1, id: `evt_${ROOM}_${seq}`, roomId: ROOM, seq, ts: 1000 + seq, actorId: "system", type, payload };
}

function makeState() {
  const store = new EventSourcedStore({ worldId: "w1", locId: LIB });
  store.append(ROOM, [
    env(1, "entity.created", { entity: entity(LIB, "loc", "图书馆") }),
    env(2, "entity.created", { entity: entity(PLR, "plr", "我") }),
    env(3, "entity.created", { entity: entity(LIN, "npc", "林静") }),
    env(4, "scene.changed", { locId: LIB, presentIds: [PLR, LIN] }),
  ]);
  return store.state(ROOM);
}

const state = makeState();

function workingDraft(content = "刚才玩家说「明早见」，林静点头。"): MemoryDraft {
  return { ownerId: LIN, content, tags: [WORKING_MEMORY_TAG, "图书馆"], salience: 3, about: [PLR], visibility: "private", tier: "short" };
}

function plotDraft(content = "他答应帮我占座", tags = ["占座"]): MemoryDraft {
  return { ownerId: "", content, tags, salience: 3 };
}

function gate(drafts: MemoryDraft[], ownedCount: number, recent: MemoryRecord[] = [], workingDrafts: MemoryDraft[] = []) {
  return applyMemoryGates({ state, actorId: PLR, ownerId: LIN, drafts, workingDrafts, ownedCount, recent });
}

describe("memory.gate × 工作记忆配额（PR #24 P2-1 / #36）", () => {
  it("情节记忆已达 sessionCap=30 时，工作记忆仍能写入且不计入配额", () => {
    const r = gate([plotDraft()], 30, [], [workingDraft()]);
    expect(r.dropped.some((d) => d.reason === "quota")).toBe(true);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]!.tags).toContain(WORKING_MEMORY_TAG);
  });

  it("工作记忆不占 writePerTurn=3：模型写满 3 条后工作记忆仍能写入", () => {
    const model = [1, 2, 3].map((i) => plotDraft(`模型情节记忆 ${i}`, ["情节"]));
    const r = gate(model, 0, [], [workingDraft()]);
    expect(r.accepted).toHaveLength(4);
    expect(r.accepted.filter((d) => d.tags?.includes(WORKING_MEMORY_TAG))).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });

  it("工作记忆跳过去重：与旧条高度相似也不丢新条（滚动替换由写侧 tombstone 负责）", () => {
    const recent: MemoryRecord[] = [{
      id: "mem_old",
      roomId: ROOM,
      ownerId: LIN,
      content: "刚才玩家说「明早见」，林静点头。",
      tags: [WORKING_MEMORY_TAG],
      salience: 3,
      about: [PLR],
      visibility: "private",
      tier: "short",
      status: "current",
      turn: 1,
      createdAt: 1,
    }];
    const r = gate([], 5, recent, [workingDraft("刚才玩家说「明早见」，林静点头。")]);
    expect(r.accepted).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });

  it("#36：模型草稿伪造「最近对话」标签仍受 writePerTurn=3 约束（不能跳过配额）", () => {
    const model = [1, 2, 3, 4].map((i) => plotDraft(`模型情节记忆 ${i}`, [WORKING_MEMORY_TAG, "情节"]));
    const r = gate(model, 0);
    expect(r.accepted).toHaveLength(3);
    expect(r.dropped.some((d) => d.reason === "quota")).toBe(true);
    // 标签被清洗：模型不能靠这个字符串在后续回合伪装成可信工作记忆
    expect(r.accepted.every((d) => !d.tags?.includes(WORKING_MEMORY_TAG))).toBe(true);
  });

  it("#36：模型草稿伪造标签也不能绕过 sessionCap=30", () => {
    const r = gate([plotDraft("模型情节记忆", [WORKING_MEMORY_TAG])], 30);
    expect(r.accepted).toHaveLength(0);
    expect(r.dropped.some((d) => d.reason === "quota")).toBe(true);
  });

  it("#36：读侧 isWorkingMemory 兼容历史数据（按标签识别）", () => {
    expect(isWorkingMemory({ tags: [WORKING_MEMORY_TAG] })).toBe(true);
    expect(isWorkingMemory({ tags: ["占座"] })).toBe(false);
    expect(isWorkingMemory({})).toBe(false);
  });
});
