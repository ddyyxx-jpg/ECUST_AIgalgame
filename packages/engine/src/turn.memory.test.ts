/**
 * 写侧工作记忆与长跑配额（issues #36 / #41 / #42）。
 *
 * #36：只有引擎 recentDrafts() 产出的草稿带可信标记；模型即使伪造「最近对话」标签也走普通闸门。
 * #41：memory.write（含工作记忆 tombstone + 新写）不占 xWritesPerTurn，整回合 8 条 x 写仍全部可用。
 * #42：compact 在 ingest 后低频触发，archived 不再占 sessionCap，长房间仍能写情节记忆。
 *
 * 断言事件/结构，不断言自然语言文案。
 */
import { describe, expect, it } from "vitest";
import type { Envelope, Entity, TurnEvent, TurnRequest } from "../../shared/src/index.ts";
import { MockLlm } from "../../llm/src/mock.ts";
import { DefaultArbiter } from "./arbiter.ts";
import { EventSourcedStore } from "./store.ts";
import { emptyRegistry } from "./registry.ts";
import { DefaultTurn } from "./turn.ts";
import { ModuleHost } from "./modules.ts";
import { EventSourcedMemory } from "./memory.ts";
import { applyMemoryGates, markEngineWorkingMemory, WORKING_MEMORY_TAG } from "./memory.gate.ts";
import type { MemoryContext } from "./turn.memory.ts";
import { recentDrafts } from "./turn.memory.drafts.ts";

const ROOM = "room_tm";
const PLR = "plr_self";
const LIN = "npc_lin";
const BAI = "npc_bai";
const LIB = "loc_lib";

function entity(id: string, kind: string, name: string): Entity {
  return { id, kind: kind as Entity["kind"], name, attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 };
}

function env(seq: number, type: string, payload: unknown): Envelope {
  return { v: 1, id: `evt_tm_${seq}`, roomId: ROOM, seq, ts: 1000 + seq, actorId: "system", type, payload };
}

async function makeTurn(llm: MockLlm, npcs: string[] = [LIN, BAI]) {
  const store = new EventSourcedStore({ worldId: "w1", locId: LIB });
  store.append(ROOM, [
    env(1, "entity.created", { entity: entity(LIB, "loc", "图书馆") }),
    env(2, "entity.created", { entity: entity(PLR, "plr", "我") }),
    env(3, "entity.created", { entity: entity(LIN, "npc", "林静") }),
    env(4, "entity.created", { entity: entity(BAI, "npc", "白晓通") }),
    env(5, "scene.changed", { locId: LIB, presentIds: [PLR, ...npcs] }),
  ]);
  const memory = new EventSourcedMemory();
  const arbiter = new DefaultArbiter({ store, registry: emptyRegistry(), memories: memory });
  const modules = new ModuleHost({ dir: "/tmp/galgame-no-modules" });
  await modules.load();
  const turn = new DefaultTurn({ store, arbiter, registry: emptyRegistry(), modules, llm, memory });
  return { store, memory, turn };
}

