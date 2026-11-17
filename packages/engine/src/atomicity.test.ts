/**
 * Issue #1 的回归测试：Proposal 结算的原子性、拒绝反馈、执行顺序与回合限额。
 *
 * 这些场景来自真实会踩的坑（交易部分成功、叙事先于裁决、限额被拆批绕过），
 * 断言的是事件 / Proposal / 状态，不涉及任何文案。
 */
import { describe, expect, it } from "vitest";
import type { AttrDef, Envelope, Proposal } from "../../shared/src/contract/types.ts";
import { createTurnBudget, DefaultArbiter } from "./arbiter.ts";
import { JsonRegistry } from "./registry.ts";
import { EventSourcedStore } from "./store.ts";

const ROOM = "room_atomic";
const PLR = "plr_me";
const SHOP = "loc_shop";

const ATTRS: AttrDef[] = [
  { key: "money", type: "number", scope: ["plr"], min: 0, max: 10_000, default: 60, visibility: "public", display: { label: "钱" } },
  { key: "stamina", type: "number", scope: ["plr"], min: 0, max: 100, default: 60, visibility: "public", display: { label: "体力" } },
];

function cause(id = "evt_turn_1", type = "turn.accepted"): Envelope {
  return { v: 1, id, roomId: ROOM, seq: 0, ts: 1000, actorId: PLR, type, payload: {} };
}

function setup(money = 2, limits?: ConstructorParameters<typeof DefaultArbiter>[0]["limits"]) {
  const store = new EventSourcedStore({ worldId: "world_test", locId: SHOP });
  const mk = (seq: number, type: string, payload: unknown): Envelope => ({
    v: 1, id: `evt_seed_${seq}`, roomId: ROOM, seq, ts: seq, actorId: "system", type, payload,
  });
  const ent = (id: string, kind: string, name: string, attrs: Record<string, number | string>) => ({
    id, kind, name, attrs, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0,
  });
  store.append(ROOM, [
    mk(1, "entity.created", { entity: ent(SHOP, "loc", "小店", {}) }),
    mk(2, "entity.created", { entity: ent(PLR, "plr", "我", { money, stamina: 60 }) }),
  ]);
  const registry = new JsonRegistry({ attrs: ATTRS, events: [], intents: [], tools: [], ops: [] });
  const arbiter = new DefaultArbiter({ store, registry, limits, now: () => 1000 });
  return { store, registry, arbiter };
}

/** 一次"买面包"：扣钱 + 建物 + 持有，三条必须同生共死 */
function purchase(price: number): Proposal[] {
  return [
    { op: "attr.delta", args: { entityId: PLR, key: "money", delta: -price, mustKeep: true }, reason: "买面包", by: "mod.trade" },
    { op: "entity.create", args: { id: "item_bread_1", kind: "item", name: "面包", canon: false, origin: "system" }, reason: "买到面包", by: "mod.trade" },
    { op: "link.create", args: { kind: "holds", from: PLR, to: "item_bread_1" }, reason: "入手", by: "mod.trade" },
  ];
}

describe("结算原子性（atomic 默认语义）", () => {
  it("余额不足：mustKeep 让扣款整条失败 → 整批不落库，钱与物品都没变", async () => {
    const { store, arbiter } = setup(2);
    const seqBefore = store.seq(ROOM);

    const r = await arbiter.apply(ROOM, purchase(6), cause());

    expect(r.ok).toBe(false);
    expect(r.mode).toBe("atomic");
    expect(r.events).toHaveLength(0);
    expect(store.seq(ROOM)).toBe(seqBefore);
    expect(store.state(ROOM).entities[PLR]?.attrs.money).toBe(2);
    expect(store.state(ROOM).entities["item_bread_1"]).toBeUndefined();
    expect(r.rejected[0]).toMatchObject({ code: "E_PRECONDITION" });
  });

  it("合法扣款 + 冲突的 entity.create：整笔交易失败，钱不变（不会只扣钱不发货）", async () => {
    const { store, arbiter } = setup(60);
    // 先占掉 item_bread_1 这个 id，制造 ID 冲突
    await arbiter.apply(
      ROOM,
      [{ op: "entity.create", args: { id: "item_bread_1", kind: "item", name: "旧面包", canon: false, origin: "system" }, by: "engine.turn" }],
      cause("evt_pre"),
    );
    const moneyBefore = store.state(ROOM).entities[PLR]?.attrs.money;

    const r = await arbiter.apply(ROOM, purchase(6), cause("evt_turn_2"));

    expect(r.ok).toBe(false);
    expect(r.events).toHaveLength(0);
    expect(r.rejected[0]?.code).toBe("E_ID_TAKEN");
    expect(store.state(ROOM).entities[PLR]?.attrs.money).toBe(moneyBefore);
  });

  it("坏条目可追溯到来源：rejected 带回原 proposal 与错误码", async () => {
    const { arbiter } = setup(60);
    const bad: Proposal = { op: "attr.delta", args: { entityId: PLR, key: "telepathy", delta: 1 }, by: "llm" };
    const r = await arbiter.apply(ROOM, [bad], cause());
    expect(r.ok).toBe(false);
    expect(r.rejected[0]?.proposal).toBe(bad);
    expect(r.rejected[0]?.code).toBe("E_ATTR_UNKNOWN");
  });

  it("partial 是显式选择：只有它才允许坏条目丢弃、余下照做", async () => {
    const { arbiter } = setup(60);
    const r = await arbiter.apply(
      ROOM,
      [{ op: "attr.delta", args: { entityId: PLR, key: "telepathy", delta: 1 }, by: "llm" }, { op: "attr.delta", args: { entityId: PLR, key: "stamina", delta: -5 }, by: "llm" }],
      cause(),
      { mode: "partial" },
    );
    expect(r.ok).toBe(true);
    expect(r.applied).toHaveLength(1);
    expect(r.rejected).toHaveLength(1);
  });
});

