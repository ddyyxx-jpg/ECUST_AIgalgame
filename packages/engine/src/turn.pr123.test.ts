/**
 * PR #123 打回项的真实链路回归：审核阻断回合幂等、修复证据、并发/失败后的恢复扫描。
 * 断言事件类型、幂等效果与事件日志里的证据结构，不断言模型文案。
 */
import { describe, expect, it } from "vitest";
import type { Envelope, LlmPort, LlmRequest, LlmResult, TurnEvent, TurnRequest } from "../../shared/src/index.ts";
import { DEFAULT_AUDIT_POLICY, type AuditPort } from "./audit.ts";
import { DefaultArbiter } from "./arbiter.ts";
import { InMemoryMemory } from "./memory.ts";
import { ModuleHost } from "./modules.ts";
import { emptyRegistry } from "./registry.ts";
import { EventSourcedStore, type EventLog } from "./store.ts";
import { DefaultTurn } from "./turn.ts";

const ROOM = "room_p123";
const ACTOR = "plr_self";
const KEY = "c_p123";
const REQ: TurnRequest = { roomId: ROOM, actorId: ACTOR, clientTurnId: KEY, input: "看看四周" };

function scripted(raws: string[]): LlmPort & { calls: number } {
  const port = {
    calls: 0,
    async chat(_req: LlmRequest): Promise<LlmResult> {
      port.calls += 1;
      return {
        raw: raws[Math.min(port.calls - 1, raws.length - 1)]!,
        usage: { promptTokens: 1, completionTokens: 1, calls: 1 }, model: "pr123-test", latencyMs: 0,
      };
    },
  };
  return port;
}

const NEUTRAL = JSON.stringify({ narrative: "普通叙事", dialogue: "", proposals: [] });
/** 指向不存在实体的提案：apply 必拒 → 驱动修复分支，修复版写另一段叙事 */
const BAD_FIRST = JSON.stringify({
  narrative: "被拒首版叙事", dialogue: "",
  proposals: [{ op: "attr.delta", args: { entityId: "npc_ghost", key: "guard", delta: 1 } }],
});
const BLOCKING_AUDIT: AuditPort = {
  async review() { return { allow: false, categories: ["violence"], severity: 3, reason: "pr123-test" }; },
};

async function makeTurn(store: EventLog, llm: LlmPort, audit?: AuditPort) {
  const arbiter = new DefaultArbiter({ store, registry: emptyRegistry() });
  const modules = new ModuleHost({ dir: "/tmp/galgame-no-modules" });
  await modules.load();
  return new DefaultTurn({
    store, arbiter, registry: emptyRegistry(), modules, llm, memory: new InMemoryMemory(),
    audit, auditPolicy: audit ? DEFAULT_AUDIT_POLICY : undefined,
  });
}

/** 真实 Envelope 形状（与引擎发射处一致）——手造 fixture 也必须逐字段对齐，PR #123 §12.2 */
function envelope(seq: number, type: string, payload: unknown): Envelope {
  return { v: 1, id: `e${seq}`, roomId: ROOM, seq, ts: seq, actorId: "system", type, payload } as Envelope;
}

function entity(id: string, kind: string) {
  return { id, kind, name: id, attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 };
}

async function seed(store: EventLog): Promise<void> {
  await store.append(ROOM, [
    envelope(1, "entity.created", { entity: entity(ACTOR, "plr") }),
    envelope(2, "entity.created", { entity: entity("loc_gate", "loc") }),
    envelope(3, "entity.created", { entity: entity("npc_lin", "npc") }),
    envelope(4, "scene.changed", { locId: "loc_gate", presentIds: [ACTOR, "npc_lin"] }),
  ]);
}

/** 模拟 HTTP 消费器：收到 turn.commit 立即 break，生成器后续代码永不执行 */
async function collectUntilBreak(it: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const ev of it) {
    out.push(ev);
    if (ev.type === "turn.commit") break;
  }
  return out;
}

async function counts(store: EventLog) {
  const envs = await store.events(ROOM, 0);
  return {
    markers: envs.filter((e) => e.type === "turn.committed").length,
    memWrites: envs.filter((e) => e.type === "memory.written").length,
    seq: store.seq(ROOM),
  };
}

function markerPayload(store: EventLog): Promise<Record<string, unknown> | undefined> {
  return store.events(ROOM, 0).then((envs) => {
    const marker = envs.find((e) => e.type === "turn.committed");
    return marker?.payload as Record<string, unknown> | undefined;
  });
}

