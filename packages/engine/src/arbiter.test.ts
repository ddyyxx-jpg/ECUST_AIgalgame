/**
 * Arbiter 的行为契约（不是实现）。断言的是 Proposal/事件结构，不是文案。
 * 每个 it 对应 02 §4 的一条校验规则或一个真实会踩的坑。
 */
import { describe, expect, it } from "vitest";
import type { AttrDef, Envelope, Proposal } from "../../shared/src/contract/types.ts";
import { createTurnBudget, DefaultArbiter } from "./arbiter.ts";
import { JsonRegistry } from "./registry.ts";
import { EventSourcedStore } from "./store.ts";

const ROOM = "room_test";
const PLR = "plr_me";
const NPC = "npc_lin";
const GATE = "loc_campus_gate";
const LIB = "loc_library";

const ATTRS: AttrDef[] = [
  { key: "stamina", type: "number", scope: ["plr", "npc"], min: 0, max: 100, default: 60, visibility: "public", display: { label: "体力" } },
  { key: "guard", type: "number", scope: ["npc"], min: 0, max: 100, default: 10, visibility: "secret", display: { label: "戒备" } },
  { key: "mood", type: "string", scope: ["npc"], default: "calm", visibility: "self", display: { label: "心情" } },
];

function cause(id = "evt_turn_1", actorId = PLR): Envelope {
  return { v: 1, id, roomId: ROOM, seq: 0, ts: 1000, actorId, type: "turn.accepted", payload: {} };
}

function ts(n: number): number {
  return n;
}

/** 直接写事件日志造夹具（测试专用；生产代码里只有 Arbiter 能 append） */
function seed(store: EventSourcedStore): void {
  const mk = (seq: number, type: string, payload: unknown): Envelope => ({
    v: 1,
    id: `evt_seed_${seq}`,
    roomId: ROOM,
    seq,
    ts: ts(seq),
    actorId: "system",
    type,
    payload,
  });
  const entity = (id: string, kind: string, name: string, attrs: Record<string, number | string>, canon: boolean) => ({
    id,
    kind,
    name,
    attrs,
    tags: [],
    origin: "seed",
    canon,
    status: "active",
    createdAt: 0,
    updatedAt: 0,
  });
  store.append(ROOM, [
    mk(1, "entity.created", { entity: entity(GATE, "loc", "校门", {}, true) }),
    mk(2, "entity.created", { entity: entity(LIB, "loc", "图书馆", {}, true) }),
    mk(3, "entity.created", { entity: entity(PLR, "plr", "我", { stamina: 60 }, true) }),
    mk(4, "entity.created", { entity: entity(NPC, "npc", "林月", { stamina: 90, guard: 10, mood: "calm" }, true) }),
    mk(5, "link.created", { link: { id: "link_located_in_loc_campus_gate__loc_library", kind: "located_in", from: GATE, to: LIB, createdAt: 0 } }),
    mk(6, "link.created", { link: { id: `link_located_in_${PLR}__${GATE}`, kind: "located_in", from: PLR, to: GATE, createdAt: 0 } }),
  ]);
}

interface Harness {
  store: EventSourcedStore;
  arbiter: DefaultArbiter;
}
function setup(limits?: ConstructorParameters<typeof DefaultArbiter>[0]["limits"]): Harness {
  const store = new EventSourcedStore();
  seed(store);
  const arbiter = new DefaultArbiter({ store, registry: new JsonRegistry({ attrs: ATTRS }), limits, now: () => 1000 });
  return { store, arbiter };
}

const delta = (entityId: string, key: string, d: number): Proposal => ({ op: "attr.delta", args: { entityId, key, delta: d }, by: "engine.turn" });

