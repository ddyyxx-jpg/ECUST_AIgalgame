/**
 * 结算前置条件 `ApplyOptions.expectAttrs` 的交付闭环（AGENTS.md §12.2 四问）。
 * 断言的是结果结构 / seq / 预算账本 / 落盘状态，不是文案。
 *
 * 1. 失配不消耗回合预算：显式 TurnBudget 一个计数都不动，事后的提交额度完好。
 * 2. 多条 expectAttrs 逐条校验：首个失配即整批拒绝，快照/seq/事件数零变化（无部分写入）。
 * 3. 同房间并发两次 apply 仍串行：守卫在 exclusive 链内——两条都带 expectAttrs，后一个必须按前一个提交后的快照失配。
 * 4. 真实 FileStore：写入后换新实例（重启）load/snapshot 再 apply，仍按持久化值校验。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AttrDef, Envelope, Proposal } from "../../shared/src/contract/types.ts";
import { createTurnBudget, DefaultArbiter } from "./arbiter.ts";
import { JsonRegistry } from "./registry.ts";
import { EventSourcedStore, FileStore } from "./store.ts";

const ROOM = "room_expect";
const PLR = "plr_me";
const NPC = "npc_lin";

const ATTRS: AttrDef[] = [
  { key: "stamina", type: "number", scope: ["plr", "npc"], min: 0, max: 100, default: 60, visibility: "public", display: { label: "体力" } },
  { key: "guard", type: "number", scope: ["npc"], min: 0, max: 100, default: 10, visibility: "secret", display: { label: "戒备" } },
];

function registry(): JsonRegistry {
  return new JsonRegistry({ attrs: ATTRS });
}

function cause(id = "evt_turn_1", actorId = PLR): Envelope {
  return { v: 1, id, roomId: ROOM, seq: 0, ts: 1000, actorId, type: "turn.accepted", payload: {} };
}

const delta = (entityId: string, key: string, d: number): Proposal => ({ op: "attr.delta", args: { entityId, key, delta: d }, by: "engine.turn" });
const xSet = (entityId: string, key: string, value: boolean | number | string): Proposal => ({ op: "attr.set", args: { entityId, key, value }, by: "engine.turn" });

/** 直接写事件日志造夹具（测试专用；生产代码里只有 Arbiter 能 append） */
async function seed(store: EventSourcedStore): Promise<void> {
  const mk = (seq: number, type: string, payload: unknown): Envelope => ({
    v: 1, id: `evt_seed_${seq}`, roomId: ROOM, seq, ts: seq, actorId: "system", type, payload,
  });
  const entity = (id: string, kind: string, name: string, attrs: Record<string, number | string>) => ({
    id, kind, name, attrs, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0,
  });
  await store.append(ROOM, [
    mk(1, "entity.created", { entity: entity(PLR, "plr", "我", { stamina: 60 }) }),
    mk(2, "entity.created", { entity: entity(NPC, "npc", "林月", { stamina: 90, guard: 10 }) }),
  ]);
}

