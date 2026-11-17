/**
 * 世界层永久记忆（P3）：八道闸门的可验证行为。
 * 断言"写没写进世界层 / 被哪道闸门拦下"，不断言文案。
 */
import { describe, expect, it } from "vitest";
import type { Envelope, Entity, MemoryRecord, RoomId } from "../../shared/src/index.ts";
import { DefaultArbiter } from "./arbiter.ts";
import { EventSourcedStore } from "./store.ts";
import { emptyRegistry } from "./registry.ts";
import { EventSourcedMemory, worldRoomId } from "./memory.ts";
import { CanonizeJob, type CanonizeJudge } from "./canonize.ts";

import { contentHashOf } from "./memory.gate.ts";

const ROOM = "room_c";
const WORLD = "w1";
const WORLD_ROOM = worldRoomId(WORLD);
const A = "npc_lin";
const B = "npc_ma";
const PLR = "plr_self";
const GATE = "loc_gate";

function entity(id: string, kind: string, name: string): Entity {
  return { id, kind: kind as Entity["kind"], name, attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 };
}

function env(seq: number, type: string, payload: unknown, roomId: RoomId = ROOM): Envelope {
  return { v: 1, id: `evt_${roomId}_${seq}`, roomId, seq, ts: 1000 + seq, actorId: "system", type, payload };
}

function memPayload(id: string, ownerId: string, content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { memoryId: id, ownerId, content, tags: ["校园"], salience: 4, about: [PLR], visibility: "public", tier: "long", turn: 1, at: 1, userId: "u_a", ...extra };
}

interface Fixture {
  store: EventSourcedStore;
  memory: EventSourcedMemory;
  arbiter: DefaultArbiter;
  bump: Array<{ worldId: string; version: number }>;
}

async function fixture(opts: { records: MemoryRecord[]; judge?: CanonizeJudge; enabled?: boolean; dailyCap?: number }): Promise<Fixture> {
  const store = new EventSourcedStore({ worldId: WORLD, locId: GATE });
  store.append(ROOM, [
    env(1, "entity.created", { entity: entity(GATE, "loc", "校门") }),
    env(2, "entity.created", { entity: entity(A, "npc", "林月") }),
    env(3, "entity.created", { entity: entity(B, "npc", "马骁") }),
    env(4, "entity.created", { entity: entity(PLR, "plr", "我") }),
    env(5, "scene.changed", { locId: GATE, presentIds: [PLR, A, B] }),
  ]);
  const memory = new EventSourcedMemory();
  const arbiter = new DefaultArbiter({ store, registry: emptyRegistry(), memories: memory });
  // 把记忆直接投影进内存索引（等价于它们由 memory.written 事件重放得到）
  for (const r of opts.records) {
    memory.ingest({
      ...env(100 + opts.records.indexOf(r), "memory.written", { ...memPayload(r.id, r.ownerId, r.content), contentHash: contentHashOf(r.content), tags: r.tags, about: r.about }),
    });
  }
  const bump: Array<{ worldId: string; version: number }> = [];
  const judge: CanonizeJudge = opts.judge ?? { review: async () => ({ allow: true }) };
  const job = new CanonizeJob({
    store,
    arbiter,
    worldRoom: WORLD_ROOM,
    worldId: WORLD,
    memory,
    judge,
    limits: { enabled: opts.enabled ?? true, dailyCap: opts.dailyCap ?? 200, minWitness: 2, perSourceCap: 2 },
    onVersionBump: async (worldId, version) => {
      bump.push({ worldId, version });
    },
  });
  void job;
  return { store, memory, arbiter, bump };
}

function record(id: string, ownerId: string, content: string): MemoryRecord {
  return { id, roomId: ROOM, ownerId, content, tags: ["校园"], salience: 4, about: [PLR], visibility: "public", tier: "long", turn: 1, createdAt: 1 };
}

/** 需要 plot 时从事件投影出活跃剧情（禁语闸门的数据来源） */
function withPlot(store: EventSourcedStore): void {
  const seq = store.seq(ROOM) + 1;
  store.append(ROOM, [
    env(seq, "plot.upserted", { plot: { id: "plot_key", goal: "把钥匙藏起来", actors: [A, B], status: "active", createdDay: 1, forbidReveal: "钥匙在花坛" } }),
  ]);
}

async function job(f: Fixture, judge: CanonizeJudge = { review: async () => ({ allow: true }) }, enabled = true, dailyCap = 200) {
  return new CanonizeJob({
    store: f.store,
    arbiter: f.arbiter,
    worldRoom: WORLD_ROOM,
    worldId: WORLD,
    memory: f.memory,
    judge,
    limits: { enabled, dailyCap, minWitness: 2, perSourceCap: 2 },
    onVersionBump: async (worldId, version) => {
      f.bump.push({ worldId, version });
    },
  });
}