describe("Arbiter · attr", () => {
  it("clamp 到 [min,max] 且事件标 clamped:true（超界不报错）", async () => {
    const { store, arbiter } = setup();
    const r = await arbiter.apply(ROOM, [delta(PLR, "stamina", 80)], cause());
    expect(r.ok).toBe(true);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?.type).toBe("attr.changed");
    expect(r.events[0]?.payload).toMatchObject({ entityId: PLR, key: "stamina", from: 60, to: 85, clamped: true });
    expect(store.state(ROOM).entities[PLR]?.attrs.stamina).toBe(85);
  });

  it("未注册属性被拒（I2：不许出现代码里没有的名字）", async () => {
    const { arbiter } = setup();
    const r = await arbiter.apply(ROOM, [delta(PLR, "mana", 5)], cause(), { mode: "partial" });
    expect(r.ok).toBe(true);
    expect(r.applied).toHaveLength(0);
    expect(r.rejected[0]).toMatchObject({ code: "E_ATTR_UNKNOWN" });
  });

  it("x. 区属性无需注册，但每回合最多 8 条（整回合累计）", async () => {
    const { arbiter } = setup();
    const ops: Proposal[] = Array.from({ length: 9 }, (_, i) => ({
      op: "attr.set",
      args: { entityId: NPC, key: `x.k${i}`, value: i },
      by: "engine.turn",
    }));
    const r = await arbiter.apply(ROOM, ops, cause(), { mode: "partial" });
    expect(r.applied).toHaveLength(8);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]?.code).toBe("E_X_LIMIT");
  });
});

describe("Arbiter · canon 锁", () => {
  it("canon 实体的身份只读，但数值可以随玩法变化", async () => {
    const { arbiter } = setup();
    const upd = await arbiter.apply(ROOM, [{ op: "entity.update", args: { entityId: NPC, name: "林月月" }, by: "mod.x" }], cause(), { mode: "partial" });
    expect(upd.ok).toBe(true);
    expect(upd.rejected[0]?.code).toBe("E_CANON_LOCKED");
    const d = await arbiter.apply(ROOM, [delta(NPC, "stamina", -10)], cause());
    expect(d.events).toHaveLength(1);
    expect(d.rejected).toHaveLength(0);
  });
});

describe("Arbiter · entity", () => {
  it("id 必须以 <kind>_ 开头、不可复用、受配额限制", async () => {
    const h = setup({ npc: 1 });
    const bad = await h.arbiter.apply(ROOM, [{ op: "entity.create", args: { id: "npcx_1", kind: "npc", name: "路人" }, by: "engine.turn" }], cause());
    expect(bad.rejected[0]?.code).toBe("E_SCHEMA_INVALID");
    const dup = await h.arbiter.apply(ROOM, [{ op: "entity.create", args: { id: NPC, kind: "npc", name: "影子" }, by: "engine.turn" }], cause());
    expect(dup.rejected[0]?.code).toBe("E_ID_TAKEN");
    const quota = await h.arbiter.apply(ROOM, [{ op: "entity.create", args: { id: "npc_2", kind: "npc", name: "转校生" }, by: "engine.turn" }], cause());
    expect(quota.rejected[0]?.code).toBe("E_QUOTA_EXCEEDED");
    const ok = await h.arbiter.apply(ROOM, [{ op: "entity.create", args: { id: "item_note", kind: "item", name: "纸条", attrs: { "x.ink": "blue" } }, by: "engine.turn" }], cause());
    expect(ok.events[0]?.type).toBe("entity.created");
  });

  it("tombstone 前要检查引用完整性（仍在 plot 里的演员不能删）", async () => {
    const { arbiter } = setup();
    const created = await arbiter.apply(ROOM, [{ op: "entity.create", args: { id: "npc_zhou", kind: "npc", name: "周野" }, by: "engine.turn" }], cause());
    expect(created.events[0]?.type).toBe("entity.created");
    const plot = await arbiter.apply(ROOM, [{ op: "plot.upsert", args: { goal: "让周野替我背锅", actors: [PLR, "npc_zhou"] }, by: "npc.plot" }], cause());
    expect(plot.events[0]?.type).toBe("plot.upserted");
    const t = await arbiter.apply(
      ROOM,
      [
        { op: "entity.tombstone", args: { entityId: "npc_zhou" } },
        { op: "entity.tombstone", args: { entityId: "item_gone" } },
      ],
      cause(),
    );
    expect(t.rejected.map((x) => x.code)).toEqual(["E_REF_IN_USE", "E_ENTITY_MISSING"]);
  });
});

