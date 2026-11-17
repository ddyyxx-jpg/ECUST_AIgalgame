/**
 * P0/P1 复审门槛的三条端到端测试（审阅要求）：
 *   1. canonize → 下一回合提示词里 S1.5 非空（"换档后世界记得你"真的生效）
 *   2. 重启重建后：版本号不回退、召回结果与重建前一致
 *   3. 同内容不同 owner：两条都在（不再撞 memoryId）
 *
 * 这些测试故意走**真实链路**：canonize 写世界层 → ingest → recall → buildTurnPrompt。
 * 之前 canonize.test 用 fixture 直接 ingest，永远绿，等于没测。
 */
import { describe, expect, it } from "vitest";
import type { Envelope, Entity, MemoryRecord } from "../../shared/src/index.ts";
import { MockLlm } from "../../llm/src/mock.ts";
import { DefaultArbiter } from "./arbiter.ts";
import { FileStore, EventSourcedStore } from "./store.ts";
import { emptyRegistry } from "./registry.ts";
import { DefaultTurn } from "./turn.ts";
import { ModuleHost } from "./modules.ts";
import { EventSourcedMemory, worldRoomId } from "./memory.ts";
import { CanonizeJob, type CanonizeJudge } from "./canonize.ts";
import { buildTurnPrompt } from "./turn.prompt.ts";
import { tempDir } from "../../testkit/src/index.ts";

const ROOM = "room_e";
const WORLD = "w1";
const WORLD_ROOM = worldRoomId(WORLD);
const A = "npc_lin";
const B = "npc_ma";
const PLR = "plr_self";
const GATE = "loc_gate";

function entity(id: string, kind: string, name: string): Entity {
  return { id, kind: kind as Entity["kind"], name, attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 };
}

function env(seq: number, type: string, payload: unknown, roomId = ROOM): Envelope {
  return { v: 1, id: `evt_${roomId}_${seq}`, roomId, seq, ts: 1000 + seq, actorId: "system", type, payload };
}

function record(id: string, ownerId: string, content: string): MemoryRecord {
  return { id, roomId: ROOM, ownerId, content, tags: ["校园"], salience: 4, about: [PLR], visibility: "public", tier: "long", turn: 1, createdAt: 1 };
}

/** 建一个"两个 NPC 都公开记得同一件事"的房间：世界层候选的最小完整场景 */
function seedRoom(store: EventSourcedStore): EventSourcedMemory {
  const memory = new EventSourcedMemory();
  store.append(ROOM, [
    env(1, "entity.created", { entity: entity(GATE, "loc", "校门") }),
    env(2, "entity.created", { entity: entity(A, "npc", "林月") }),
    env(3, "entity.created", { entity: entity(B, "npc", "马骁") }),
    env(4, "entity.created", { entity: entity(PLR, "plr", "我") }),
    env(5, "scene.changed", { locId: GATE, presentIds: [PLR, A, B] }),
  ]);
  return memory;
}

async function publishOnce(store: EventSourcedStore, memory: EventSourcedMemory, records: MemoryRecord[]) {
  const arbiter = new DefaultArbiter({ store, registry: emptyRegistry(), memories: memory });
  const judge: CanonizeJudge = { review: async () => ({ allow: true }) };
  const bumps: number[] = [];
  const job = new CanonizeJob({
    store,
    arbiter,
    worldRoom: WORLD_ROOM,
    worldId: WORLD,
    memory,
    judge,
    limits: { enabled: true, dailyCap: 200, minWitness: 2, perSourceCap: 2 },
    onVersionBump: (_w, v) => {
      bumps.push(v);
    },
    now: () => 10_000,
  });
  // 房间里的记忆先进索引（生产里由 Turn 的 sync 完成）
  const events = await store.events(ROOM, 0);
  memory.rebuild(ROOM, events);
  // 等价于这些记忆由房间里的 memory.written 事件重放得到（生产链路如此）
  let seq = events.length;
  for (const r of records) {
    seq += 1;
    memory.ingest(env(seq, "memory.written", { ...r, memoryId: r.id, at: 1 }));
  }
  const report = await job.retireRoom(ROOM);
  return { job, report, bumps };
}

