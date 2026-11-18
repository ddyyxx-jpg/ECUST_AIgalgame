/**
 * 回合幂等（issue #34）：同一 clientTurnId 只结算一次，且提交前完成全部收尾记账。
 * 这里模拟 apps/server 的 `for await ... { if (commit) break; }` 消费方式：
 * 生成器在 commit 之后的代码永远不会被上游执行，所以记账必须在 yield 之前做完。
 */
import { describe, expect, it } from "vitest";
import type { ImpressionNotice, LlmPort, LlmRequest, LlmResult, TurnEvent } from "../../shared/src/index.ts";
import { DefaultArbiter } from "./arbiter.ts";
import { EventSourcedStore } from "./store.ts";
import { emptyRegistry } from "./registry.ts";
import { DefaultTurn } from "./turn.ts";
import { ModuleHost } from "./modules.ts";
import { InMemoryMemory } from "./memory.ts";
import type { Impressions } from "./impressions.ts";

const ROOM = "room_i";
const ACTOR = "plr_self";

function settlement(itemId: string): string {
  return JSON.stringify({
    narrative: "他把一本书放在桌上。",
    dialogue: "",
    proposals: [{ op: "entity.create", args: { id: itemId, kind: "item", name: "纸条" } }],
  });
}

function scriptedLlm(raws: string[]): LlmPort & { calls: number } {
  const port = {
    calls: 0,
    async chat(_req: LlmRequest): Promise<LlmResult> {
      port.calls += 1;
      const raw = raws[Math.min(port.calls - 1, raws.length - 1)]!;
      return { raw, usage: { promptTokens: 1, completionTokens: 1, calls: 1 }, model: "idem-test", latencyMs: 0 };
    },
  };
  return port;
}

/** 闸门挡住第一次模型调用，让两个同 key 请求真正并发 */
function gatedLlm(raw: string): { llm: LlmPort & { calls: number }; open: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const port = {
    calls: 0,
    async chat(_req: LlmRequest): Promise<LlmResult> {
      port.calls += 1;
      await gate;
      return { raw, usage: { promptTokens: 1, completionTokens: 1, calls: 1 }, model: "idem-test", latencyMs: 0 };
    },
  };
  return { llm: port, open: release };
}

async function makeTurn(llm: LlmPort, impressions?: Impressions) {
  const store = new EventSourcedStore({ worldId: "w", locId: "loc_gate" });
  const arbiter = new DefaultArbiter({ store, registry: emptyRegistry() });
  const modules = new ModuleHost({ dir: "/tmp/galgame-no-modules" });
  await modules.load();
  const turn = new DefaultTurn({
    store, arbiter, registry: emptyRegistry(), modules, llm, memory: new InMemoryMemory(),
    ...(impressions ? { impressions } : {}),
  });
  return { store, turn };
}

async function collect(it: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

function commitSeq(events: TurnEvent[]): number {
  const commit = events.at(-1);
  return commit?.type === "turn.commit" ? commit.seq : -1;
}

/** 等异步生成器推进到模型调用处（只走微任务，不用定时器） */
async function tick(until: () => boolean, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts && !until(); i += 1) await Promise.resolve();
}

class SpyImpressions implements Impressions {
  delivered: string[][] = [];
  constructor(private readonly notice: ImpressionNotice) {}
  async pending(): Promise<ImpressionNotice[]> { return [this.notice]; }
  async markDelivered(notices: ImpressionNotice[]): Promise<void> {
    this.delivered.push(notices.map((n) => n.id));
  }
}