describe("Arbiter · 关系与移动", () => {
  it("present 边只能由引擎重建；重复建边不重复落库", async () => {
    const { arbiter } = setup();
    const r = await arbiter.apply(
      ROOM,
      [
        { op: "link.create", args: { kind: "present", from: PLR, to: NPC } },
        { op: "link.create", args: { kind: "knows", from: PLR, to: NPC, weight: 30 } },
        { op: "link.create", args: { kind: "knows", from: PLR, to: NPC, weight: 30 } },
      ],
      cause(),
      { mode: "partial" },
    );
    expect(r.applied).toHaveLength(1);
    expect(r.rejected.map((x) => x.code)).toEqual(["E_ILLEGAL_OP", "E_IDEMPOTENT"]);
  });

  it("move.to 走 located_in 邻接校验", async () => {
    const { store, arbiter } = setup();
    const ok = await arbiter.apply(ROOM, [{ op: "move.to", args: { actorId: PLR, locId: LIB } }], cause());
    expect(ok.events[0]?.type).toBe("actor.moved");
    expect(store.state(ROOM).room.scene.locId).toBe(LIB);
    expect(store.state(ROOM).room.scene.presentIds).toContain(PLR);
    const bad = await arbiter.apply(ROOM, [{ op: "move.to", args: { actorId: PLR, locId: "loc_dorm" } }], cause());
    expect(bad.rejected[0]?.code).toBe("E_SCENE_NOT_FOUND");
  });
});

describe("Arbiter · 时钟与记忆", () => {
  it("time.advance 只认引擎/tick；跨 phase 会进一天", async () => {
    const { arbiter } = setup();
    // 权限按信封来源判定：proposal.by 只是自我声明，LLM 可以伪造，不能作数
    const denied = await arbiter.apply(ROOM, [{ op: "time.advance", args: { ticks: 1 }, by: "engine.tick" }], cause());
    expect(denied.rejected[0]?.code).toBe("E_ILLEGAL_OP");
    const r = await arbiter.apply(ROOM, [{ op: "time.advance", args: { phase: "night" } }], cause("evt_tick_1", "system"));
    expect(r.rejected[0]?.code).toBe("E_ILLEGAL_OP");
    const tick = { ...cause("evt_tick_2", "system"), type: "tick.night" as const };
    const ok = await arbiter.apply(ROOM, [{ op: "time.advance", args: { phase: "night" } }], tick);
    expect(ok.events[0]?.payload).toMatchObject({ clock: { day: 1, phase: "night", tick: 0 } });
  });

  it("ticks 与 zod 对齐：只接受 1..8，0 与 9 都拒绝", async () => {
    const { arbiter } = setup();
    const tick = (id: string) => ({ ...cause(id, "system"), type: "tick.night" as const });
    const zero = await arbiter.apply(ROOM, [{ op: "time.advance", args: { ticks: 0 } }], tick("evt_tick_t0"));
    expect(zero.rejected[0]?.code).toBe("E_SCHEMA_INVALID");
    const nine = await arbiter.apply(ROOM, [{ op: "time.advance", args: { ticks: 9 } }], tick("evt_tick_t9"));
    expect(nine.rejected[0]?.code).toBe("E_SCHEMA_INVALID");
    const eight = await arbiter.apply(ROOM, [{ op: "time.advance", args: { ticks: 8 } }], tick("evt_tick_t8"));
    expect(eight.ok).toBe(true);
    expect(eight.events[0]?.payload).toMatchObject({ clock: { tick: 8 } });
    // 「跳到指定 phase」内部用 0，不受影响
    const phase = await arbiter.apply(ROOM, [{ op: "time.advance", args: { phase: "noon" } }], tick("evt_tick_tp"));
    expect(phase.ok).toBe(true);
  });

  it("memory.write 只能写自己的记忆；导演代写按信封来源判定", async () => {
    const { arbiter } = setup();
    const own = await arbiter.apply(ROOM, [{ op: "memory.write", args: { ownerId: NPC, content: "他好像知道我昨晚在图书馆" }, by: "npc.director" }], cause());
    expect(own.rejected[0]?.code).toBe("E_FORBIDDEN");
    const director = { ...cause("evt_dlg_1", "system"), type: "dialogue.step" as const };
    const proxy = await arbiter.apply(ROOM, [{ op: "memory.write", args: { ownerId: NPC, content: "他好像知道我昨晚在图书馆", tags: ["密谋"] } }], director);
    expect(proxy.events[0]?.type).toBe("memory.written");
  });
});