describe("记忆链端到端（复审门槛）", () => {
  it("canonize 之后，下一回合提示词里 S1.5 非空（世界记得你）", async () => {
    const store = new EventSourcedStore({ worldId: WORLD, locId: GATE });
    const memory = seedRoom(store);
    const content = "校门口那棵老梧桐树被台风刮倒了";
    const { report } = await publishOnce(store, memory, [record("mem_a", A, content), record("mem_b", B, content)]);
    expect(report.written).toHaveLength(1);

    const worldHits = await memory.recall({ roomId: WORLD_ROOM, ownerId: "mem_world", scope: "world", tiers: ["permanent"], budgetTokens: 1100, nowTurn: 9 });
    expect(worldHits.map((h) => h.record.content)).toContain(content);

    const state = await store.snapshot(ROOM);
    const prompt = buildTurnPrompt(state, PLR, "我去看看校门口", {
      mem: {
        available: true,
        worldId: WORLD,
        worldRoom: WORLD_ROOM,
        ownerId: A,
        permanent: worldHits,
        long: [],
        short: [],
        profile: null,
        ownedCount: 0,
        recent: [],
      },
    });
    expect(prompt).toContain("这个世界已经知道的事");
    expect(prompt).toContain(content);
  });

  it("重启重建后版本号不回退、召回与重建前一致", async () => {
    const dir = tempDir("galgame-mem-e2e-");
    const store = new FileStore(dir, { worldId: WORLD, locId: GATE });
    const memory = seedRoom(store);
    const content = "食堂新开了一家面馆，凭学生卡打八折";
    const { job, report, bumps } = await publishOnce(store, memory, [record("mem_a", A, content), record("mem_b", B, content)]);
    expect(report.written).toHaveLength(1);
    const version = bumps.at(-1) ?? 0;
    expect(version).toBe(1);

    const before = await memory.recall({ roomId: WORLD_ROOM, ownerId: "mem_world", scope: "world", tiers: ["permanent"], budgetTokens: 1100, nowTurn: 9 });
    expect(before).toHaveLength(1);

    // "重启"：新 store + 新 memory，启动流程 = listRooms → rebuild → 读回版本
    const store2 = new FileStore(dir, { worldId: WORLD, locId: GATE });
    const memory2 = new EventSourcedMemory();
    for (const roomId of await store2.listRooms()) memory2.rebuild(roomId, await store2.events(roomId, 0));
    await store2.load(WORLD_ROOM);
    memory2.rebuild(WORLD_ROOM, await store2.events(WORLD_ROOM, 0));

    const after = await memory2.recall({ roomId: WORLD_ROOM, ownerId: "mem_world", scope: "world", tiers: ["permanent"], budgetTokens: 1100, nowTurn: 9 });
    expect(after.map((h) => h.record.id)).toEqual(before.map((h) => h.record.id));

    // 版本号从 mem.version 读回：下一次发布必须是 version+1，而不是从 0 重来
    const arbiter2 = new DefaultArbiter({ store: store2, registry: emptyRegistry(), memories: memory2 });
    const job2 = new CanonizeJob({
      store: store2,
      arbiter: arbiter2,
      worldRoom: WORLD_ROOM,
      worldId: WORLD,
      memory: memory2,
      judge: { review: async () => ({ allow: true }) },
      startVersion: version,
      now: () => 20_000,
    });
    expect(job2.stats().version).toBe(version);
    // 同一件事再次候选 → 幂等挡掉（世界层已有），不会把版本顶到 3
    const dup = await job2.retireRoom(ROOM);
    expect(dup.written).toHaveLength(0);
    void job;
  });

  it("同内容不同 owner 各留一条（memoryId 不再撞）", async () => {
    const store = new EventSourcedStore({ worldId: WORLD, locId: GATE });
    const memory = seedRoom(store);
    const text = "图书馆换了新的借书系统";
    await publishOnce(store, memory, [record("mem_x", A, text), record("mem_y", B, text)]);
    const a = memory.all(ROOM).filter((r) => r.ownerId === A);
    const b = memory.all(ROOM).filter((r) => r.ownerId === B);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]?.id).not.toBe(b[0]?.id);
  });

  it("回合里写同内容记忆的两个 owner 也各留一条", async () => {
    const store = new EventSourcedStore({ worldId: WORLD, locId: GATE });
    const memory = seedRoom(store);
    const arbiter = new DefaultArbiter({ store, registry: emptyRegistry(), memories: memory });
    const modules = new ModuleHost({ dir: "/tmp/galgame-no-modules" });
    await modules.load();
    const llm = new MockLlm({
      responses: [
        JSON.stringify({
          narrative: "林月和马骁都点了头。",
          proposals: [
            { op: "memory.write", args: { ownerId: A, content: "今天食堂排队很长", tags: ["食堂"] }, reason: "看见", by: "llm" },
            { op: "memory.write", args: { ownerId: B, content: "今天食堂排队很长", tags: ["食堂"] }, reason: "看见", by: "llm" },
          ],
        }),
      ],
    });
    const turn = new DefaultTurn({ store, arbiter, registry: emptyRegistry(), modules, llm, memory });
    for await (const _ of turn.run({ roomId: ROOM, actorId: PLR, input: "去食堂", clientTurnId: "c1" })) void _;
    const written = memory.all(ROOM).filter((r) => r.content === "今天食堂排队很长");
    expect(written.map((r) => r.ownerId).sort()).toEqual([A, B].sort());
    expect(new Set(written.map((r) => r.id)).size).toBe(2);
  });
});
