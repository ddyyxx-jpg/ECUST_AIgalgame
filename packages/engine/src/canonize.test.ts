/**
 * 世界层永久记忆（P3）：八道闸门的可验证行为。
 * 断言"写没写进世界层 / 被哪道闸门拦下"，不断言文案。
 */
import { describe, expect, it, vi } from "vitest";
import type { Envelope, Entity, MemoryRecord, RoomId } from "../../shared/src/index.ts";
import { DefaultArbiter } from "./arbiter.ts";
import { EventSourcedStore } from "./store.ts";
import { emptyRegistry } from "./registry.ts";
import { EventSourcedMemory, worldRoomId } from "./memory.ts";
import { CanonizeJob, type CanonizeJudge } from "./canonize.ts";

import { contentHashOf } from "./memory.gate.ts";

const ROOM = "room_c";
const WORLD = "w1";
const WORLD_ROOM = worldRoomId(WORLD);
const A = "npc_lin";
const B = "npc_ma";
const PLR = "plr_self";
const GATE = "loc_gate";

function entity(id: string, kind: string, name: string): Entity {
  return { id, kind: kind as Entity["kind"], name, attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 };
}

function env(seq: number, type: string, payload: unknown, roomId: RoomId = ROOM): Envelope {
  return { v: 1, id: `evt_${roomId}_${seq}`, roomId, seq, ts: 1000 + seq, actorId: "system", type, payload };
}

function memPayload(id: string, ownerId: string, content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { memoryId: id, ownerId, content, tags: ["校园"], salience: 4, about: [PLR], visibility: "public", tier: "long", turn: 1, at: 1, userId: "u_a", ...extra };
}

interface Fixture {
  store: EventSourcedStore;
  memory: EventSourcedMemory;
  arbiter: DefaultArbiter;
  bump: Array<{ worldId: string; version: number }>;
}

async function fixture(opts: { records: MemoryRecord[]; judge?: CanonizeJudge; enabled?: boolean; dailyCap?: number }): Promise<Fixture> {
  const store = new EventSourcedStore({ worldId: WORLD, locId: GATE });
  store.append(ROOM, [
    env(1, "entity.created", { entity: entity(GATE, "loc", "校门") }),
    env(2, "entity.created", { entity: entity(A, "npc", "林月") }),
    env(3, "entity.created", { entity: entity(B, "npc", "马骁") }),
    env(4, "entity.created", { entity: entity(PLR, "plr", "我") }),
    env(5, "scene.changed", { locId: GATE, presentIds: [PLR, A, B] }),
  ]);
  const memory = new EventSourcedMemory();
  const arbiter = new DefaultArbiter({ store, registry: emptyRegistry(), memories: memory });
  // 把记忆直接投影进内存索引（等价于它们由 memory.written 事件重放得到）
  for (const r of opts.records) {
    memory.ingest({
      ...env(100 + opts.records.indexOf(r), "memory.written", {
        ...memPayload(r.id, r.ownerId, r.content),
        contentHash: contentHashOf(r.content),
        tags: r.tags,
        about: r.about,
        ...(r.aboutUserIds ? { aboutUserIds: r.aboutUserIds } : {}),
      }),
    });
  }
  const bump: Array<{ worldId: string; version: number }> = [];
  const judge: CanonizeJudge = opts.judge ?? { review: async () => ({ allow: true }) };
  const job = new CanonizeJob({
    store,
    arbiter,
    worldRoom: WORLD_ROOM,
    worldId: WORLD,
    memory,
    judge,
    limits: { enabled: opts.enabled ?? true, dailyCap: opts.dailyCap ?? 200, minWitness: 2, perSourceCap: 2 },
    onVersionBump: async (worldId, version) => {
      bump.push({ worldId, version });
    },
  });
  void job;
  return { store, memory, arbiter, bump };
}

function record(id: string, ownerId: string, content: string): MemoryRecord {
  return { id, roomId: ROOM, ownerId, content, tags: ["校园"], salience: 4, about: [PLR], visibility: "public", tier: "long", turn: 1, createdAt: 1 };
}

/** 需要 plot 时从事件投影出活跃剧情（禁语闸门的数据来源） */
function withPlot(store: EventSourcedStore): void {
  const seq = store.seq(ROOM) + 1;
  store.append(ROOM, [
    env(seq, "plot.upserted", { plot: { id: "plot_key", goal: "把钥匙藏起来", actors: [A, B], status: "active", createdDay: 1, forbidReveal: "钥匙在花坛" } }),
  ]);
}

