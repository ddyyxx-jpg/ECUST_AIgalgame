/**
 * 世界印象（P4）的两端契约：
 *   ① Turn 侧：pending 的 notice 变成 facts 的一行，提交后才标记已投递；
 *   ② 状态：投递是用户投影（文件），不是世界状态——重建/重启后不会重复轰炸。
 */
import { describe, expect, it } from "vitest";
import type { Envelope, Entity, ImpressionNotice, TurnEvent } from "../../shared/src/index.ts";
import { MockLlm } from "../../llm/src/mock.ts";
import { DefaultArbiter } from "./arbiter.ts";
import { EventSourcedStore } from "./store.ts";
import { emptyRegistry } from "./registry.ts";
import { DefaultTurn } from "./turn.ts";
import { ModuleHost } from "./modules.ts";
import { EventSourcedMemory } from "./memory.ts";
import { buildImpression, impressionFact, pendingNotices } from "./impressions.ts";
import type { Impressions } from "./impressions.ts";

const ROOM = "room_imp";
const PLR = "plr_self";
const NPC = "npc_lin";
const GATE = "loc_gate";

function entity(id: string, kind: string, name: string): Entity {
  return { id, kind: kind as Entity["kind"], name, attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 };
}

function env(seq: number, type: string, payload: unknown): Envelope {
  return { v: 1, id: `evt_${seq}`, roomId: ROOM, seq, ts: 1000 + seq, actorId: "system", type, payload };
}

function notice(over: Partial<ImpressionNotice> = {}): ImpressionNotice {
  return { id: "imp_1", memoryId: "mem_1", userId: "u_a", worldId: "w1", subjectText: "在校门口帮人捡起散落的书", createdAt: 1000, ...over };
}

class FakeImpressions implements Impressions {
  delivered: string[][] = [];
  constructor(private readonly list: ImpressionNotice[]) {}
  async pending(): Promise<ImpressionNotice[]> {
    return this.list.slice(0, 2);
  }
  async markDelivered(notices: ImpressionNotice[]): Promise<void> {
    this.delivered.push(notices.map((n) => n.id));
  }
}

async function makeTurn(impressions?: Impressions) {
  const store = new EventSourcedStore({ worldId: "w1", locId: GATE });
  store.append(ROOM, [
    env(1, "entity.created", { entity: entity(GATE, "loc", "校门") }),
    env(2, "entity.created", { entity: entity(PLR, "plr", "我") }),
    env(3, "entity.created", { entity: entity(NPC, "npc", "林月") }),
    env(4, "scene.changed", { locId: GATE, presentIds: [PLR, NPC] }),
  ]);
  const memory = new EventSourcedMemory();
  const arbiter = new DefaultArbiter({ store, registry: emptyRegistry(), memories: memory });
  const modules = new ModuleHost({ dir: "/tmp/galgame-no-modules" });
  await modules.load();
  const llm = new MockLlm({ responses: [JSON.stringify({ narrative: "风从走廊穿过。", proposals: [], memory: [] })] });
  const turn = new DefaultTurn({ store, arbiter, registry: emptyRegistry(), modules, llm, memory, ...(impressions ? { impressions } : {}) });
  return { turn, llm };
}

async function collect(it: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe("世界印象（P4）", () => {
  it("buildImpression：太短的不生成，长的截断到 40 字，正文去掉引号换行", () => {
    expect(buildImpression({ memoryId: "m1", userId: "u_a", worldId: "w1", content: "你好" })).toBeNull();
    const n = buildImpression({ memoryId: "m1", userId: "u_a", worldId: "w1", content: `"他在校门口\n帮人捡起散落的书，然后默默走开了，据说是常事"` });
    expect(n?.subjectText.length).toBeLessThanOrEqual(40);
    expect(n?.subjectText).not.toContain("\n");
  });

  it("impressionFact：有 NPC 名字就用名字，没有就是「这个世界」", () => {
    expect(impressionFact(notice(), "林月")).toContain("林月记住了你");
    expect(impressionFact(notice({ npcId: undefined }))).toContain("这个世界记住了你");
  });

  it("pendingNotices：过期的、已投递的都不再出现，最多 2 条，按时间升序", () => {
    const list = [
      ...Array.from({ length: 4 }, (_, i) => notice({ id: `n${i}`, memoryId: `m${i}`, createdAt: 1000 + i })),
      notice({ id: "old", memoryId: "mold", createdAt: 1000 - 31 * 24 * 3600 * 1000 }),
      notice({ id: "done", memoryId: "mdone", deliveredAt: 5 }),
    ];
    const out = pendingNotices(list, { ttlDays: 30, now: 1000 + 3, limit: 2 });
    expect(out.map((n) => n.id)).toEqual(["n0", "n1"]);
  });

  it("Turn：有印象时 facts 里出现一行，且只在该回合提交后标记投递", async () => {
    const fake = new FakeImpressions([notice(), notice({ id: "imp_2", memoryId: "mem_2", subjectText: "在食堂帮人垫了饭钱" })]);
    const { turn } = await makeTurn(fake);
    const evs = await collect(turn.run({ roomId: ROOM, actorId: PLR, input: "你好", clientTurnId: "c1", userId: "u_a" }));
    expect(evs.at(-1)?.type).toBe("turn.commit");
    const facts = evs.flatMap((e) => (e.type === "turn.facts" ? e.facts : []));
    expect(facts.filter((f) => f.startsWith("【世界印象】"))).toHaveLength(2);
    expect(fake.delivered).toEqual([["imp_1", "imp_2"]]);
  });

  it("Turn：失败回合不标记投递（下次还能看到），没有 userId 时不投递", async () => {
    const fake = new FakeImpressions([notice()]);
    const { turn } = await makeTurn(fake);
    await collect(turn.run({ roomId: ROOM, actorId: PLR, input: "你好", clientTurnId: "c1" }));
    expect(fake.delivered).toHaveLength(0);

    const broken = new FakeImpressions([notice()]);
    const { turn: t2 } = await makeTurn(broken);
    const evs = await collect(t2.run({ roomId: ROOM, actorId: PLR, input: "你好", clientTurnId: "c2", options: { expectedSeq: 999 } }));
    expect(evs.at(-1)?.type).toBe("turn.rejected");
    expect(broken.delivered).toHaveLength(0);
  });

});
