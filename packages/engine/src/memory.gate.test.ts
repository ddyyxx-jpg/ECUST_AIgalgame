/**
 * 工作记忆（"最近对话"）与情节记忆的配额边界（PR #24 P2-1）。
 *
 * 背景：工作记忆每回合都写；如果它参与 G6 配额，会先把自己撑到 sessionCap=30，
 * 之后模型的重要记忆与最近对话互相挤掉。这里直接对闸门做单测，不依赖 Turn。
 */
import { describe, expect, it } from "vitest";
import type { Envelope, Entity, MemoryDraft, MemoryRecord } from "../../shared/src/index.ts";
import { EventSourcedStore } from "./store.ts";
import { applyMemoryGates, markEngineWorkingMemory, WORKING_MEMORY_TAG } from "./memory.gate.ts";

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
  // #36：可信标记只有引擎写侧（recentDrafts）能设置，测试也走同一个 helper
  return markEngineWorkingMemory({
    ownerId: "", content, tags: [WORKING_MEMORY_TAG, "图书馆"], salience: 3, about: [PLR], visibility: "private", tier: "short",
  });
}

/** #36 复现：模型把工作记忆标签塞进 memory[] 草稿 */
function forgedWorkingDraft(content = "伪造的最近对话", tags: string[] = [WORKING_MEMORY_TAG]): MemoryDraft {
  return { ownerId: "", content, tags, salience: 3, about: [PLR], visibility: "private", tier: "long" };
}

function plotDraft(content = "他答应帮我占座", tags = ["占座"]): MemoryDraft {
  return { ownerId: "", content, tags, salience: 3 };
}

function gate(drafts: MemoryDraft[], ownedCount: number, recent: MemoryRecord[] = []) {
  return applyMemoryGates({ state, actorId: PLR, ownerId: LIN, drafts, ownedCount, recent });
}

describe("memory.gate × 工作记忆配额（PR #24 P2-1）", () => {
  it("情节记忆已达 sessionCap=30 时，工作记忆仍能写入且不计入配额", () => {
    const r = gate([plotDraft(), workingDraft()], 30);
    expect(r.dropped.some((d) => d.reason === "quota")).toBe(true);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]!.tags).toContain(WORKING_MEMORY_TAG);
  });

  it("工作记忆不占 writePerTurn=3：模型写满 3 条后工作记忆仍能写入", () => {
    const model = [1, 2, 3].map((i) => plotDraft(`模型情节记忆 ${i}`, ["情节"]));
    const r = gate([...model, workingDraft()], 0);
    expect(r.accepted).toHaveLength(4);
    expect(r.accepted.filter((d) => d.tags?.includes(WORKING_MEMORY_TAG))).toHaveLength(1);
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
    const r = gate([workingDraft("刚才玩家说「明早见」，林静点头。")], 5, recent);
    expect(r.accepted).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });
});

describe("memory.gate × 可信边界（issue #36）", () => {
  it("模型伪造「最近对话」标签：ownedCount=30 时 5 条全部因配额被丢，不再全部通过", () => {
    const forged = Array.from({ length: 5 }, (_, i) => forgedWorkingDraft(`伪造的最近对话 ${i}`));
    const r = gate(forged, 30);
    expect(r.accepted).toHaveLength(0);
    expect(r.dropped).toHaveLength(5);
    expect(r.dropped.every((d) => d.reason === "quota")).toBe(true);
  });

  it("伪造标签也绕不过 G3 去重与 writePerTurn=3", () => {
    const recent: MemoryRecord[] = [{
      id: "mem_recent", roomId: ROOM, ownerId: LIN,
      content: "伪造的最近对话", tags: [WORKING_MEMORY_TAG], salience: 3,
      about: [PLR], visibility: "private", tier: "short", status: "current", turn: 1, createdAt: 1,
    }];
    const dup = gate([forgedWorkingDraft()], 0, recent);
    expect(dup.accepted).toHaveLength(0);
    expect(dup.dropped[0]?.reason).toBe("duplicate");

    const many = Array.from({ length: 5 }, (_, i) => forgedWorkingDraft(`伪造的最近对话 ${i}`));
    const quota = gate(many, 0);
    expect(quota.accepted).toHaveLength(3);
    expect(quota.dropped.filter((d) => d.reason === "quota")).toHaveLength(2);
  });

  it("伪造标签被剥离：写出的普通记忆不会被读侧当成工作记忆", () => {
    const r = gate([forgedWorkingDraft("他借我一支笔", ["最近对话", "借笔"])], 0);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]!.tags).not.toContain(WORKING_MEMORY_TAG);
    expect(r.accepted[0]!.tags).toContain("借笔");
  });

  it("可信工作记忆在配额已满时仍写入；两个 owner 各有一条（互不影响）", () => {
    const r1 = gate([plotDraft(), workingDraft("林静的最近对话")], 30);
    expect(r1.accepted).toHaveLength(1);
    expect(r1.accepted[0]!.tags).toContain(WORKING_MEMORY_TAG);

    const r2 = applyMemoryGates({
      state, actorId: PLR, ownerId: "plr_self",
      drafts: [workingDraft("玩家的最近对话")], ownedCount: 30, recent: [],
    });
    expect(r2.accepted).toHaveLength(1);
    expect(r2.accepted[0]!.ownerId).toBe(PLR);
  });
});
