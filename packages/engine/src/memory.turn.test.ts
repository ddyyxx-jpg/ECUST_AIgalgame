/**
 * P1 集成契约（docs/08 §10）：记忆接通回合流水线。
 * 断言事件与结构，不断言 LLM 文案。
 */
import { describe, expect, it } from "vitest";
import type { Envelope, Entity, TurnEvent } from "../../shared/src/index.ts";
import { MockLlm } from "../../llm/src/mock.ts";
import { DefaultArbiter } from "./arbiter.ts";
import type { ArbiterLimits } from "./arbiter.ts";
import { EventSourcedStore } from "./store.ts";
import { emptyRegistry } from "./registry.ts";
import { DefaultTurn } from "./turn.ts";
import { ModuleHost } from "./modules.ts";
import { EventSourcedMemory, estimateTokens } from "./memory.ts";
import { INJECT_BUDGET } from "./turn.memory.ts";

const ROOM = "room_t";
const PLR = "plr_self";
const NPC = "npc_lin";
const GATE = "loc_gate";

function entity(id: string, kind: string, name: string, attrs: Record<string, number | string> = {}): Entity {
  return { id, kind: kind as Entity["kind"], name, attrs, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 };
}

function env(seq: number, type: string, payload: unknown): Envelope {
  return { v: 1, id: `evt_seed_${seq}`, roomId: ROOM, seq, ts: 1000 + seq, actorId: "system", type, payload };
}

async function makeTurn(opts: { llm: MockLlm; limits?: Partial<ArbiterLimits>; memory?: EventSourcedMemory }) {
  const store = new EventSourcedStore({ worldId: "w1", locId: GATE });
  store.append(ROOM, [
    env(1, "entity.created", { entity: entity(GATE, "loc", "校门") }),
    env(2, "entity.created", { entity: entity(PLR, "plr", "我") }),
    env(3, "entity.created", { entity: entity(NPC, "npc", "林月", { guard: 10 }) }),
    env(4, "scene.changed", { locId: GATE, presentIds: [PLR, NPC] }),
  ]);
  const memory = opts.memory ?? new EventSourcedMemory();
  const arbiter = new DefaultArbiter({ store, registry: emptyRegistry(), memories: memory, ...(opts.limits ? { limits: opts.limits } : {}) });
  const modules = new ModuleHost({ dir: "/tmp/galgame-no-modules" });
  await modules.load();
  const turn = new DefaultTurn({ store, arbiter, registry: emptyRegistry(), modules, llm: opts.llm, memory });
  return { store, memory, arbiter, turn };
}

