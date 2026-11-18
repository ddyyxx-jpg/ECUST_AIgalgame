/**
 * issue #20 / #21-2：多 NPC 场景的记忆归属与"最近对话"上下文。
 *
 * 断言提示词的结构与包含关系（哪些段、哪些内容、总预算），不断言自然语言文案。
 * #20 的根因：turn.memory.selectOwner 在"场景里不是恰好 1 个 NPC"时把 owner 退回玩家，
 * 于是多 NPC 场景读的是玩家名下的（空的）长期/短期记忆，NPC 自己的记忆一条都进不了 S7/S8。
 */
import { describe, expect, it } from "vitest";
import type { Envelope, Entity, TurnEvent } from "../../shared/src/index.ts";
import { MockLlm } from "../../llm/src/mock.ts";
import { DefaultArbiter } from "./arbiter.ts";
import { EventSourcedStore } from "./store.ts";
import { emptyRegistry } from "./registry.ts";
import { DefaultTurn } from "./turn.ts";
import { ModuleHost } from "./modules.ts";
import { EventSourcedMemory, estimateTokens, worldRoomId } from "./memory.ts";
import { INJECT_BUDGET } from "./turn.memory.ts";

const ROOM = "room_m";
const PLR = "plr_self";
const LIN = "npc_lin";
const BAI = "npc_bai";
const LIB = "loc_lib";
const WORLD = "w1";

function entity(id: string, kind: string, name: string, attrs: Record<string, number | string> = {}): Entity {
  return { id, kind: kind as Entity["kind"], name, attrs, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 };
}

function env(roomId: string, seq: number, type: string, payload: unknown): Envelope {
  return { v: 1, id: `evt_${roomId}_${seq}`, roomId, seq, ts: 1000 + seq, actorId: "system", type, payload };
}

function memEvent(seq: number, memoryId: string, ownerId: string, content: string, tier: "long" | "short" = "long", extra: Record<string, unknown> = {}): Envelope {
  return env(ROOM, seq, "memory.written", {
    memoryId,
    ownerId,
    content,
    tags: ["记忆", "图书馆"],
    salience: 4,
    about: [PLR],
    tier,
    turn: seq,
    at: seq,
    ...extra,
  });
}