describe("Turn 幂等（issue #34）", () => {
  it("串行重放：相同 key 不重复结算（模型不再调用，实体只创建一次）", async () => {
    const llm = scriptedLlm([settlement("item_serial")]);
    const { turn, store } = await makeTurn(llm);
    const req = { roomId: ROOM, actorId: ACTOR, input: "放东西", clientTurnId: "serial" };
    const a = await collect(turn.run(req));
    const b = await collect(turn.run(req));
    expect(llm.calls).toBe(1);
    expect(b.map((e) => e.type)).toEqual(a.map((e) => e.type));
    expect(commitSeq(b)).toBe(commitSeq(a));
    expect(commitSeq(a)).toBeGreaterThanOrEqual(0);
    const created = (await store.events(ROOM, 0)).filter((e) => e.type === "entity.created");
    expect(created).toHaveLength(1);
  });

  it("并发同 key：只结算一次，两个请求都拿到同一回合的提交结果", async () => {
    const { llm, open } = gatedLlm(settlement("item_race"));
    const { turn, store } = await makeTurn(llm);
    const req = { roomId: ROOM, actorId: ACTOR, input: "放东西", clientTurnId: "race" };
    const first = collect(turn.run(req));
    await tick(() => llm.calls === 1); // 第一个已经进到模型调用处
    const second = collect(turn.run(req));
    await tick(() => false, 10); // 让后来者走到 inFlight 等待点
    expect(llm.calls).toBe(1); // 后来者在等，不会二次调模型
    open();
    const [a, b] = await Promise.all([first, second]);
    expect(llm.calls).toBe(1);
    expect(a.filter((e) => e.type === "turn.commit")).toHaveLength(1);
    expect(b.filter((e) => e.type === "turn.commit")).toHaveLength(1);
    expect(commitSeq(b)).toBe(commitSeq(a));
    const created = (await store.events(ROOM, 0)).filter((e) => e.type === "entity.created");
    expect(created).toHaveLength(1);
  });

  it("不同房间 / 不同 actor 使用同一个 clientTurnId：各自独立结算", async () => {
    const llm = scriptedLlm([settlement("item_room_a"), settlement("item_room_b"), settlement("item_actor")]);
    const { turn, store } = await makeTurn(llm);
    const ids = ["room_a", "room_b", ROOM];
    const actors = [ACTOR, ACTOR, "plr_other"];
    for (let i = 0; i < ids.length; i += 1) {
      const evs = await collect(turn.run({ roomId: ids[i]!, actorId: actors[i]!, input: "放东西", clientTurnId: "shared" }));
      expect(commitSeq(evs)).toBeGreaterThanOrEqual(0); // 每个请求都拿到自己的 commit；结算次数由下面的 entity.created 验证
    }
    expect(llm.calls).toBe(3);
    for (const room of ids) {
      expect((await store.events(room, 0)).filter((e) => e.type === "entity.created")).toHaveLength(1);
    }
  });

  it("HTTP 式 break on commit：seen 与印象投递在 commit 之前已记账，重放不重复投递", async () => {
    const notice: ImpressionNotice = {
      id: "imp_1", memoryId: "mem_1", userId: "u_a", worldId: "w",
      subjectText: "林月记住了你刚才说的话", createdAt: 1000,
    };
    const impressions = new SpyImpressions(notice);
    const llm = scriptedLlm([settlement("item_break")]);
    const { turn } = await makeTurn(llm, impressions);
    const req = { roomId: ROOM, actorId: ACTOR, input: "放东西", clientTurnId: "break", userId: "u_a" };

    // apps/server/src/routes.ts 的消费者：commit 一到就 break（yield 之后的代码不会跑）
    const first: TurnEvent[] = [];
    for await (const ev of turn.run(req)) {
      first.push(ev);
      if (ev.type === "turn.commit") break;
    }
    expect(first.at(-1)?.type).toBe("turn.commit");
    expect(impressions.delivered).toEqual([["imp_1"]]);

    const replay = await collect(turn.run(req));
    expect(llm.calls).toBe(1);
    expect(replay.map((e) => e.type)).toEqual(first.map((e) => e.type));
    expect(impressions.delivered).toHaveLength(1); // 重放不重复标记投递
  });
});
