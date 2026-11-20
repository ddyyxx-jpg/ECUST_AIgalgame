/**
 * 审核层测试：叙事在发给玩家之前必须过审核器；违规 → 拦截 + 警告 + 扣信誉；信誉归零 → 删档。
 * 这里用 FakeAudit 注入判定结果，验证"引擎怎么处置"，不验证"模型判得准不准"（那要真人评测集）。
 */
import { describe, expect, it } from "vitest";
import { MockLlm } from "../../llm/src/mock.ts";
import { DefaultArbiter } from "./arbiter.ts";
import { EventSourcedStore } from "./store.ts";
import { JsonRegistry } from "./registry.ts";
import { DefaultTurn } from "./turn.ts";
import { ModuleHost } from "./modules.ts";
import { InMemoryMemory } from "./memory.ts";
import type { AuditPolicy, AuditPort, AuditInput, AuditVerdict } from "./audit.ts";
import { DEFAULT_AUDIT_POLICY } from "./audit.ts";
import type { Entity, Envelope, Registry, TurnEvent } from "../../shared/src/index.ts";

const ROOM = "room_audit";

class FakeAudit implements AuditPort {
  calls = 0;
  readonly texts: string[] = [];
  constructor(private readonly decide: (text: string) => AuditVerdict | Error) {}
  async review(input: AuditInput): Promise<AuditVerdict> {
    this.calls += 1;
    this.texts.push(input.text);
    const r = this.decide(input.text);
    if (r instanceof Error) throw r;
    return r;
  }
}

const allow: AuditVerdict = { allow: true, categories: [], severity: 0, reason: "ok" };const deny = (cats: string[], severity = 3): AuditVerdict => ({ allow: false, categories: cats, severity, reason: "测试判定" });

/** 模型输出里带一条"给自己加信誉"的提案：审核拦截后它绝不能生效 */
const riskyJson = JSON.stringify({
  narrative: "（一段违规叙事）",
  dialogue: "",
  proposals: [{ op: "attr.delta", args: { entityId: "plr_self", key: "reputation", delta: 5 }, reason: "自己加声望" }],
});

const player: Entity = {
  id: "plr_self",
  kind: "plr",
  name: "我",
  attrs: { reputation: 40 },
  tags: [],
  origin: "seed",
  canon: false,
  status: "active",
  createdAt: 0,
  updatedAt: 0,
};

const gate: Entity = {
  id: "loc_gate",
  kind: "loc",
  name: "校门",
  attrs: {},
  tags: [],
  origin: "seed",
  canon: true,
  status: "active",
  createdAt: 0,
  updatedAt: 0,
};

/**
 * 测试策略：显式声明属性名（policy.json 就是这么写的）。
 * 引擎默认策略里不出现任何属性名（I2），所以这里不能直接用 DEFAULT_AUDIT_POLICY。
 */
const TEST_POLICY: AuditPolicy = {
  ...DEFAULT_AUDIT_POLICY,
  reputationKey: "reputation",
  strikesKey: "x.audit.strikes",
};

async function makeTurn(audit: AuditPort, registry: Registry, policy: AuditPolicy = TEST_POLICY, raw = riskyJson) {
  const store = new EventSourcedStore({ worldId: "w", locId: "loc_gate" });
  const seed: Envelope[] = [
    { v: 1, id: "evt_seed", roomId: ROOM, seq: 1, ts: 0, actorId: "system", type: "entity.created", payload: { entity: player } },
    { v: 1, id: "evt_seed_loc", roomId: ROOM, seq: 2, ts: 0, actorId: "system", type: "entity.created", payload: { entity: gate } },
  ];
  await store.append(ROOM, seed);
  const arbiter = new DefaultArbiter({ store, registry });
  const modules = new ModuleHost({ dir: "/tmp/galgame-no-modules" });
  await modules.load();
  const llm = new MockLlm({ handler: () => raw });
  const turn = new DefaultTurn({ store, arbiter, registry, modules, llm, memory: new InMemoryMemory(), audit, auditPolicy: policy });
  return { store, turn, llm };
}