describe("canonize 八道闸门（P3）", () => {
  it("两位 NPC 都记住的公共的事 → 写进世界层（ownerId=mem_world，tier=permanent）", async () => {
    const f = await fixture({ records: [record("mem_a", A, "校门口那棵老梧桐树被台风刮倒了"), record("mem_b", B, "校门口那棵老梧桐树被台风刮倒了")] });
    const report = await (await job(f)).retireRoom(ROOM);
    expect(report.written).toHaveLength(1);
    expect(report.writtenToday).toBe(1);
    const events = await f.store.events(WORLD_ROOM, 0);
    const written = events.filter((e) => e.type === "memory.written");
    expect(written).toHaveLength(1);
    const payload = written[0]!.payload as { ownerId: string; tier: string; visibility: string; contentHash?: string };
    expect(payload.ownerId).toBe("mem_world");
    expect(payload.tier).toBe("permanent");
    expect(payload.visibility).toBe("public");
    expect(payload.contentHash).toBeTruthy();
    expect(f.bump).toEqual([{ worldId: WORLD, version: 1 }]);
  });

  it("只有一个人记住 → 公共性不足，不写", async () => {
    const f = await fixture({ records: [record("mem_a", A, "我看见林月在图书馆哭")] });
    const report = await (await job(f)).retireRoom(ROOM);
    expect(report.written).toHaveLength(0);
    expect(report.skipped.some((s) => s.reason === "not_public_enough")).toBe(true);
  });

  it("隐私扫描：命中活跃剧情的禁语 → 拦下（不泄露密谋）", async () => {
    const f = await fixture({ records: [record("mem_a", A, "钥匙在花坛下面"), record("mem_b", B, "钥匙在花坛下面")] });
    withPlot(f.store);
    const report = await (await job(f)).retireRoom(ROOM);
    expect(report.written).toHaveLength(0);
    expect(report.skipped.some((s) => s.reason.startsWith("privacy:plot"))).toBe(true);
  });

  it("独立审核拒绝 → 丢弃；审核器抛错 → judge_unavailable（fail-closed）", async () => {
    const records = [record("mem_a", A, "食堂新开了一家面馆"), record("mem_b", B, "食堂新开了一家面馆")];
    const deny = await fixture({ records });
    const r1 = await (await job(deny, { review: async () => ({ allow: false, reason: "太具体" }) })).retireRoom(ROOM);
    expect(r1.written).toHaveLength(0);
    expect(r1.skipped.some((s) => s.reason.startsWith("judge:"))).toBe(true);

    const boom = await fixture({ records });
    const r2 = await (await job(boom, { review: async () => { throw new Error("timeout"); } })).retireRoom(ROOM);
    expect(r2.written).toHaveLength(0);
    expect(r2.skipped.some((s) => s.reason === "judge_unavailable")).toBe(true);
  });

  it("幂等：同一件事第二次发布直接跳过（世界层唯一）", async () => {
    const records = [record("mem_a", A, "校门口那棵老梧桐树被台风刮倒了"), record("mem_b", B, "校门口那棵老梧桐树被台风刮倒了")];
    const f = await fixture({ records });
    const j = await job(f);
    const first = await j.retireRoom(ROOM);
    expect(first.written).toHaveLength(1);
    const second = await j.retireRoom(ROOM);
    expect(second.written).toHaveLength(0);
    expect(second.skipped.some((s) => s.reason === "duplicate")).toBe(true);
  });

  it("体量闸门：每日上限 0 时一条都不写；disabled 时整体关闭", async () => {
    const records = [record("mem_a", A, "食堂新开了一家面馆"), record("mem_b", B, "食堂新开了一家面馆")];
    const capped = await fixture({ records });
    const r1 = await (await job(capped, { review: async () => ({ allow: true }) }, true, 0)).retireRoom(ROOM);
    expect(r1.written).toHaveLength(0);
    expect(r1.skipped.some((s) => s.reason === "daily_cap")).toBe(true);

    const off = await fixture({ records });
    const r2 = await (await job(off, { review: async () => ({ allow: true }) }, false)).retireRoom(ROOM);
    expect(r2.written).toHaveLength(0);
    expect(r2.skipped[0]?.reason).toBe("disabled");
  });

  it("撤回：tombstone 立即生效，世界层版本 +1，召回里消失", async () => {
    const records = [record("mem_a", A, "校门口那棵老梧桐树被台风刮倒了"), record("mem_b", B, "校门口那棵老梧桐树被台风刮倒了")];
    const f = await fixture({ records });
    const j = await job(f);
    const report = await j.retireRoom(ROOM);
    const memoryId = report.written[0]!;
    expect(await j.tombstone(memoryId, "记错了")).toBe(true);
    expect(f.bump.at(-1)).toEqual({ worldId: WORLD, version: 2 });
    const hits = await f.memory.recall({ roomId: WORLD_ROOM, ownerId: "mem_world", scope: "world", budgetTokens: 500, nowTurn: 5 });
    expect(hits.map((h) => h.record.id)).not.toContain(memoryId);
    expect(hits.every((h) => h.record.status !== "tombstoned")).toBe(true);
  });
});
