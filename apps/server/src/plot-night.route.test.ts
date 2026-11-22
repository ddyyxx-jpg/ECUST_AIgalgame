/**
 * #96/#128 夜间密谋端到端探针（AGENTS §12.2）。
 *
 * 真实链路：createApp（FileStore + JsonRegistry + ModuleHost + Arbiter + DialogueHost）
 * → app.inject 的 /map/tick → 真实 EventLog。只在装配处替换 LLM 端口为 fake。
 * 断言事件类型/数量/结构（来自引擎发射字面量），不断言任何文案。
 */
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { tempDir } from "@galgame/testkit";
import type { EventLog } from "../../../packages/engine/src/store.ts";
import type { LlmPort, LlmRequest, LlmResult } from "../../../packages/shared/src/contract/types.ts";
import { createApp } from "./bootstrap.ts";
import type { ServerConfig } from "./config.ts";
import { LlmSwitch } from "./llm-switch.ts";
import { registerRoutes } from "./routes.ts";

const ORIGIN = { origin: "https://galgame.test" };
const DRAFT = {
  goal: "g",
  actors: ["npc_lin", "npc_bai"],
  leakPoints: ["leakA", "leakB"],
  forbidReveal: "SECRET",
};

function testConfig(dataDir: string): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir,
    contentDir: "content",
    adminToken: "dev-admin",
    trustUserHeader: true,
    llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
    audit: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1000 },
  };
}

function fakeLlm(mode: "ok" | "throw" = "ok"): LlmPort {
  return {
    async chat(req: LlmRequest): Promise<LlmResult> {
      if (mode === "throw") throw new Error("fake llm down");
      const system = req.messages.find((m) => m.role === "system")?.content ?? "";
      // 调查 turn 是 skipLLM，只有导演会走这里。
      const payload = system.includes("密谋编排器")
        ? DRAFT
        : { lines: [{ actorId: "npc_lin", text: "lineA" }, { actorId: "npc_bai", text: "lineB" }] };
      const raw = JSON.stringify(payload);
      return {
        raw,
        json: payload,
        usage: { promptTokens: 1, completionTokens: 1, calls: 1 },
        model: "fake",
        latencyMs: 0,
      };
    },
  };
}

async function setup(mode: "ok" | "throw" = "ok") {
  const deps = await createApp(testConfig(tempDir("galgame-plot-night-")));
  const app = Fastify();
  registerRoutes(app, deps);
  const created = await app.inject({ method: "POST", url: "/api/v1/rooms", headers: ORIGIN, payload: { mode: "solo" } });
  expect(created.statusCode).toBe(200);
  const { roomId, actorId } = created.json() as { roomId: string; actorId: string };
  const sw = (deps.settings as unknown as { sw: LlmSwitch }).sw;
  sw.use(fakeLlm(mode));

  // 把时钟推进到 evening（issue #38 的同批语义由 map.test 覆盖；这里直接设置前置状态）。
  await deps.arbiter.apply(roomId, [{ op: "time.advance", args: { phase: "evening" } }], {
    v: 1, id: "evt_fixture_evening", roomId, seq: 0, ts: Date.now(), actorId: "system", type: "engine", payload: {},
  });
  const baselineSeq = await seqOf(deps.store as EventLog, roomId);
  const tick = () => app.inject({ method: "POST", url: `/api/v1/rooms/${roomId}/map/tick`, headers: ORIGIN, payload: { advance: true } });
  const tickNoAdvance = () => app.inject({ method: "POST", url: `/api/v1/rooms/${roomId}/map/tick`, headers: ORIGIN, payload: { advance: false } });
  return { app, deps, roomId, actorId, baselineSeq, tick, tickNoAdvance };
}

async function seqOf(store: EventLog, roomId: string): Promise<number> {
  const events = await store.events(roomId, 0);
  return events.length === 0 ? 0 : Math.max(...events.map((e) => e.seq));
}

async function newEvents(deps: Awaited<ReturnType<typeof setup>>["deps"], roomId: string, from: number) {
  return (await deps.store.events(roomId, from)).filter((e) => e.seq > from);
}

