/**
 * 记忆子系统 P1 的单元契约（docs/08 §10）：
 * 闸门、召回、账号隔离、tombstone、增量同步。
 * 断言的是"结构/事件"，不是文案。
 */
import { describe, expect, it } from "vitest";
import type { Envelope, Entity, MemoryDraft, MemoryRecord, WorldState } from "../../shared/src/index.ts";
import {
  EventSourcedMemory,
  estimateTokens,
  worldRoomId,
} from "./memory.ts";
import { applyMemoryGates, contentHashOf, trigramSimilarity } from "./memory.gate.ts";
import { createInitialState } from "./projection.ts";
import { EventSourcedStore } from "./store.ts";
import { DefaultArbiter } from "./arbiter.ts";
import { emptyRegistry } from "./registry.ts";

const ROOM = "room_m";
const PLR = "plr_self";
const NPC = "npc_lin";
const OTHER = "npc_zhao";
const GATE = "loc_gate";

function entity(id: string, kind: string, name: string, attrs: Record<string, number | string> = {}, canon = true): Entity {
  return { id, kind: kind as Entity["kind"], name, attrs, tags: [], origin: "seed", canon, status: "active", createdAt: 0, updatedAt: 0 };
}

function baseState(): WorldState {
  const s = createInitialState(ROOM, { worldId: "w1", locId: GATE });
  s.entities[GATE] = entity(GATE, "loc", "校门");
  s.entities[PLR] = entity(PLR, "plr", "我");
  s.entities[NPC] = entity(NPC, "npc", "林月", { guard: 10 });
  s.entities[OTHER] = entity(OTHER, "npc", "赵宁", { guard: 10 });
  s.room.scene.presentIds = [PLR, NPC];
  s.room.members = [{ actorId: PLR, role: "player", joinedSeq: 1 }];
  return s;
}

function memEvent(seq: number, payload: Record<string, unknown>, type = "memory.written"): Envelope {
  return { v: 1, id: `evt_${seq}`, roomId: ROOM, seq, ts: 1000 + seq, actorId: PLR, type, payload };
}

function draft(over: Partial<MemoryDraft> = {}): MemoryDraft {
  return { ownerId: NPC, content: "他把伞还给了我", tags: ["伞"], salience: 4, about: [PLR], visibility: "private", tier: "short", ...over };
}

describe("estimateTokens", () => {
  it("中文按字、英文按 4 字 1 token（保守上界）", () => {
    expect(estimateTokens("你好世界")).toBe(4);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("你好abcd")).toBe(3);
  });
});

describe("trigramSimilarity", () => {
  it("同一句话为 1，不同的话远低于阈值", () => {
    expect(trigramSimilarity("他把伞还给了我", "他把伞还给了我")).toBe(1);
    expect(trigramSimilarity("他把伞还给了我", "食堂今天有红烧肉")).toBeLessThan(0.2);
    expect(contentHashOf("他把伞还给了我")).toBe(contentHashOf(" 他把伞还给了我 "));
  });
});

describe("memory.gate 六道闸门", () => {
  it("G1 归属：owner/被提及的人必须在场", () => {
    const r = applyMemoryGates({ state: baseState(), actorId: PLR, ownerId: OTHER, drafts: [draft({ ownerId: OTHER })], recent: [], ownedCount: 0 });
    expect(r.accepted).toHaveLength(0);
    expect(r.dropped[0]?.reason).toBe("owner_absent");
    const r2 = applyMemoryGates({ state: baseState(), actorId: PLR, ownerId: NPC, drafts: [draft({ about: [OTHER] })], recent: [], ownedCount: 0 });
    expect(r2.dropped[0]?.reason).toBe("about_absent");
  });

  it("G3 去重：和近期记忆重复的条目被丢弃", () => {
    const recent: MemoryRecord[] = [
      { id: "mem_1", roomId: ROOM, ownerId: NPC, content: "他把伞还给了我", tags: [], salience: 4, about: [], visibility: "private", tier: "short", turn: 1, createdAt: 1 },
    ];
    const r = applyMemoryGates({ state: baseState(), actorId: PLR, ownerId: NPC, drafts: [draft()], recent, ownedCount: 1 });
    expect(r.accepted).toHaveLength(0);
    expect(r.dropped[0]?.reason).toBe("duplicate");
  });

  it("G4 重要度下限：关于玩家的记忆至少 4", () => {
    const r = applyMemoryGates({ state: baseState(), actorId: PLR, ownerId: NPC, drafts: [draft({ salience: 1 })], recent: [], ownedCount: 0 });
    expect(r.accepted[0]?.salience).toBe(4);
  });

  it("G5 秘密：叙事层不能写 secret，也不能直说 plot 的禁语", () => {
    const secret = applyMemoryGates({ state: baseState(), actorId: PLR, ownerId: NPC, drafts: [draft({ visibility: "secret" })], recent: [], ownedCount: 0 });
    expect(secret.dropped[0]?.reason).toBe("secret_forbidden");
    const state = baseState();
    state.plots = [{ id: "plot_1", goal: "把钥匙藏起来", actors: [NPC, OTHER], forbidReveal: "钥匙在花坛", status: "active", createdDay: 1 }];
    const leak = applyMemoryGates({ state, actorId: PLR, ownerId: NPC, drafts: [draft({ content: "我听说钥匙在花坛下面" })], recent: [], ownedCount: 0 });
    expect(leak.dropped[0]?.reason).toBe("secret_forbidden");
  });

  it("G6 配额：每回合每 owner 最多 3 条，permanent 一律拒绝", () => {
    const drafts = [draft({ content: "第一件事" }), draft({ content: "第二件事" }), draft({ content: "第三件事" }), draft({ content: "第四件事" })];
    const r = applyMemoryGates({ state: baseState(), actorId: PLR, ownerId: NPC, drafts, recent: [], ownedCount: 0 });
    expect(r.accepted).toHaveLength(3);
    expect(r.dropped[0]?.reason).toBe("quota");
    const perm = applyMemoryGates({ state: baseState(), actorId: PLR, ownerId: NPC, drafts: [draft({ tier: "permanent" })], recent: [], ownedCount: 0 });
    expect(perm.dropped[0]?.reason).toBe("permanent_forbidden");
  });
});