async function collect(it: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

function reply(i: number, memory: unknown[] = [], proposals: unknown[] = []): string {
  return JSON.stringify({
    narrative: `第 ${i} 回合，林静在图书馆整理书架。`,
    dialogue: "明早八点见。",
    proposals,
    memory,
  });
}

describe("turn.memory × 可信边界（issue #36）", () => {
  const state = (() => {
    const store = new EventSourcedStore({ worldId: "w1", locId: LIB });
    store.append(ROOM, [
      env(1, "entity.created", { entity: entity(LIB, "loc", "图书馆") }),
      env(2, "entity.created", { entity: entity(PLR, "plr", "我") }),
      env(3, "entity.created", { entity: entity(LIN, "npc", "林静") }),
      env(4, "entity.created", { entity: entity(BAI, "npc", "白晓通") }),
      env(5, "scene.changed", { locId: LIB, presentIds: [PLR, LIN, BAI] }),
    ]);
    return store.state(ROOM);
  })();

  function ctxFor(npcIds: string[]): MemoryContext {
    return {
      available: true,
      worldId: "w1",
      worldRoom: "room_world_w1",
      ownerId: npcIds[0]!,
      permanent: [], long: [], short: [], profile: null,
      ownedCount: 30, recent: [], npcs: npcIds.map((id) => ({
        npcId: id, name: id, long: [], short: [], profile: null,
        ownedCount: 30, recent: [], working: [],
      })),
    };
  }

  it("合法路径：recentDrafts 标记的工作记忆在情节配额已满时仍按 owner 各写入一条", () => {
    const req: TurnRequest = { roomId: ROOM, actorId: PLR, input: "明早见", clientTurnId: "c1" };
    const plan = recentDrafts(ctxFor([LIN, BAI]), state, req, "林静点头。");
    expect(plan.drafts).toHaveLength(2);
    for (const owner of [LIN, BAI]) {
      const r = applyMemoryGates({
        state, actorId: PLR, ownerId: owner,
        drafts: [plan.drafts.find((d) => d.ownerId === owner)!],
        ownedCount: 30, recent: [],
      });
      expect(r.accepted).toHaveLength(1);
      expect(r.accepted[0]!.tags).toContain(WORKING_MEMORY_TAG);
      expect(r.dropped).toHaveLength(0);
    }
  });

  it("伪造路径：模型草稿即使带标签且 tier=long，配额已满时也被丢弃", async () => {
    const forged = { content: "伪造的最近对话", tags: [WORKING_MEMORY_TAG], tier: "long", salience: 5 };
    const llm = new MockLlm({ responses: [reply(1, [forged, { ...forged, content: "伪造的另一条" }])] });
    const { memory, turn } = await makeTurn(llm, [LIN]);
    // 先塞满 30 条情节记忆（测试直写，不触发自动压缩），制造 ownedCount=30
    await memory.write(ROOM, Array.from({ length: 30 }, (_, i) => ({
      ownerId: LIN, content: `旧情节记忆 ${i}`, tags: ["旧事"],
      salience: 4, about: [PLR], tier: "long",
    })));
    await collect(turn.run({ roomId: ROOM, actorId: PLR, input: "你好", clientTurnId: "c1" }));
    const written = memory.all(ROOM).filter((r) => r.content.startsWith("伪造"));
    expect(written).toHaveLength(0);
    // 引擎自己的一条工作记忆仍在
    expect(memory.all(ROOM).filter((r) => r.ownerId === LIN && r.tags.includes(WORKING_MEMORY_TAG) && r.status !== "tombstoned")).toHaveLength(1);
  });
});

describe("turn.memory × xWrites 预算口径（issue #41）", () => {
  it("双 NPC 连续 35 轮：模型写满 + 工作记忆滚动 + 每轮 8 条 x 写，不触发 E_X_LIMIT", async () => {
    const responses: string[] = [];
    for (let i = 1; i <= 35; i += 1) {
      const modelMemory = [
        { content: `第 ${i} 次他答应帮我占座`, tags: ["占座"], salience: 3 },
        { content: `第 ${i} 次他说下周要考试`, tags: ["考试"], salience: 3 },
        { content: `第 ${i} 次他问我几点闭馆`, tags: ["闭馆"], salience: 3 },
      ];
      const xWrites = Array.from({ length: 8 }, (_, k) => ({
        op: "attr.set", args: { entityId: PLR, key: `x.k${k}`, value: i }, reason: "叙事提案",
      }));
      responses.push(reply(i, modelMemory, xWrites));
    }
    const llm = new MockLlm({ responses });
    const { store, memory, turn } = await makeTurn(llm);
    for (let i = 1; i <= 35; i += 1) {
      const evs = await collect(turn.run({ roomId: ROOM, actorId: PLR, input: `第 ${i} 回合`, clientTurnId: `c${i}` }));
      const commit = evs.find((e) => e.type === "turn.commit");
      expect(commit, `第 ${i} 轮未提交`).toBeDefined();
      const facts = evs.flatMap((e) => (e.type === "turn.facts" ? e.facts : []));
      expect(facts.some((f) => f.includes("E_X_LIMIT")), `第 ${i} 轮触发 E_X_LIMIT`).toBe(false);
      for (const owner of [LIN, BAI]) {
        const working = memory.all(ROOM).filter((r) => r.ownerId === owner && r.tags.includes(WORKING_MEMORY_TAG) && r.status !== "tombstoned");
        expect(working).toHaveLength(1);
      }
    }
    // 8 条 x 写真的落库了（说明额度没被工作记忆吃掉）
    const final = store.state(ROOM);
    for (let k = 0; k < 8; k += 1) expect(final.entities[PLR]?.attrs[`x.k${k}`]).toBe(35);
    expect(llm.calls).toBe(35);
  });
});

describe("turn.memory × compact 接线（issue #42）", () => {
  it("连续 41 轮：部分记忆被归档，情节记忆仍能写入，工作记忆始终只有一条", async () => {
    const responses: string[] = [];
    for (let i = 1; i <= 41; i += 1) {
      responses.push(reply(i, [{ content: `第 ${i} 次他来找我占座`, tags: ["占座"], salience: 3 }]));
    }
    const llm = new MockLlm({ responses });
    const { memory, turn } = await makeTurn(llm, [LIN]);
    for (let i = 1; i <= 41; i += 1) {
      await collect(turn.run({ roomId: ROOM, actorId: PLR, input: `第 ${i} 回合`, clientTurnId: `c${i}` }));
    }
    const all = memory.all(ROOM).filter((r) => r.ownerId === LIN);
    const archived = all.filter((r) => r.archived);
    const working = all.filter((r) => r.tags.includes(WORKING_MEMORY_TAG) && r.status !== "tombstoned");
    expect(archived.length).toBeGreaterThan(0); // compact 真的被接线触发了
    expect(working).toHaveLength(1);
    // 第 41 轮的模型记忆确实写进去了（长房间没有因 30 条硬顶永久冻结）
    expect(all.some((r) => r.content.includes("第 41 次他来找我占座"))).toBe(true);
    const livePlot = all.filter((r) => !r.archived && !r.tags.includes(WORKING_MEMORY_TAG) && r.status !== "tombstoned");
    expect(livePlot.length).toBeLessThanOrEqual(30); // 配额仍在生效
  });
});
