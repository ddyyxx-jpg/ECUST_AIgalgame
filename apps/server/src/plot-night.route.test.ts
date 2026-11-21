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
});