describe("EventSourcedMemory", () => {
  it("从事件投影：召回只看 owner 自己的记忆，tombstone 后消失", async () => {
    const mem = new EventSourcedMemory();
    mem.ingest(memEvent(1, { memoryId: "mem_a", ownerId: NPC, content: "他借走了我的书", tags: ["书"], salience: 4, about: [PLR], tier: "short", turn: 1, at: 1 }));
    mem.ingest(memEvent(2, { memoryId: "mem_b", ownerId: NPC, content: "他说谢谢", tags: ["礼貌"], salience: 3, about: [PLR], tier: "long", turn: 1, at: 1 }));
    mem.ingest(memEvent(3, { memoryId: "mem_c", ownerId: OTHER, content: "我看见他在图书馆", tags: ["书"], salience: 5, about: [PLR], tier: "short", turn: 1, at: 1 }));
    const hits = await mem.recall({ roomId: ROOM, ownerId: NPC, about: [PLR], tags: ["书"], budgetTokens: 900, nowTurn: 1 });
    expect(hits.map((h) => h.record.id)).toContain("mem_a");
    expect(hits.map((h) => h.record.id)).not.toContain("mem_c");
    mem.ingest(memEvent(4, { memoryId: "mem_a", supersedes: "mem_a", reason: "撤回" }, "memory.tombstoned"));
    const after = await mem.recall({ roomId: ROOM, ownerId: NPC, about: [PLR], tags: ["书"], budgetTokens: 900, nowTurn: 1 });
    expect(after.map((h) => h.record.id)).not.toContain("mem_a");
  });

  it("账号隔离：A 的私忆 B 查不到；世界层公开条目人人可见", async () => {
    const mem = new EventSourcedMemory();
    const worldRoom = worldRoomId("w1");
    const worldEnv = (seq: number, payload: Record<string, unknown>): Envelope => ({ ...memEvent(seq, payload), roomId: worldRoom });
    mem.ingest(memEvent(1, { memoryId: "mem_a", ownerId: NPC, content: "他答应帮我保密", userId: "u_a", salience: 4, about: [PLR], tier: "short", turn: 1, at: 1 }));
    mem.ingest(worldEnv(1, { memoryId: "mem_world_1", ownerId: "mem_world", content: "这所学校有个旧校规", visibility: "public", tier: "permanent", worldId: "w1", aboutUserIds: ["u_a"], salience: 5, at: 1 }));
    const forB = await mem.recall({ roomId: ROOM, userId: "u_b", ownerId: NPC, about: [PLR], budgetTokens: 900, nowTurn: 1 });
    expect(forB).toHaveLength(0);
    const world = await mem.recall({ roomId: worldRoom, userId: "u_b", ownerId: "mem_world", tiers: ["permanent"], scope: "world", worldId: "w1", budgetTokens: 200, nowTurn: 1 });
    expect(world).toHaveLength(1);
  });

  it("profile：没有记录返回 null；有记录给出熟悉度与印象计数", async () => {
    const mem = new EventSourcedMemory();
    expect(await mem.profile("u_a", NPC, ROOM)).toBeNull();
    mem.ingest(memEvent(1, { memoryId: "mem_a", ownerId: NPC, content: "他借走了我的书", userId: "u_a", about: [PLR], aboutUserIds: ["u_a"], tags: ["书"], salience: 4, tier: "long", turn: 3, at: 3 }));
    const p = await mem.profile("u_a", NPC, ROOM);
    expect(p?.familiarity).toBeGreaterThan(0);
    expect(p?.firstMetTurn).toBe(3);
    expect(p?.lastTopics).toContain("书");
  });


  it("forced(secret) 不占预算、不被截断（docs/03 §2.6）", async () => {
    const mem = new EventSourcedMemory();
    const filler = "甲".repeat(300); // 300 tok：一条就把预算吃满
    mem.ingest(memEvent(1, { memoryId: "mem_pub", ownerId: NPC, content: filler, tags: ["书"], salience: 5, about: [PLR], tier: "long", turn: 1, at: 1 }));
    mem.ingest(memEvent(2, { memoryId: "mem_secret", ownerId: NPC, content: "他其实在替王五传话", tags: ["书"], salience: 3, about: [PLR], visibility: "secret", tier: "short", turn: 1, at: 1 }));
    const hits = await mem.recall({ roomId: ROOM, ownerId: NPC, about: [PLR], tags: ["书"], budgetTokens: 100, nowTurn: 2 });
    const ids = hits.map((h) => h.record.id);
    expect(ids).toContain("mem_secret");
    expect(hits.find((h) => h.record.id === "mem_secret")?.forced).toBe(true);
  });

  it("tombstone 未知 id：世界层撤回必须报 E_REF_NOT_FOUND（不静默成功）", async () => {
    const store = new EventSourcedStore({ worldId: "w1", locId: "loc_gate" });
    store.append(ROOM, [
      { v: 1, id: "evt_1", roomId: ROOM, seq: 1, ts: 1, actorId: "system", type: "entity.created", payload: { entity: { id: "loc_gate", kind: "loc", name: "校门", attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 } } },
    ]);
    const mem = new EventSourcedMemory();
    const arbiter = new DefaultArbiter({ store, registry: emptyRegistry(), memories: mem });
    const worldRoom = worldRoomId("w1");
    const r = await arbiter.apply(worldRoom, [
      { op: "memory.write", args: { ownerId: "mem_world", content: "撤回理由", tier: "permanent", status: "tombstoned", supersedes: "mem_nope", visibility: "public", worldId: "w1" }, reason: "撤回", by: "canonize" },
    ], { v: 1, id: "evt_canonize_x", roomId: worldRoom, seq: 1, ts: 1, actorId: "mem_world", type: "canonize", payload: {}, causedBy: "c1" } as Envelope);
    expect(r.ok).toBe(false);
    expect(r.rejected[0]?.code).toBe("E_REF_NOT_FOUND");
  });

  it("世界层写入必须带 sourceRefs：没有就是 E_MEMORY_TAINT", async () => {
    const store = new EventSourcedStore({ worldId: "w1", locId: "loc_gate" });
    store.append(ROOM, [
      { v: 1, id: "evt_1", roomId: ROOM, seq: 1, ts: 1, actorId: "system", type: "entity.created", payload: { entity: { id: "loc_gate", kind: "loc", name: "校门", attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 } } },
    ]);
    const mem = new EventSourcedMemory();
    const arbiter = new DefaultArbiter({ store, registry: emptyRegistry(), memories: mem });
    const worldRoom = worldRoomId("w1");
    const args = { ownerId: "mem_world", content: "校门口那棵树倒了", tier: "permanent", visibility: "public", worldId: "w1", contentHash: "a".repeat(32) };
    const cause = { v: 1, id: "evt_canonize_y", roomId: worldRoom, seq: 1, ts: 1, actorId: "mem_world", type: "canonize", payload: {}, causedBy: "c2" } as Envelope;
    const noRef = await arbiter.apply(worldRoom, [{ op: "memory.write", args, reason: "写", by: "canonize" }], cause);
    expect(noRef.rejected[0]?.code).toBe("E_MEMORY_TAINT");
    const badRef = await arbiter.apply(worldRoom, [{ op: "memory.write", args: { ...args, sourceRefs: ["hacker_1"] }, reason: "写", by: "canonize" }], { ...cause, seq: 2, id: "evt_canonize_z" } as Envelope);
    expect(badRef.rejected[0]?.code).toBe("E_MEMORY_TAINT");
  });

  it("sync 增量且幂等：重复同步不会产生重复记录", () => {
    const mem = new EventSourcedMemory();
    const envs = [memEvent(1, { memoryId: "mem_a", ownerId: NPC, content: "第一次", tier: "short", at: 1 })];
    mem.sync(ROOM, envs);
    mem.sync(ROOM, envs);
    expect(mem.all(ROOM)).toHaveLength(1);
  });
});