async function collect(it: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const registry = await JsonRegistry.load();
const run = (turn: DefaultTurn, id: string) =>
  collect(turn.run({ roomId: ROOM, actorId: "plr_self", input: "测试输入", clientTurnId: id }));

describe("审核层：拦截 / 警告 / 扣信誉 / 删档", () => {
  it("审核通过时正常出叙事，且确实审了这段文本", async () => {
    const audit = new FakeAudit(() => allow);
    const { turn } = await makeTurn(audit, registry);
    const evs = await run(turn, "c1");
    expect(audit.calls).toBe(1);
    const delta = evs.find((e) => e.type === "turn.delta");
    expect(delta && delta.type === "turn.delta" ? delta.text : "").toContain("违规叙事");
    expect(evs.at(-1)?.type).toBe("turn.commit");
  });

  it("默认策略里不含任何具体属性名：没配 policy.json 就跳过扣分，只警告 + 留痕", async () => {
    // I2：引擎默认值不许出现 "reputation" 这类字段名，属性名只能来自 policy.json
    expect(DEFAULT_AUDIT_POLICY.reputationKey).toBe("");
    expect(DEFAULT_AUDIT_POLICY.strikesKey).toBe("");

    const audit = new FakeAudit(() => deny(["harm"]));
    const { turn, store } = await makeTurn(audit, registry, DEFAULT_AUDIT_POLICY);
    const evs = await run(turn, "c_nokey");

    expect(evs.at(-1)?.type).toBe("turn.commit");
    const state = await store.snapshot(ROOM);
    // 不猜字段：属性一个都没动
    expect(state.entities["plr_self"]?.attrs["reputation"]).toBe(40);
    expect(state.entities["plr_self"]?.attrs["x.audit.strikes"]).toBeUndefined();
    const facts = evs.find((e) => e.type === "turn.facts");
    expect(facts && facts.type === "turn.facts" ? facts.facts.join("\n") : "").toContain("信誉属性未配置");
  });

  it("severity 1（轻微）不拦", async () => {
    const audit = new FakeAudit(() => deny(["violence"], 1));
    const { turn } = await makeTurn(audit, registry);
    const evs = await run(turn, "c2");
    const delta = evs.find((e) => e.type === "turn.delta");
    expect(delta && delta.type === "turn.delta" ? delta.text : "").not.toContain("内容审核");
    expect(evs.at(-1)?.type).toBe("turn.commit");
  });

  it("违规：叙事被替换成警告、扣信誉、记一次警告，模型提案不落库", async () => {
    const audit = new FakeAudit(() => deny(["sexual"]));
    const { turn, store } = await makeTurn(audit, registry);
    const evs = await run(turn, "c3");

    const delta = evs.find((e) => e.type === "turn.delta");
    expect(delta && delta.type === "turn.delta" ? delta.text : "").toContain("内容审核");
    expect(delta && delta.type === "turn.delta" ? delta.text : "").toContain("色情");

    const state = await store.snapshot(ROOM);
    // 40 - 15 = 25；模型那条 +5 的提案必须被丢弃
    expect(state.entities["plr_self"]?.attrs["reputation"]).toBe(25);
    expect(state.entities["plr_self"]?.attrs["x.audit.strikes"]).toBe(1);
    expect(evs.at(-1)?.type).toBe("turn.commit");
  });

  it("连续违规到信誉归零：标记删档，之后拒绝接待该玩家", async () => {
    const audit = new FakeAudit(() => deny(["politics"]));
    const { turn, store } = await makeTurn(audit, registry);

    await run(turn, "d1"); // 40 → 25
    await run(turn, "d2"); // 25 → 10
    const third = await run(turn, "d3"); // 10 → 0 且删档
    const delta = third.find((e) => e.type === "turn.delta");
    expect(delta && delta.type === "turn.delta" ? delta.text : "").toContain("档案已删除");

    const state = await store.snapshot(ROOM);
    expect(state.entities["plr_self"]?.attrs["reputation"]).toBe(0);
    expect(state.room.scene.props).toContain("purged");

    const after = await run(turn, "d4");
    const err = after.find((e) => e.type === "turn.error");
    expect(err && err.type === "turn.error" ? err.code : "").toBe("E_FORBIDDEN");
    expect(audit.calls).toBe(3); // 第 4 回合根本没走到模型
  });

  it("审核器故障：文本不下发、提案不采信，但不惩罚玩家", async () => {
    const audit = new FakeAudit(() => new Error("audit timeout"));
    const { turn, store } = await makeTurn(audit, registry);
    const evs = await run(turn, "e1");

    const delta = evs.find((e) => e.type === "turn.delta");
    expect(delta && delta.type === "turn.delta" ? delta.text : "").toContain("审核服务暂时不可用");
    const state = await store.snapshot(ROOM);
    expect(state.entities["plr_self"]?.attrs["reputation"]).toBe(40);
    expect(evs.at(-1)?.type).toBe("turn.commit");
  });
});

describe("PR #123：审核拦截的幂等与提交证据", () => {
  it("消费器 break + 同 key 重发：不重复惩罚，marker 不含被拒正文（P0-B/P1-3）", async () => {
    const audit = new FakeAudit(() => deny(["harm"]));
    const { turn, store } = await makeTurn(audit, registry);
    const req = { roomId: ROOM, actorId: "plr_self", input: "测试输入", clientTurnId: "blocked_break" };

    const first: TurnEvent[] = [];
    for await (const ev of turn.run(req)) {
      first.push(ev);
      if (ev.type === "turn.commit") break; // 模拟 routes.ts 的 SSE 消费者
    }
    expect(first.at(-1)?.type).toBe("turn.commit");
    const seqAfterFirst = await store.seq(ROOM);
    const markers = (await store.events(ROOM, 0)).filter((e) => e.type === "turn.committed");
    expect(markers).toHaveLength(1);
    const payload = markers[0]?.payload as { narrative?: string; facts?: unknown };
    expect(payload.narrative).toBeUndefined();
    expect(payload.facts).toBeUndefined();

    const replay = await collect(turn.run(req));
    expect(audit.calls).toBe(1); // 第二次没再问审核模型
    expect(await store.seq(ROOM)).toBe(seqAfterFirst); // 没有新落库
    expect((await store.events(ROOM, 0)).filter((e) => e.type === "turn.committed")).toHaveLength(1);
    expect(replay.map((e) => e.type)).toEqual(first.map((e) => e.type));
  });
});