async function collect(it: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

function reply(memory: unknown[] = [], narrative = "你站在校门口，风把梧桐叶吹得沙沙响。"): string {
  return JSON.stringify({ narrative, dialogue: "来了？", proposals: [], memory });
}

describe("Turn × Memory（P1）", () => {
  it("首轮没有记忆时种下第一条（NPC 记得第一次见面）", async () => {
    const llm = new MockLlm({ responses: [reply()] });
    const { turn, memory } = await makeTurn({ llm });
    await collect(turn.run({ roomId: ROOM, actorId: PLR, input: "你好", clientTurnId: "c1" }));
    const mine = memory.all(ROOM).filter((r) => r.ownerId === NPC);
    const long = mine.filter((r) => r.tier === "long");
    expect(long).toHaveLength(1);
    expect(long[0]?.content).toContain("第一次见到");
    // 本回合还写一条 short 工作记忆（最近对话，issue #21-2）；长期记忆仍只有种子一条
    expect(mine.some((r) => r.tier === "short")).toBe(true);
  });

  it("下一回合把记忆注入提示词（NPC 不会每次都是初次见面）", async () => {
    const llm = new MockLlm({ responses: [reply(), reply()] });
    const { turn } = await makeTurn({ llm });
    await collect(turn.run({ roomId: ROOM, actorId: PLR, input: "你好", clientTurnId: "c1" }));
    await collect(turn.run({ roomId: ROOM, actorId: PLR, input: "又见面了", clientTurnId: "c2" }));
    const prompt = llm.lastRequest?.messages[0]?.content ?? "";
    expect(prompt).toContain("第一次见到");
    expect(prompt).toContain("你（NPC）还记得更早以前的事");
  });

  it("注入预算硬顶 1100 token：塞 30 条长记忆也不会撑爆提示词", async () => {
    const memory = new EventSourcedMemory();
    const events: Envelope[] = [];
    for (let i = 1; i <= 30; i += 1) {
      events.push({
        v: 1, id: `evt_${i}`, roomId: ROOM, seq: i, ts: 1000 + i, actorId: PLR, type: "memory.written",
        payload: { memoryId: `mem_${i}`, ownerId: NPC, content: `第 ${i} 次见面时他穿着深色外套，站在图书馆门口等了很久`, tags: ["见面"], salience: 4, about: [PLR], tier: "long", turn: i, at: i },
      });
    }
    memory.sync(ROOM, events);
    const llm = new MockLlm({ responses: [reply()] });
    const { turn } = await makeTurn({ llm, memory });
    await collect(turn.run({ roomId: ROOM, actorId: PLR, input: "在吗", clientTurnId: "c1" }));
    const prompt = llm.lastRequest?.messages[0]?.content ?? "";
    const start = prompt.indexOf("这个世界已经知道的事");
    const from = start >= 0 ? start : prompt.indexOf("你（NPC）还记得更早以前的事");
    const end = prompt.indexOf("只输出 JSON");
    const block = prompt.slice(from, end);
    expect(estimateTokens(block)).toBeLessThanOrEqual(INJECT_BUDGET + 60);
  });

  it("越权记忆被闸门丢弃：关于不在场的人，不许被记住", async () => {
    const llm = new MockLlm({ responses: [reply([{ content: "赵宁昨晚在实验室砸了东西", about: ["npc_zhao"], salience: 5 }])] });
    const { turn, memory } = await makeTurn({ llm });
    const evs = await collect(turn.run({ roomId: ROOM, actorId: PLR, input: "昨晚发生了什么", clientTurnId: "c1" }));
    const facts = evs.flatMap((e) => (e.type === "turn.facts" ? e.facts : []));
    expect(facts.some((f) => f.includes("记忆校准"))).toBe(true);
    expect(memory.all(ROOM).some((r) => r.content.includes("砸了东西"))).toBe(false);
  });

  it("同回合多条记忆不会撞 id（旧实现按 tags.length 会撞）", async () => {
    const llm = new MockLlm({
      responses: [reply([
        { content: "他问我要了课表", tags: ["课表"], salience: 3 },
        { content: "他说下周要考试", tags: ["考试"], salience: 3 },
      ])],
    });
    const { turn, memory } = await makeTurn({ llm });
    await collect(turn.run({ roomId: ROOM, actorId: PLR, input: "聊两句", clientTurnId: "c1" }));
    const ids = memory.all(ROOM).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    // 种子 + 两条模型记忆 = 3，已达每 owner 每回合上限，最近对话让位（docs/07 §4.2 取舍）
    expect(memory.all(ROOM)).toHaveLength(3);
  });

  it("记忆被 Arbiter 拒绝时：只多一条 fact、不重问模型、行动照常生效", async () => {
    const llm = new MockLlm({ responses: [reply([{ content: "他把伞还给了我", tags: ["伞"], salience: 4 }])] });
    // memoryContentMax 调小：闸门（200）放行、Arbiter（8）拒绝 → 走两阶段裁决
    const { turn, store, memory } = await makeTurn({ llm, limits: { memoryContentMax: 8 } });
    const evs = await collect(turn.run({ roomId: ROOM, actorId: PLR, input: "还你伞", clientTurnId: "c1" }));
    expect(llm.calls).toBe(1);
    expect(evs.at(-1)?.type).toBe("turn.commit");
    const facts = evs.flatMap((e) => (e.type === "turn.facts" ? e.facts : []));
    expect(facts.some((f) => f.includes("记忆写入被拒"))).toBe(true);
    expect(memory.all(ROOM)).toHaveLength(0);
    expect((await store.events(ROOM, 0)).some((e) => e.type === "memory.written")).toBe(false);
  });

  it("事件重建一致：换一个进程从日志同步，得到的记忆完全相同", async () => {
    const llm = new MockLlm({ responses: [reply([{ content: "他把伞还给了我", tags: ["伞"], salience: 4 }])] });
    const { turn, store, memory } = await makeTurn({ llm });
    await collect(turn.run({ roomId: ROOM, actorId: PLR, input: "还你伞", clientTurnId: "c1" }));
    const before = memory.all(ROOM).map((r) => `${r.id}|${r.content}|${r.tier}`);
    const rebuilt = new EventSourcedMemory();
    rebuilt.sync(ROOM, await store.events(ROOM, 0));
    const after = rebuilt.all(ROOM).map((r) => `${r.id}|${r.content}|${r.tier}`);
    expect(after).toEqual(before);
    expect(before.length).toBeGreaterThan(0);
  });
});