interface Harness {
  store: EventSourcedStore;
  arbiter: DefaultArbiter;
}
async function setup(limits?: ConstructorParameters<typeof DefaultArbiter>[0]["limits"]): Promise<Harness> {
  const store = new EventSourcedStore();
  await seed(store);
  const arbiter = new DefaultArbiter({ store, registry: registry(), limits, now: () => 1000 });
  return { store, arbiter };
}

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "galgame-expect-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("expectAttrs · §12.2 四问闭环", () => {
  it("四问① 失配不消耗回合预算：没进 simulate，预算账本零变化且事后额度完好", async () => {
    const { store, arbiter } = await setup({ xWritesPerTurn: 1 });
    const budget = createTurnBudget();
    const seqBefore = await store.load(ROOM);
    // 两条 op 若真的进入 simulate，会分别消耗 delta 额度与 x 区写入额度
    const ops: Proposal[] = [delta(PLR, "stamina", -5), xSet(NPC, "x.flag", true)];

    const rejected = await arbiter.apply(ROOM, ops, cause("evt_budget_1"), {
      turnBudget: budget,
      expectAttrs: [{ entityId: PLR, key: "stamina", expected: 1 }],
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe("E_PRECONDITION");
    // 预算账本一个数都没动
    expect(budget.delta.size).toBe(0);
    expect(budget.xWrites).toBe(0);
    expect(budget.memSeq).toBe(0);
    expect(store.seq(ROOM)).toBe(seqBefore);

    // 同一份预算真正提交时额度完好：xWritesPerTurn=1，若上一步白吃额度这里会被 E_X_LIMIT 拒
    const committed = await arbiter.apply(ROOM, ops, cause("evt_budget_1"), { turnBudget: budget });
    expect(committed.ok).toBe(true);
    expect(committed.applied).toHaveLength(2);
    expect(budget.delta.size).toBe(1);
    expect(budget.xWrites).toBe(1);
  });

  it("四问② 多条逐条校验：首个失配即整批拒绝且无部分写入", async () => {
    const { store, arbiter } = await setup();
    const seqBefore = await store.load(ROOM);
    const eventsBefore = (await store.events(ROOM, 0)).length;
    const ops: Proposal[] = [delta(PLR, "stamina", -5), xSet(NPC, "x.flag", true)];

    const r = await arbiter.apply(ROOM, ops, cause(), {
      expectAttrs: [
        { entityId: PLR, key: "stamina", expected: 60 },   // 第 1 条：匹配
        { entityId: NPC, key: "guard", expected: 99 },     // 第 2 条：失配 → 整批拒绝
        { entityId: NPC, key: "stamina", expected: 1 },    // 第 3 条也失配，但不应被比较到
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("E_PRECONDITION");
    expect(r.error?.message).toContain(`${NPC}.guard`); // 报告的是首个失配
    expect(r.error?.message).not.toContain(`${NPC}.stamina`);
    expect(r.applied).toHaveLength(0);
    expect(r.rejected).toHaveLength(0);
    expect(r.events).toHaveLength(0);

    // 无部分写入：快照、seq、事件数全部回到 apply 前
    const state = await store.snapshot(ROOM);
    expect(state.entities[PLR]?.attrs.stamina).toBe(60);
    expect(state.entities[NPC]?.attrs.guard).toBe(10);
    expect(state.entities[NPC]?.attrs["x.flag"]).toBeUndefined();
    expect(store.seq(ROOM)).toBe(seqBefore);
    expect((await store.events(ROOM, 0)).length).toBe(eventsBefore);
  });

  it("四问③ 同房间并发两次 apply 仍串行：两条都带 expectAttrs，后一个在链内看到新值而失配", async () => {
    const { store, arbiter } = await setup();
    const seqBefore = await store.load(ROOM);
    const eventsBefore = (await store.events(ROOM, 0)).length;

    // 两条都基于"当前 stamina=60"的旧快照。A 先提交把 stamina 改成 55，
    // B 只有在 exclusive 链内、A 落库之后才读快照，才会看到 55 并失配。
    // 若 firstAttrMismatch 被挪到 exclusive 之外（两个请求都在 A 落库前校验快照），
    // B 会误判通过并写库——本用例就会红，这是"守卫在链内"的回归证据。
    const [a, b] = await Promise.all([
      arbiter.apply(ROOM, [delta(PLR, "stamina", -5)], cause("evt_concurrent_1"), {
        expectAttrs: [{ entityId: PLR, key: "stamina", expected: 60 }],
      }),
      arbiter.apply(ROOM, [delta(PLR, "stamina", -10)], cause("evt_concurrent_2"), {
        expectAttrs: [{ entityId: PLR, key: "stamina", expected: 60 }],
      }),
    ]);

    expect(a.ok).toBe(true); // 链内第一个：快照仍是 60
    expect(a.seq).toBe(seqBefore + 1);
    expect(b.ok).toBe(false); // 链内第二个：看到 A 提交后的 55 → 整批拒绝
    expect(b.error?.code).toBe("E_PRECONDITION");
    expect(b.applied).toHaveLength(0);
    expect(b.rejected).toHaveLength(0);
    expect(b.events).toHaveLength(0);
    expect(store.seq(ROOM)).toBe(seqBefore + 1); // 只有 A 落库，seq 只 +1
    expect((await store.events(ROOM, 0)).length).toBe(eventsBefore + 1);
    expect((await store.snapshot(ROOM)).entities[PLR]?.attrs.stamina).toBe(55); // B 的 -10 未生效
  });

  it("四问④ 真实 FileStore：重启后 load/snapshot 再 apply，expectAttrs 仍按持久化值校验", async () => {
    const dir = await tempDir();
    const store1 = new FileStore(dir);
    await seed(store1); // 落盘 seq 1~2
    const arbiter1 = new DefaultArbiter({ store: store1, registry: registry(), now: () => 1000 });

    const write = await arbiter1.apply(ROOM, [delta(PLR, "stamina", -5)], cause("evt_before_restart"));
    expect(write.ok).toBe(true);
    expect(write.seq).toBe(3);
    await store1.flush(ROOM);

    // 重启：新实例内存为空，seq 必须从 .jsonl 载入才可信
    const store2 = new FileStore(dir);
    expect(store2.seq(ROOM)).toBe(0);
    expect(await store2.load(ROOM)).toBe(3);
    const snap = await store2.snapshot(ROOM);
    expect(snap.entities[PLR]?.attrs.stamina).toBe(55);

    const arbiter2 = new DefaultArbiter({ store: store2, registry: registry(), now: () => 1000 });
    // 过期期望（重启前记下的旧值）→ 拒绝且不落库
    const stale = await arbiter2.apply(ROOM, [delta(PLR, "stamina", -1)], cause("evt_after_restart_1"), {
      expectAttrs: [{ entityId: PLR, key: "stamina", expected: 60 }],
    });
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe("E_PRECONDITION");
    expect(store2.seq(ROOM)).toBe(3);

    // 与持久化快照一致的期望 → 放行并真实落盘
    const fresh = await arbiter2.apply(ROOM, [delta(PLR, "stamina", -1)], cause("evt_after_restart_2"), {
      expectAttrs: [{ entityId: PLR, key: "stamina", expected: 55 }],
    });
    expect(fresh.ok).toBe(true);
    expect(fresh.seq).toBe(4);

    // 再重启一次：新写入也在盘上，快照值可继续被校验
    const restored = new FileStore(dir);
    expect(await restored.load(ROOM)).toBe(4);
    expect((await restored.snapshot(ROOM)).entities[PLR]?.attrs.stamina).toBe(54);
  });
});