describe("夜间密谋真实链路探针（#96/#128）", () => {
  it("夜间 tick 后 EventLog 真实出现 plot.upserted + 每名 actor 一条 memory.written", async () => {
    const { deps, roomId, tick, baselineSeq } = await setup("ok");
    const res = await tick();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });

    const events = await newEvents(deps, roomId, baselineSeq);
    expect(events.some((e) => e.type === "clock.advanced")).toBe(true);
    const plots = events.filter((e) => e.type === "plot.upserted");
    expect(plots).toHaveLength(1);
    const plot = (plots[0]?.payload as { plot?: { actors?: string[]; leakPoints?: string[] } }).plot;
    expect(plot?.actors).toEqual(DRAFT.actors);
    expect(plot?.leakPoints).toEqual(DRAFT.leakPoints);
    const mems = events.filter((e) => e.type === "memory.written");
    expect(mems).toHaveLength(DRAFT.actors.length);
    expect(new Set(mems.map((e) => (e.payload as { ownerId?: string }).ownerId))).toEqual(new Set(DRAFT.actors));
    for (const m of mems) {
      expect((m.payload as { visibility?: string }).visibility).toBe("private");
      expect((m.payload as { content?: string }).content).not.toContain(DRAFT.forbidReveal);
    }
  });

  it("导演 LLM 抛错：tick 仍 ok:true，世界状态未坏（无密谋事件）", async () => {
    const { deps, roomId, tick, baselineSeq, actorId } = await setup("throw");
    const res = await tick();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    const state = await deps.store.snapshot(roomId);
    expect(state.clock.phase).toBe("night");
    expect(state.room.members.find((m) => m.actorId === actorId)).toBeDefined();
    const events = await newEvents(deps, roomId, baselineSeq);
    expect(events.some((e) => e.type === "clock.advanced")).toBe(true);
    expect(events.some((e) => e.type === "plot.upserted")).toBe(false);
  });

  it("白天 investigate：真实 turn 产出 evidence memory.written + 每名 actor 一条 attr.changed", async () => {
    const { deps, roomId, tick, actorId } = await setup("ok");
    await tick(); // 夜间落账
    const beforeInvestigate = await seqOf(deps.store as EventLog, roomId);
    const turn = await deps.turn.run({
      roomId, actorId, input: "调查线索", clientTurnId: "c_probe_1", options: { skipLLM: true },
    });
    for await (const _ of turn) { /* consume real turn stream */ }
    const events = await newEvents(deps, roomId, beforeInvestigate);
    // 真实引擎事件类型：memory.written / attr.changed，不是手造 envelope。
    const evidence = events.filter((e) => e.type === "memory.written");
    expect(evidence.length).toBeGreaterThanOrEqual(DRAFT.leakPoints.length);
    expect(evidence.every((e) => (e.payload as { ownerId?: string }).ownerId === actorId)).toBe(true);
    const deltas = events.filter((e) => e.type === "attr.changed");
    expect(deltas).toHaveLength(DRAFT.actors.length);
    expect(new Set(deltas.map((e) => (e.payload as { entityId?: string }).entityId))).toEqual(new Set(DRAFT.actors));
  });

  it("同一夜重复推进不会重复落账（幂等：tick 只在进入夜间触发一次）", async () => {
    const { deps, roomId, tick, baselineSeq } = await setup("ok");
    await tick();
    const afterFirst = await seqOf(deps.store as EventLog, roomId);
    // 再请求一次 advance：phase 已是 night，nextPhase 进入 morning，不满足"进入夜间"。
    // 这里只断言不重复落账；tick 整体 ok 与否受其他模块的既有幂等语义影响，与本功能无关。
    await tick();
    const events = await newEvents(deps, roomId, afterFirst);
    expect(events.some((e) => e.type === "plot.upserted")).toBe(false);
    const all = await newEvents(deps, roomId, baselineSeq);
    expect(all.filter((e) => e.type === "plot.upserted")).toHaveLength(1);
  });

  // ---------------------------------------------------------------- PR #147 审阅 P0 / P1
  it("P0：夜间密谋的秘密不经 /state、/events、/map/tick 泄露给玩家", async () => {
    const { app, roomId, actorId, tick } = await setup("ok");
    const res = await tick();
    expect(res.statusCode).toBe(200);
    // 响应体：plot 的 GM 字段与 leak 文本都不能出现
    for (const secret of [DRAFT.forbidReveal, ...DRAFT.leakPoints, "forbidReveal", "leakPoints"]) {
      expect(res.body).not.toContain(secret);
    }
    const headers = { ...ORIGIN, "x-user-id": actorId };
    const state = await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/state`, headers });
    expect(state.statusCode).toBe(200);
    expect(state.body).not.toContain(DRAFT.forbidReveal);
    for (const leak of DRAFT.leakPoints) expect(state.body).not.toContain(leak);

    const evs = await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/events?fromSeq=0`, headers });
    expect(evs.statusCode).toBe(200);
    expect(evs.body).not.toContain(DRAFT.forbidReveal);
    for (const leak of DRAFT.leakPoints) expect(evs.body).not.toContain(leak);
    // 私忆：NPC 的 private memory.written 不能出现在事件流里（玩家自己的除外）
    const listed = evs.json() as { events: { type: string; payload?: { ownerId?: string; visibility?: string } }[] };
    const npcPrivate = listed.events.filter(
      (e) => e.type === "memory.written" && e.payload?.visibility !== "public" && e.payload?.ownerId !== actorId,
    );
    expect(npcPrivate).toHaveLength(0);
    // 反向断言：不是"把 plot 整条删掉"蒙过测试——玩家仍看得到 id/参与人/status，只是没有 GM 字段
    const plot = listed.events.find((e) => e.type === "plot.upserted");
    const visiblePlot = (plot?.payload as { plot?: Record<string, unknown> } | undefined)?.plot;
    expect(visiblePlot?.id).toEqual(expect.any(String));
    expect(visiblePlot?.status).toBe("active");
    expect(visiblePlot?.actors).toHaveLength(2);
    expect(visiblePlot?.goal).toBeUndefined();
  });

  it("P1-1/P1-2：跨两夜私忆 id 不碰撞，且 tick 后立即进记忆索引", async () => {
    const { deps, roomId, tick, baselineSeq } = await setup("ok");
    await tick(); // 第 1 夜（evening → night）
    const afterNight1 = await seqOf(deps.store as EventLog, roomId);
    const night1 = (await newEvents(deps, roomId, baselineSeq)).filter((e) => e.type === "memory.written");
    expect(night1.length).toBe(DRAFT.actors.length);
    // 立即召回：apply 之后没跑 v1 回合/重启，索引里就应该有这些私忆（P1-2）
    const indexed = deps.memory.all(roomId).filter((m) => m.visibility !== "public");
    expect(indexed.length).toBeGreaterThanOrEqual(DRAFT.actors.length);

    // 用真实 tick 走完一天再进第 2 夜：night→morning→noon→afternoon→evening→night
    for (let i = 0; i < 5; i++) await tick();
    const night2 = (await newEvents(deps, roomId, afterNight1)).filter((e) => e.type === "memory.written");
    expect(night2.length).toBe(DRAFT.actors.length);
    const ids = [...night1, ...night2].map((e) => (e.payload as { memoryId?: string }).memoryId);
    expect(ids).toHaveLength(DRAFT.actors.length * 2);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("P1-3：active plot 满额时先结案往夜剧情再开新夜，不再整批被拒", async () => {
    const { deps, roomId, actorId, tick } = await setup("ok");
    const cause = { v: 1, id: "evt_fixture_seed", roomId, seq: 0, ts: Date.now(), actorId: "system", type: "engine", payload: {} } as const;
    const seed = Array.from({ length: 6 }, (_, i) => ({
      op: "plot.upsert" as const,
      args: { id: `plot_seed_${i}`, goal: `g${i}`, actors: DRAFT.actors, leakPoints: ["leakA"], forbidReveal: "SECRET" },
    }));
    await deps.arbiter.apply(roomId, seed, { ...cause, id: "evt_fixture_seed" });
    // 把状态推到下一天的 evening（第 1 夜已经过去，seed plot 的 createdDay 变成"往夜"）
    for (const phase of ["night", "morning", "noon", "afternoon", "evening"] as const) {
      await deps.arbiter.apply(roomId, [{ op: "time.advance", args: { phase } }], {
        ...cause, id: `evt_fixture_${phase}`,
      });
    }
    const before = await seqOf(deps.store as EventLog, roomId);
    const res = await tick();
    expect(res.statusCode).toBe(200);
    const events = await newEvents(deps, roomId, before);
    const plots = events.filter((e) => e.type === "plot.upserted").map((e) => (e.payload as { plot: { id: string; status: string } }).plot);
    expect(plots.some((p) => p.status === "resolved")).toBe(true);
    // 新夜密谋照常落库（不再因为配额被整批拒）
    expect(plots.some((p) => p.status === "active" && !p.id.startsWith("plot_seed_"))).toBe(true);
    const after = await deps.store.snapshot(roomId);
    expect(after.plots.filter((p) => p.status === "active").length).toBeLessThanOrEqual(6);
    expect(after.clock.phase).toBe("night");
    expect(actorId).toBeTruthy();
  });

  it("P2-1：并发两个 /map/tick 只推一次时段、只开一场密谋", async () => {
    const { deps, roomId, tick, baselineSeq } = await setup("ok");
    const [a, b] = await Promise.all([tick(), tick()]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const events = await newEvents(deps, roomId, baselineSeq);
    // evening→night 只发生一次；第二次请求在队列里看到 phase=night，推进到 morning（不触发密谋）
    expect(events.filter((e) => e.type === "plot.upserted")).toHaveLength(1);
    const state = await deps.store.snapshot(roomId);
    expect(state.clock.phase).toBe("morning");
  });
});