async function job(f: Fixture, judge: CanonizeJudge = { review: async () => ({ allow: true }) }, enabled = true, dailyCap = 200, judgeFailureLimit = 3) {
  return new CanonizeJob({
    store: f.store,
    arbiter: f.arbiter,
    worldRoom: WORLD_ROOM,
    worldId: WORLD,
    memory: f.memory,
    judge,
    limits: { enabled, dailyCap, minWitness: 2, perSourceCap: 2, judgeFailureLimit },
    onVersionBump: async (worldId, version) => {
      f.bump.push({ worldId, version });
    },
  });
}

describe("canonize 八道闸门（P3）", () => {
  it("两位 NPC 都记住的公共的事 → 写进世界层（ownerId=mem_world，tier=permanent）", async () => {
    const f = await fixture({ records: [record("mem_a", A, "校门口那棵老梧桐树被台风刮倒了"), record("mem_b", B, "校门口那棵老梧桐树被台风刮倒了")] });
    const report = await (await job(f)).retireRoom(ROOM);
    expect(report.written).toHaveLength(1);
    expect(report.writtenToday).toBe(1);
    const events = await f.store.events(WORLD_ROOM, 0);
    const written = events.filter((e) => e.type === "memory.written");
    expect(written).toHaveLength(1);
    const payload = written[0]!.payload as { ownerId: string; tier: string; visibility: string; contentHash?: string };
    expect(payload.ownerId).toBe("mem_world");
    expect(payload.tier).toBe("permanent");
    expect(payload.visibility).toBe("public");
    expect(payload.contentHash).toBeTruthy();
    expect(f.bump).toEqual([{ worldId: WORLD, version: 1 }]);
  });

  it("只有一个人记住 → 公共性不足，不写", async () => {
    const f = await fixture({ records: [record("mem_a", A, "我看见林月在图书馆哭")] });
    const report = await (await job(f)).retireRoom(ROOM);
    expect(report.written).toHaveLength(0);
    expect(report.skipped.some((s) => s.reason === "not_public_enough")).toBe(true);
  });

  it("隐私扫描：命中活跃剧情的禁语 → 拦下（不泄露密谋）", async () => {
    const f = await fixture({ records: [record("mem_a", A, "钥匙在花坛下面"), record("mem_b", B, "钥匙在花坛下面")] });
    withPlot(f.store);
    const report = await (await job(f)).retireRoom(ROOM);
    expect(report.written).toHaveLength(0);
    expect(report.skipped.some((s) => s.reason.startsWith("privacy:plot"))).toBe(true);
  });

  it("独立审核拒绝 → 丢弃；审核器抛错 → judge_unavailable（fail-closed）", async () => {
    const records = [record("mem_a", A, "食堂新开了一家面馆"), record("mem_b", B, "食堂新开了一家面馆")];
    const deny = await fixture({ records });
    const r1 = await (await job(deny, { review: async () => ({ allow: false, reason: "太具体" }) })).retireRoom(ROOM);
    expect(r1.written).toHaveLength(0);
    expect(r1.skipped.some((s) => s.reason.startsWith("judge:"))).toBe(true);

    const boom = await fixture({ records });
    const r2 = await (await job(boom, { review: async () => { throw new Error("timeout"); } })).retireRoom(ROOM);
    expect(r2.written).toHaveLength(0);
    expect(r2.skipped.some((s) => s.reason === "judge_unavailable")).toBe(true);
  });

  it("幂等：同一件事第二次发布直接跳过（世界层唯一）", async () => {
    const records = [record("mem_a", A, "校门口那棵老梧桐树被台风刮倒了"), record("mem_b", B, "校门口那棵老梧桐树被台风刮倒了")];
    const f = await fixture({ records });
    const j = await job(f);
    const first = await j.retireRoom(ROOM);
    // 先锁"第一次确实写进去了"：只断言第二次被挡，等于没验证幂等键是否在第一次就生效
    expect(first.written).toHaveLength(1);
    const second = await j.retireRoom(ROOM);
    expect(second.written).toHaveLength(0);
    expect(second.skipped.some((s) => s.reason === "duplicate")).toBe(true);
  });

  it("体量闸门：每日上限 0 时一条都不写；disabled 时整体关闭", async () => {
    const records = [record("mem_a", A, "食堂新开了一家面馆"), record("mem_b", B, "食堂新开了一家面馆")];
    const capped = await fixture({ records });
    const r1 = await (await job(capped, { review: async () => ({ allow: true }) }, true, 0)).retireRoom(ROOM);
    expect(r1.written).toHaveLength(0);
    expect(r1.skipped.some((s) => s.reason === "daily_cap")).toBe(true);

    const off = await fixture({ records });
    const r2 = await (await job(off, { review: async () => ({ allow: true }) }, false)).retireRoom(ROOM);
    expect(r2.written).toHaveLength(0);
    expect(r2.skipped[0]?.reason).toBe("disabled");
  });

  it("撤回：tombstone 立即生效，世界层版本 +1，召回里消失", async () => {
    const records = [record("mem_a", A, "校门口那棵老梧桐树被台风刮倒了"), record("mem_b", B, "校门口那棵老梧桐树被台风刮倒了")];
    const f = await fixture({ records });
    const j = await job(f);
    const report = await j.retireRoom(ROOM);
    const memoryId = report.written[0]!;
    // 撤回之前必须真的能召回：否则这条断言是空过（审阅 P0-5）
    const before = await f.memory.recall({ roomId: WORLD_ROOM, ownerId: "mem_world", scope: "world", tiers: ["permanent"], budgetTokens: 500, nowTurn: 5 });
    expect(before.map((h) => h.record.id)).toContain(memoryId);
    expect(await j.tombstone(memoryId, "记错了")).toBe(true);
    expect(f.bump.at(-1)).toEqual({ worldId: WORLD, version: 2 });
    const hits = await f.memory.recall({ roomId: WORLD_ROOM, ownerId: "mem_world", scope: "world", tiers: ["permanent"], budgetTokens: 500, nowTurn: 5 });
    expect(hits.map((h) => h.record.id)).not.toContain(memoryId);
    expect(hits.every((h) => h.record.status !== "tombstoned")).toBe(true);
  });


  it("印象：发布成功后给 aboutUserIds 里每个玩家入队一条 notice（只一次）", async () => {
    const records = [
      { ...record("mem_i1", A, "林月在图书馆帮学弟找回了丢失的校园卡"), aboutUserIds: ["user_alpha"] },
      { ...record("mem_i2", B, "林月在图书馆帮学弟找回了丢失的校园卡"), aboutUserIds: ["user_alpha"] },
    ];
    const f = await fixture({ records });
    const notices: Array<{ userId: string; memoryId: string }> = [];
    const j = new CanonizeJob({
      store: f.store,
      arbiter: f.arbiter,
      worldRoom: WORLD_ROOM,
      worldId: WORLD,
      memory: f.memory,
      judge: { review: async () => ({ allow: true }) },
      onImpression: async (n) => {
        notices.push({ userId: n.userId, memoryId: n.memoryId });
      },
    });
    await j.retireRoom(ROOM);
    expect(notices.length).toBeGreaterThanOrEqual(1);
    expect(notices[0]?.userId).toBe("user_alpha");
    expect(await j.tombstone(notices[0]!.memoryId, "撤销")).toBe(true);
  });

  it("协作式中止：调用前已 abort → 不写任何候选、报告 aborted、不抛错", async () => {
    const f = await fixture({
      records: [record("mem_a", A, "食堂新开了一家面馆"), record("mem_b", B, "食堂新开了一家面馆")],
    });
    const controller = new AbortController();
    controller.abort();
    const review = vi.fn(async () => ({ allow: true }));
    const report = await (await job(f, { review })).retireRoom(ROOM, { signal: controller.signal });
    expect(report.aborted).toBe(true);
    expect(report.written).toHaveLength(0);
    expect(review).not.toHaveBeenCalled(); // 中止时不发起付费 judge
    expect((await f.store.events(WORLD_ROOM, 0)).filter((e) => e.type === "memory.written")).toHaveLength(0);
  });

  it("协作式中止：judge 内 abort → 保留已落库批次、不再写新批次（不回滚）", async () => {
    const lost = "食堂门口贴了一张失物招领";
    const bench = "操场旁边多了一排水龙头";
    const f = await fixture({
      records: [
        record("mem_l1", A, lost), record("mem_l2", B, lost),
        record("mem_b1", A, bench), record("mem_b2", B, bench),
      ],
    });
    const controller = new AbortController();
    let reviews = 0;
    const judge: CanonizeJudge = {
      review: async () => {
        reviews += 1;
        if (reviews === 2) controller.abort(); // 第一条已落库，第二条 judge 时中止
        return { allow: true };
      },
    };
    const report = await (await job(f, judge)).retireRoom(ROOM, { signal: controller.signal });
    expect(report.aborted).toBe(true);
    expect(report.written).toHaveLength(1);
    // 中止报告必须与写入一致：候选数 > 0，"0 候选 + 已写 1 条"会被读成数据错乱
    expect(report.candidates).toBe(2);
    const written = (await f.store.events(WORLD_ROOM, 0)).filter((e) => e.type === "memory.written");
    expect(written).toHaveLength(1);
    expect((written[0]!.payload as { content: string }).content).toBe(lost);
  });

  it("P2-2：load 与 apply 之间世界房被新世代推进 seq（signal 已 abort）→ 整批 E_SEQ_GAP 拒绝，不交错写入", async () => {
    const f = await fixture({
      records: [record("mem_a", A, "食堂新开了一家面馆"), record("mem_b", B, "食堂新开了一家面馆")],
    });
    await f.store.load(WORLD_ROOM);
    const seqBefore = f.store.seq(WORLD_ROOM);
    const controller = new AbortController();
    const realApply = f.arbiter.apply.bind(f.arbiter);
    let injected = false;
    // 在真实 apply 入口注入：旧任务体已通过最后的 signal 检查（已到落库边界），
    // 此时新世代抢先写一条推进世界房 seq，并 abort 旧 signal —— 模拟 stall 接管后的僵尸体。
    vi.spyOn(f.arbiter, "apply").mockImplementation(async (roomId, ops, cause, opts) => {
      if (roomId === WORLD_ROOM && !injected) {
        injected = true;
        const next = f.store.seq(WORLD_ROOM) + 1;
        f.store.append(WORLD_ROOM, [env(next, "time.advanced", { day: 1, tick: 9 }, WORLD_ROOM)]);
        controller.abort();
      }
      return realApply(roomId, ops, cause, opts);
    });
    const report = await (await job(f)).retireRoom(ROOM, { signal: controller.signal });
    expect(injected).toBe(true);
    // basedOnSeq 是运行开始时记下的旧值，apply 看到的世界 seq 已变 → E_SEQ_GAP；
    // 僵尸 signal.aborted 阻止有界重试，错误记入 errors 而非静默 skip。
    expect(report.errors).toContain("E_SEQ_GAP");
    expect(report.written).toHaveLength(0);
    // 世界房里只有新世代那条，没有旧任务体的 memory.written。
    const written = (await f.store.events(WORLD_ROOM, 0)).filter((e) => e.type === "memory.written");
    expect(written).toHaveLength(0);
    expect(f.store.seq(WORLD_ROOM)).toBe(seqBefore + 1);
  });

  it("P2-2：僵尸任务体在新世代写入后仍尝试 apply → 不重试，写入不与新世代交错", async () => {
    const f = await fixture({
      records: [record("mem_a", A, "图书馆新增了自助借书机"), record("mem_b", B, "图书馆新增了自助借书机")],
    });
    await f.store.load(WORLD_ROOM);
    const seqBefore = f.store.seq(WORLD_ROOM);
    const controller = new AbortController();
    const realApply = f.arbiter.apply.bind(f.arbiter);
    let applyCalls = 0;
    vi.spyOn(f.arbiter, "apply").mockImplementation(async (roomId, ops, cause, opts) => {
      applyCalls += 1;
      if (roomId === WORLD_ROOM) {
        // 新世代持续写入推进 seq，旧 signal 保持 abort；必须走真实 DefaultArbiter.apply
        const next = f.store.seq(WORLD_ROOM) + 1;
        f.store.append(WORLD_ROOM, [env(next, "time.advanced", { day: 1, tick: 9 + applyCalls }, WORLD_ROOM)]);
        controller.abort();
      }
      return realApply(roomId, ops, cause, opts);
    });
    const report = await (await job(f)).retireRoom(ROOM, { signal: controller.signal });
    // 僵尸 signal 已 abort：applyWithSeqRetry 直接放弃，不再 load 新 seq 重试 → 真实 apply 只调用 1 次
    expect(applyCalls).toBe(1);
    expect(report.errors).toContain("E_SEQ_GAP");
    expect(report.written).toHaveLength(0);
    const written = (await f.store.events(WORLD_ROOM, 0)).filter((e) => e.type === "memory.written");
    expect(written).toHaveLength(0);
    expect(f.store.seq(WORLD_ROOM)).toBe(seqBefore + 1);
  });

  it("P2-3：publish 路径在 E_SEQ_GAP 重试 load 中 abort → 报告 aborted、written=0、apply≤2", async () => {
    const f = await fixture({
      records: [record("mem_a", A, "图书馆新增了自助借书机"), record("mem_b", B, "图书馆新增了自助借书机")],
    });
    const controller = new AbortController();
    const realApply = f.arbiter.apply.bind(f.arbiter);
    const seqGate = { resolve: (() => undefined) as () => void, promise: Promise.resolve() };
    seqGate.promise = new Promise<void>((resolve) => { seqGate.resolve = resolve; });
    let applyCalls = 0;
    const realLoad = f.store.load.bind(f.store);
    const seqAtRetry = await realLoad(WORLD_ROOM);
    vi.spyOn(f.store, "load").mockImplementation(async (roomId) => {
      if (roomId === WORLD_ROOM && applyCalls === 1) {
        await seqGate.promise; // 确定性挂起在重试窗口内
        controller.abort();
        // 新世代写入推进 seq：旧逻辑若继续，下一轮 apply 会成功并以新 seq 落库
        f.store.append(WORLD_ROOM, [env(seqAtRetry + 1, "time.advanced", { day: 2, tick: 1 }, WORLD_ROOM)]);
      }
      return realLoad(roomId);
    });
    vi.spyOn(f.arbiter, "apply").mockImplementation(async (roomId, ops, cause, opts) => {
      applyCalls += 1;
      if (roomId === WORLD_ROOM && applyCalls === 1 && opts?.expectedSeq === 0) {
        // 首次 apply 故意 E_SEQ_GAP，触发重试窗口
        return { ok: false, mode: "atomic", seq: 99, applied: [], rejected: [], events: [],
          error: { code: "E_SEQ_GAP", message: "injected" } };
      }
      return realApply(roomId, ops, cause, opts);
    });

    const reportPromise = (await job(f)).retireRoom(ROOM, { signal: controller.signal });
    seqGate.resolve();
    const report = await reportPromise;
    expect(applyCalls).toBeLessThanOrEqual(2);
    expect(report.aborted).toBe(true);
    expect(report.written).toHaveLength(0);
    expect(report.errors).not.toContain("E_SEQ_GAP");
    const written = (await f.store.events(WORLD_ROOM, 0)).filter((e) => e.type === "memory.written");
    expect(written).toHaveLength(0);
  });

  it("撤回未知 memoryId 返回 false（不静默放行）", async () => {
    const f = await fixture({ records: [record("mem_a", A, "操场旁边多了一排水龙头"), record("mem_b", B, "操场旁边多了一排水龙头")] });
    const j = await job(f);
    expect(await j.tombstone("mem_does_not_exist", "乱填")).toBe(false);
  });

  it("熔断：judge 连续失败到阈值后当天不再尝试，stats() 报 circuitOpen", async () => {
    const records = ["食堂新开了一家面馆", "操场边上多了一排长椅", "图书馆换了新的借书系统"].map((c, i) => record(`mem_${i}`, [A, B][i % 2]!, c));
    const f = await fixture({ records: records.flatMap((r) => [r, record(`${r.id}_b`, r.ownerId === A ? B : A, r.content)]) });
    const judge = { review: async () => { throw new Error("审核服务 502"); } };
    const j = await job(f, judge, true, 200, 2);
    const r = await j.retireRoom(ROOM);
    expect(r.written).toHaveLength(0);
    expect(j.stats().circuitOpen).toBe(true);
    expect(j.stats().consecutiveJudgeFailures).toBeGreaterThanOrEqual(2);
    const again = await j.retireRoom(ROOM);
    expect(again.skipped[0]?.reason).toBe("circuit_open");
    expect(j.sample(10)).toEqual([]);
  });

  it("体量：当日超 dailyCap 的候选不落库，跨日后重新聚合再发布（P1-B 定版：不建次日队列）", async () => {
    const lost = "食堂门口贴了一张失物招领";
    const bench = "操场旁边多了一排长椅";
    const f = await fixture({
      records: [record("mem_l1", A, lost), record("mem_l2", B, lost), record("mem_b1", A, bench), record("mem_b2", B, bench)],
    });
    let day = "2026-11-17";
    const j = new CanonizeJob({
      store: f.store,
      arbiter: f.arbiter,
      worldRoom: WORLD_ROOM,
      worldId: WORLD,
      memory: f.memory,
      judge: { review: async () => ({ allow: true }) },
      limits: { enabled: true, dailyCap: 1, minWitness: 2, perSourceCap: 2 },
      today: () => day,
      onVersionBump: async (worldId, version) => {
        f.bump.push({ worldId, version });
      },
    });
    const first = await j.retireRoom(ROOM);
    expect(first.skipped.some((x) => x.reason === "daily_cap")).toBe(true);

    // 跨日：候选不会被"队列"记住，但可以从房间记忆重新聚合出来
    day = "2026-11-18";
    const second = await j.retireRoom(ROOM);
    expect(second.written).toHaveLength(1);
    expect(j.stats().version).toBe(2);
  });
});