describe("PR #123 阻断回合幂等与证据（真实引擎 / 事件日志）", () => {
  it("P0-B/P1-3 审核阻断后 break：同 key 重发不重复惩罚，违规叙事不进 marker", async () => {
    const store = new EventSourcedStore({ worldId: "w", locId: "loc_gate" });
    await seed(store);
    const llm = scripted([NEUTRAL]);
    const turn = await makeTurn(store, llm, BLOCKING_AUDIT);

    const first = await collectUntilBreak(turn.run(REQ));
    expect(first.at(-1)?.type).toBe("turn.commit");
    const before = await counts(store);
    expect(before.markers).toBe(1);
    expect(before.memWrites).toBeGreaterThan(0);

    const second = await collectUntilBreak(turn.run(REQ));
    expect(second.at(-1)?.type).toBe("turn.commit");
    expect(llm.calls).toBe(1);
    expect(await counts(store)).toEqual(before);
    const payload = await markerPayload(store);
    expect(payload?.clientTurnId).toBe(KEY);
    expect(payload?.narrative).toBeUndefined();
    expect(payload?.facts).toBeUndefined();
  });

  it("P1-2 修复成功：marker 记修复版叙事与修复调用的 usage", async () => {
    const store = new EventSourcedStore({ worldId: "w", locId: "loc_gate" });
    await seed(store);
    const llm = scripted([BAD_FIRST, NEUTRAL]);
    const turn = await makeTurn(store, llm);

    const events = await collectUntilBreak(turn.run(REQ));
    expect(events.at(-1)?.type).toBe("turn.commit");
    expect(llm.calls).toBe(2);
    const payload = await markerPayload(store);
    expect(payload?.narrative).toBe("普通叙事");
    // usage 取最后一次模型调用（修复调用）的用量，而不是把两次调用相加
    expect((payload?.usage as { calls: number } | undefined)?.calls).toBe(1);
  });

  it("P1-4a 重启后并发同 key：两条请求共用一次恢复扫描，只调一次 LLM", async () => {
    const store = new EventSourcedStore({ worldId: "w", locId: "loc_gate" });
    await seed(store);
    const seedLlm = scripted([NEUTRAL]);
    await collectUntilBreak((await makeTurn(store, seedLlm)).run(REQ));
    const before = await counts(store);
    expect(store.seq(ROOM)).toBeGreaterThan(2);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events = store as EventLog & { events: (r: string, f: number) => Promise<Envelope[]> };
    let scans = 0;
    const gated: EventLog = Object.create(events) as EventLog;
    gated.events = async (r: string, f: number) => {
      scans += 1;
      await gate;
      return events.events(r, f);
    };
    expect(scans).toBe(0);
    const replayLlm = scripted([NEUTRAL]);
    const fresh = await makeTurn(gated, replayLlm);
    const a = collectUntilBreak(fresh.run(REQ));
    const b = collectUntilBreak(fresh.run(REQ));
    for (let i = 0; i < 100 && scans < 1; i += 1) await Promise.resolve();
    release();
    const [first, second] = await Promise.all([a, b]);
    expect(first.at(-1)?.type).toBe("turn.commit");
    expect(second.at(-1)?.type).toBe("turn.commit");
    expect(scans).toBe(1);
    expect(replayLlm.calls).toBe(0);
    expect(await counts(store)).toEqual(before);
  });

  it("P1-4b 恢复扫描失败：不缓存失败终态，下一次请求可重试并命中幂等", async () => {
    const store = new EventSourcedStore({ worldId: "w", locId: "loc_gate" });
    await seed(store);
    const seedLlm = scripted([NEUTRAL]);
    await collectUntilBreak((await makeTurn(store, seedLlm)).run(REQ));

    const events = store as EventLog & { events: (r: string, f: number) => Promise<Envelope[]> };
    let failNext = true;
    const flaky: EventLog = Object.create(events) as EventLog;
    flaky.events = async (r: string, f: number) => {
      if (failNext) { failNext = false; throw new Error("transient scan failure"); }
      return events.events(r, f);
    };
    const replayLlm = scripted([NEUTRAL]);
    const fresh = await makeTurn(flaky, replayLlm);
    await expect(collectUntilBreak(fresh.run(REQ))).rejects.toThrow("transient scan failure");
    const retry = await collectUntilBreak(fresh.run(REQ));
    expect(retry.at(-1)?.type).toBe("turn.commit");
    expect(replayLlm.calls).toBe(0);
  });
});