async function makeTurn(opts: { llm: MockLlm; memory?: EventSourcedMemory; rooms?: "single" | "multi" }) {
  const store = new EventSourcedStore({ worldId: WORLD, locId: LIB });
  const present = opts.rooms === "single" ? [PLR, LIN] : [PLR, LIN, BAI];
  const seed: Envelope[] = [
    env(ROOM, 1, "entity.created", { entity: entity(LIB, "loc", "图书馆") }),
    env(ROOM, 2, "entity.created", { entity: entity(PLR, "plr", "我") }),
    env(ROOM, 3, "entity.created", { entity: entity(LIN, "npc", "林静") }),
    env(ROOM, 4, "entity.created", { entity: entity(BAI, "npc", "白晓通") }),
    env(ROOM, 5, "scene.changed", { locId: LIB, presentIds: present }),
  ];
  store.append(ROOM, seed);
  const memory = opts.memory ?? new EventSourcedMemory();
  const arbiter = new DefaultArbiter({ store, registry: emptyRegistry(), memories: memory });
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

function reply(memory: unknown[] = [], narrative = "林静把借书卡推到你面前，白晓通在旁边翻着书。"): string {
  return JSON.stringify({ narrative, dialogue: "这本书我刚还。", proposals: [], memory });
}

function promptOf(llm: MockLlm): string {
  return llm.lastRequest?.messages[0]?.content ?? "";
}

/** 记忆注入段：从第一段记忆标题到 "玩家输入：" 之前 */
function memoryBlock(prompt: string): string {
  const starts = ["这个世界已经知道的事", "你（NPC）还记得更早以前的事", "还记得更早以前的事", "还记得刚才的事"];
  const from = Math.min(...starts.map((s) => prompt.indexOf(s)).filter((i) => i >= 0));
  const to = prompt.indexOf("玩家输入：");
  if (!Number.isFinite(from) || from < 0 || to < 0) return "";
  return prompt.slice(from, to);
}

describe("多 NPC 记忆注入（issue #20）", () => {
  it("双 NPC 场景：两个 NPC 各自的记忆按归属进入提示词（#20 复现/回归）", async () => {
    const memory = new EventSourcedMemory();
    memory.sync(ROOM, [
      memEvent(6, "mem_lin_1", LIN, "林静记得玩家上周把伞落在了图书馆。"),
      memEvent(7, "mem_bai_1", BAI, "白晓通记得玩家在食堂插过队。"),
    ]);
    const llm = new MockLlm({ responses: [reply()] });
    const { turn } = await makeTurn({ llm, memory });
    await collect(turn.run({ roomId: ROOM, actorId: PLR, input: "我来还书", clientTurnId: "c1" }));
    const prompt = promptOf(llm);
    expect(prompt).toContain("林静记得玩家上周把伞落在了图书馆");
    expect(prompt).toContain("白晓通记得玩家在食堂插过队");
    // 归属必须可辨：两段记忆分别挂在各自 NPC 名下，而不是混成一段"你（NPC）"
    expect(prompt).toContain("林静（NPC）还记得更早以前的事");
    expect(prompt).toContain("白晓通（NPC）还记得更早以前的事");
  });

  it("单 NPC 场景保持现有行为（不回归）", async () => {
    const memory = new EventSourcedMemory();
    memory.sync(ROOM, [memEvent(6, "mem_lin_1", LIN, "林静记得玩家上周把伞落在了图书馆。")]);
    const llm = new MockLlm({ responses: [reply()] });
    const { turn } = await makeTurn({ llm, memory, rooms: "single" });
    await collect(turn.run({ roomId: ROOM, actorId: PLR, input: "我来还书", clientTurnId: "c1" }));
    const prompt = promptOf(llm);
    expect(prompt).toContain("你（NPC）还记得更早以前的事");
    expect(prompt).toContain("林静记得玩家上周把伞落在了图书馆");
    // 单 NPC 不出现"名字（NPC）"前缀（保持旧提示词的字节结构，缓存不白费）
    expect(prompt).not.toContain("林静（NPC）还记得");
  });

  it("世界层永久记忆（S1.5）仍然注入", async () => {
    const memory = new EventSourcedMemory();
    memory.sync(worldRoomId(WORLD), [
      env(worldRoomId(WORLD), 1, "memory.written", {
        memoryId: "mem_world_1",
        ownerId: "mem_world",
        content: "这个世界知道：校图书馆在周三闭馆。",
        tags: ["世界"],
        salience: 5,
        about: [],
        visibility: "public",
        tier: "permanent",
        worldId: WORLD,
        turn: 1,
        at: 1,
      }),
    ]);
    const llm = new MockLlm({ responses: [reply()] });
    const { turn } = await makeTurn({ llm, memory });
    await collect(turn.run({ roomId: ROOM, actorId: PLR, input: "今天开门吗", clientTurnId: "c1" }));
    const prompt = promptOf(llm);
    expect(prompt).toContain("这个世界已经知道的事");
    expect(prompt).toContain("校图书馆在周三闭馆");
  });

  it("注入总量不超过 1100 token（两个 NPC 各塞 15 条长记忆）", async () => {
    const memory = new EventSourcedMemory();
    const events: Envelope[] = [];
    let seq = 6;
    for (let i = 1; i <= 15; i += 1) {
      events.push(memEvent(seq, `mem_lin_${i}`, LIN, `林静第 ${i} 次记得：玩家在图书馆门口等了很久，手里拿着深色封面的书。`));
      seq += 1;
      events.push(memEvent(seq, `mem_bai_${i}`, BAI, `白晓通第 ${i} 次记得：玩家在食堂排队时和前面的人争论了很久。`));
      seq += 1;
    }
    memory.sync(ROOM, events);
    const llm = new MockLlm({ responses: [reply()] });
    const { turn } = await makeTurn({ llm, memory });
    await collect(turn.run({ roomId: ROOM, actorId: PLR, input: "在吗", clientTurnId: "c1" }));
    const block = memoryBlock(promptOf(llm));
    expect(block.length).toBeGreaterThan(0);
    expect(estimateTokens(block)).toBeLessThanOrEqual(INJECT_BUDGET + 60);
  });

  it("最近对话：本回合输入+叙事按 short 记忆记到每个在场 NPC，并在下一回合提示词里出现", async () => {
    const memory = new EventSourcedMemory();
    memory.sync(ROOM, [
      memEvent(6, "mem_lin_1", LIN, "林静记得玩家上周把伞落在了图书馆。"),
      memEvent(7, "mem_bai_1", BAI, "白晓通记得玩家在食堂插过队。"),
    ]);
    const llm = new MockLlm({
      responses: [reply([], "林静把借书卡推到你面前，白晓通在旁边翻着书。"), reply([], "第二天，林静在门口等你。")],
    });
    const { turn } = await makeTurn({ llm, memory });
    await collect(turn.run({ roomId: ROOM, actorId: PLR, input: "我想借《数据结构》", clientTurnId: "c1" }));
    const recent = memory.all(ROOM).filter((r) => r.ownerId === LIN && r.tier === "short");
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.some((r) => r.content.includes("我想借《数据结构》"))).toBe(true);
    const baiRecent = memory.all(ROOM).filter((r) => r.ownerId === BAI && r.tier === "short");
    expect(baiRecent.some((r) => r.content.includes("林静把借书卡推到你面前"))).toBe(true);

    await collect(turn.run({ roomId: ROOM, actorId: PLR, input: "谢谢", clientTurnId: "c2" }));
    const prompt = promptOf(llm);
    expect(prompt).toContain("还记得刚才的事");
    expect(prompt).toContain("我想借《数据结构》");
  });

  it("提示词含“不在场者不得代答”规则（#21-1 模型侧）", async () => {
    const llm = new MockLlm({ responses: [reply()] });
    const { turn } = await makeTurn({ llm });
    await collect(turn.run({ roomId: ROOM, actorId: PLR, input: "赵宁在哪", clientTurnId: "c1" }));
    const prompt = promptOf(llm);
    expect(prompt).toContain("不在场");
    expect(prompt).toContain("不得替");
  });

  it("模型产出的记忆归属到在场 NPC，不记到玩家名下", async () => {
    const memory = new EventSourcedMemory();
    memory.sync(ROOM, [
      memEvent(6, "mem_lin_1", LIN, "林静记得玩家上周把伞落在了图书馆。"),
      memEvent(7, "mem_bai_1", BAI, "白晓通记得玩家在食堂插过队。"),
    ]);
    const llm = new MockLlm({ responses: [reply([{ content: "他答应帮我占座", tags: ["占座"], salience: 3 }])] });
    const { turn } = await makeTurn({ llm, memory });
    await collect(turn.run({ roomId: ROOM, actorId: PLR, input: "帮我占个座", clientTurnId: "c1" }));
    const owners = new Set(memory.all(ROOM).filter((r) => r.content.includes("占座")).map((r) => r.ownerId));
    expect(owners.has(PLR)).toBe(false);
    expect(owners.has(LIN)).toBe(true);
    expect(owners.has(BAI)).toBe(true);
  });

  it("配额取舍：模型写满 3 条时最近对话让位（每 owner 上限 3）", async () => {
    const memory = new EventSourcedMemory();
    memory.sync(ROOM, [
      memEvent(6, "mem_lin_1", LIN, "林静记得玩家上周把伞落在了图书馆。"),
      memEvent(7, "mem_bai_1", BAI, "白晓通记得玩家在食堂插过队。"),
    ]);
    const llm = new MockLlm({
      responses: [reply([
        { content: "他把借书卡递给了我", tags: ["借书"], salience: 4 },
        { content: "他说下周要考试", tags: ["考试"], salience: 3 },
        { content: "他问我图书馆几点关门", tags: ["闭馆"], salience: 3 },
      ])],
    });
    const { turn } = await makeTurn({ llm, memory });
    await collect(turn.run({ roomId: ROOM, actorId: PLR, input: "借书", clientTurnId: "c1" }));
    for (const owner of [LIN, BAI]) {
      const mine = memory.all(ROOM).filter((r) => r.ownerId === owner);
      expect(mine.length).toBe(4); // 既有 1 条 + 模型 3 条；最近对话因配额让位
      expect(mine.some((r) => r.tags.includes("最近对话"))).toBe(false);
    }
  });
});