describe("Arbiter · 原子性与幂等", () => {
  it("partial 模式（显式选择）：坏条目丢弃、好条目落库", async () => {
    const { arbiter } = setup();
    const r = await arbiter.apply(ROOM, [delta(PLR, "mana", 1), delta(PLR, "stamina", -5)], cause(), { mode: "partial" });
    expect(r.ok).toBe(true);
    expect(r.applied).toHaveLength(1);
    expect(r.rejected).toHaveLength(1);
    expect(r.seq).toBe(7);
  });

  it("未知 op 是调用方版本不一致 → 整批回滚，seq 不变", async () => {
    const { store, arbiter } = setup();
    const before = store.seq(ROOM);
    const r = await arbiter.apply(ROOM, [delta(PLR, "stamina", 5), { op: "attr.multiply" as never, args: {} }], cause());
    expect(r.ok).toBe(false);
    expect(r.events).toHaveLength(0);
    expect(r.applied).toHaveLength(0);
    expect(store.seq(ROOM)).toBe(before);
  });

  it("dryRun 校验但不落库", async () => {
    const { store, arbiter } = setup();
    const before = store.seq(ROOM);
    const r = await arbiter.dryRun(ROOM, [delta(PLR, "stamina", 5)]);
    expect(r.ok).toBe(true);
    expect(store.seq(ROOM)).toBe(before);
  });

  it("dryRun 用独立预算：不消耗正式回合预算，也不受已用额度影响", async () => {
    const { arbiter } = setup({ xWritesPerTurn: 1 });
    const budget = createTurnBudget();
    const xSet = (i: number): Proposal => ({ op: "attr.set", args: { entityId: NPC, key: `x.k${i}`, value: i }, by: "engine.turn" });

    const first = await arbiter.apply(ROOM, [xSet(0)], cause(), { turnBudget: budget });
    expect(first.ok).toBe(true);
    expect(budget.xWrites).toBe(1);

    // 正式预算已用满，但预览走独立预算，能过；且不消耗正式预算
    const preview = await arbiter.dryRun(ROOM, [xSet(1)]);
    expect(preview.ok).toBe(true);
    expect(budget.xWrites).toBe(1);

    const blocked = await arbiter.apply(ROOM, [xSet(1)], cause("evt_turn_2"), { turnBudget: budget });
    expect(blocked.ok).toBe(false);
    expect(blocked.rejected[0]?.code).toBe("E_X_LIMIT");
  });
});

describe("Arbiter · 结算前置条件 expectAttrs", () => {
  it("期望值匹配时照常提交，seq 前进", async () => {
    const { store, arbiter } = setup();
    const before = store.seq(ROOM);
    const r = await arbiter.apply(
      ROOM,
      [delta(PLR, "stamina", -5)],
      cause(),
      { expectAttrs: [{ entityId: PLR, key: "stamina", expected: 60 }] },
    );
    expect(r.ok).toBe(true);
    expect(r.events).toHaveLength(1);
    expect(store.seq(ROOM)).toBe(before + 1);
  });

  it("期望值失配时整批拒绝：不落库、不耗 seq、不产事件", async () => {
    const { store, arbiter } = setup();
    const before = store.seq(ROOM);
    const eventsBefore = await store.events(ROOM, 0);
    const r = await arbiter.apply(
      ROOM,
      [delta(PLR, "stamina", -5)],
      cause(),
      { expectAttrs: [{ entityId: PLR, key: "stamina", expected: 99 }] },
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("E_PRECONDITION");
    expect(r.error?.message).toContain(`${PLR}.stamina`);
    expect(r.events).toHaveLength(0);
    expect(r.applied).toHaveLength(0);
    expect(store.seq(ROOM)).toBe(before);
    expect(await store.events(ROOM, 0)).toHaveLength(eventsBefore.length);
  });

  it("expected:null 在属性缺失时通过、在属性存在时拒绝", async () => {
    const { arbiter } = setup();
    const pass = await arbiter.apply(
      ROOM,
      [delta(PLR, "stamina", -5)],
      cause(),
      { expectAttrs: [{ entityId: NPC, key: "x.notset", expected: null }] },
    );
    expect(pass.ok).toBe(true);
    const fail = await arbiter.apply(
      ROOM,
      [delta(PLR, "stamina", -5)],
      cause(),
      { expectAttrs: [{ entityId: NPC, key: "stamina", expected: null }] },
    );
    expect(fail.ok).toBe(false);
    expect(fail.error?.code).toBe("E_PRECONDITION");
  });

  it("expectedSeq 与 expectAttrs 同时给且 seq 过期 → 仍是 E_SEQ_GAP", async () => {
    const { arbiter } = setup();
    const r = await arbiter.apply(
      ROOM,
      [delta(PLR, "stamina", -5)],
      cause(),
      {
        expectedSeq: 999,
        expectAttrs: [{ entityId: PLR, key: "stamina", expected: 99 }],
      },
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("E_SEQ_GAP");
  });
});