describe("回合限额（整回合累计，不能拆批绕过）", () => {
  it("同批两条各 20、上限 25：第二次只允许 5", async () => {
    const { store, arbiter } = setup(60);
    const before = store.state(ROOM).entities[PLR]?.attrs.stamina as number;
    const r = await arbiter.apply(
      ROOM,
      [
        { op: "attr.delta", args: { entityId: PLR, key: "stamina", delta: -20 }, by: "llm" },
        { op: "attr.delta", args: { entityId: PLR, key: "stamina", delta: -20 }, by: "llm" },
      ],
      cause(),
    );
    expect(r.ok).toBe(true);
    expect(store.state(ROOM).entities[PLR]?.attrs.stamina).toBe(before - 25);
  });

  it("同一回合拆成两次 apply 也一样受限（预算按 causedBy 累计）", async () => {
    const { store, arbiter } = setup(60);
    const before = store.state(ROOM).entities[PLR]?.attrs.stamina as number;
    const turnCause = { ...cause(), causedBy: "turn_abc" } as Envelope;
    await arbiter.apply(ROOM, [{ op: "attr.delta", args: { entityId: PLR, key: "stamina", delta: -20 }, by: "llm" }], turnCause);
    await arbiter.apply(ROOM, [{ op: "attr.delta", args: { entityId: PLR, key: "stamina", delta: -20 }, by: "llm" }], turnCause);
    expect(store.state(ROOM).entities[PLR]?.attrs.stamina).toBe(before - 25);
  });

  it("显式 turnBudget：同回合两次 apply 共享 x. 写计数，超限的第二批整批回滚", async () => {
    const { store, arbiter } = setup(2, { xWritesPerTurn: 1 });
    const budget = createTurnBudget();
    const xSet = (i: number): Proposal => ({ op: "attr.set", args: { entityId: PLR, key: `x.k${i}`, value: i }, by: "llm" });

    const first = await arbiter.apply(ROOM, [xSet(0)], cause("evt_t1"), { turnBudget: budget });
    expect(first.ok).toBe(true);
    expect(budget.xWrites).toBe(1);

    const seqBefore = store.seq(ROOM);
    const second = await arbiter.apply(ROOM, [xSet(1)], cause("evt_t1b"), { turnBudget: budget });
    expect(second.ok).toBe(false);
    expect(second.rejected[0]?.code).toBe("E_X_LIMIT");
    expect(second.events).toHaveLength(0);
    expect(store.seq(ROOM)).toBe(seqBefore);
    // 被拒的批不吃额度
    expect(budget.xWrites).toBe(1);
  });

  it("显式 turnBudget：同属性 attr.delta 跨两批累计超 maxDeltaPerTurn → 第二批被拒且整批回滚", async () => {
    const { store, arbiter } = setup(2);
    const budget = createTurnBudget();
    const spend = (): Proposal => ({ op: "attr.delta", args: { entityId: PLR, key: "stamina", delta: -20, mustKeep: true }, by: "llm" });

    const first = await arbiter.apply(ROOM, [spend()], cause("evt_t2"), { turnBudget: budget });
    expect(first.ok).toBe(true);
    const staminaAfterFirst = store.state(ROOM).entities[PLR]?.attrs.stamina as number;
    const seqBefore = store.seq(ROOM);

    const second = await arbiter.apply(ROOM, [spend()], cause("evt_t2b"), { turnBudget: budget });
    expect(second.ok).toBe(false);
    expect(second.rejected[0]?.code).toBe("E_PRECONDITION");
    expect(second.events).toHaveLength(0);
    expect(store.seq(ROOM)).toBe(seqBefore);
    expect(store.state(ROOM).entities[PLR]?.attrs.stamina).toBe(staminaAfterFirst);
  });

  it("显式预算登记到回合键：同回合未显式传预算的入口（审核处置）共享计数", async () => {
    const { store, arbiter } = setup(2, { xWritesPerTurn: 1 });
    const budget = createTurnBudget();
    const turnCause = { ...cause("evt_audit"), causedBy: "turn_shared" } as Envelope;
    await arbiter.apply(ROOM, [{ op: "attr.set", args: { entityId: PLR, key: "x.a", value: 1 }, by: "engine.turn" }], turnCause, { turnBudget: budget });

    const seqBefore = store.seq(ROOM);
    // 审核处置只拿得到 cause（causedBy=本回合），不传 turnBudget
    const punished = await arbiter.apply(ROOM, [{ op: "attr.set", args: { entityId: PLR, key: "x.b", value: 2 }, by: "engine.audit" }], turnCause);
    expect(punished.ok).toBe(false);
    expect(punished.rejected[0]?.code).toBe("E_X_LIMIT");
    expect(store.seq(ROOM)).toBe(seqBefore);
    expect(budget.xWrites).toBe(1);
  });

  it("被拒的整批不吃额度：失败后重试仍可用满 25", async () => {
    const { store, arbiter } = setup(60);
    const before = store.state(ROOM).entities[PLR]?.attrs.stamina as number;
    const turnCause = { ...cause(), causedBy: "turn_retry" } as Envelope;
    // 第一条合法 20、第二条必须失败（不存在的实体）→ atomic 整批回滚，额度也要跟着回滚
    const failed = await arbiter.apply(
      ROOM,
      [
        { op: "attr.delta", args: { entityId: PLR, key: "stamina", delta: -20 }, by: "llm" },
        { op: "attr.delta", args: { entityId: "npc_ghost", key: "stamina", delta: -1 }, by: "llm" },
      ],
      turnCause,
    );
    expect(failed.ok).toBe(false);
    const retry = await arbiter.apply(ROOM, [{ op: "attr.delta", args: { entityId: PLR, key: "stamina", delta: -25 }, by: "llm" }], turnCause);
    expect(retry.ok).toBe(true);
    expect(store.state(ROOM).entities[PLR]?.attrs.stamina).toBe(before - 25);
  });
});

describe("并发与过期状态", () => {
  it("同房间并发 apply 串行执行，两份提案都不会丢", async () => {
    const { store, arbiter } = setup(60);
    const before = store.state(ROOM).entities[PLR]?.attrs.stamina as number;
    const seqBefore = store.seq(ROOM);

    await Promise.all([
      arbiter.apply(ROOM, [{ op: "attr.delta", args: { entityId: PLR, key: "stamina", delta: -5 }, by: "a" }], { ...cause("evt_a"), causedBy: "turn_a" }),
      arbiter.apply(ROOM, [{ op: "attr.delta", args: { entityId: PLR, key: "stamina", delta: -7 }, by: "b" }], { ...cause("evt_b"), causedBy: "turn_b" }),
    ]);

    expect(store.seq(ROOM)).toBe(seqBefore + 2);
    expect(store.state(ROOM).entities[PLR]?.attrs.stamina).toBe(before - 12);
  });

  it("expectedSeq 过期 → 整批拒绝（E_SEQ_GAP），不写任何事件", async () => {
    const { store, arbiter } = setup(60);
    const stale = store.seq(ROOM);
    await arbiter.apply(ROOM, [{ op: "attr.delta", args: { entityId: PLR, key: "stamina", delta: -1 }, by: "a" }], cause("evt_first"));

    const r = await arbiter.apply(ROOM, [{ op: "attr.delta", args: { entityId: PLR, key: "stamina", delta: -1 }, by: "a" }], cause("evt_second"), { expectedSeq: stale });
    expect(r.ok).toBe(false);
    // 整批失败用 error 表达：没有"哪条 proposal 被拒"，不再伪造占位提案
    expect(r.error?.code).toBe("E_SEQ_GAP");
    expect(r.rejected).toHaveLength(0);
    expect(r.events).toHaveLength(0);
  });
});

describe("权限只看可信来源（proposal.by 不可信）", () => {
  it("LLM 伪造 by=engine.tick 也不能推进时间", async () => {
    const { arbiter } = setup(60);
    const r = await arbiter.apply(ROOM, [{ op: "time.advance", args: { ticks: 1 }, by: "engine.tick" }], cause());
    expect(r.rejected[0]?.code).toBe("E_ILLEGAL_OP");
  });
});
