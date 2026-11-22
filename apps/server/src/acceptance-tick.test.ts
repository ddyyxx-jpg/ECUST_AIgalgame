/**
 * #95 tick 编排端到端验收：HTTP POST /map/tick 上验证 #38 的原子批次。
 *
 * 用真实 createApp + FileStore + Arbiter + registry，只把 ModuleHost 换成受控 tick 提案，
 * 断言响应/事件/状态结构（时段 + 模块提案同批提交，一条被拒整批不落库），不断言文案。
 * 出站掩码由 map-events-mask.test.ts / map-failure-mask.test.ts / map-dialogue-mask.test.ts 覆盖；
 * 总开关 429 由 quota.routes.test.ts 覆盖，这里只补 seq/时段不变的端到端确认。
 */
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { tempDir } from "@galgame/testkit";
import type {
  Envelope, ModuleContext, ModuleInfo, ModuleOutcome, Modules, Phase, Proposal,
} from "../../../packages/shared/src/contract/types.ts";
import { createApp } from "./bootstrap.ts";
import type { App } from "./bootstrap.ts";
import type { ServerConfig } from "./config.ts";
import type { MapServiceDeps } from "./map.ts";
import { registerRoutes } from "./routes.ts";

class TickModules implements Modules {
  proposals: Proposal[] = [];
  readonly phases: Phase[] = [];

  async load(): Promise<void> {}
  list(): ModuleInfo[] {
    return [];
  }
  get(): ModuleInfo | undefined {
    return undefined;
  }
  async dispatchIntent(): Promise<ModuleOutcome> {
    return { ok: false, proposals: [] };
  }
  async callTool(): Promise<ModuleOutcome> {
    return { ok: false, proposals: [] };
  }
  async tick(_ctx: ModuleContext, phase: Phase): Promise<Proposal[]> {
    this.phases.push(phase);
    return this.proposals;
  }
  context(): never[] {
    return [];
  }
  view(): null {
    return null;
  }
}

function config(): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: tempDir("galgame-accept-tick-"),
    contentDir: "content",
    adminToken: "dev-admin",
    trustUserHeader: true,
    llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
    audit: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1000 },
  };
}

interface Fixture {
  app: FastifyInstance;
  deps: App;
  roomId: string;
  actorId: string;
  modules: TickModules;
}

async function setup(): Promise<Fixture> {
  const deps = await createApp(config());
  const app = Fastify();
  registerRoutes(app, deps);
  const created = await app.inject({ method: "POST", url: "/api/v1/rooms", payload: { mode: "solo" } });
  expect(created.statusCode).toBe(200);
  const { roomId, actorId } = created.json() as { roomId: string; actorId: string };
  const modules = new TickModules();
  // MapService 通过 deps.modules 动态取模块宿主；只替换这一条边，保留真实 store/arbiter/registry。
  (deps.map as unknown as { deps: MapServiceDeps }).deps.modules = modules;
  return { app, deps, roomId, actorId, modules };
}

function seqOf(deps: App, roomId: string): number {
  return (deps.store as unknown as { seq: (id: string) => number }).seq(roomId);
}

function tick(app: FastifyInstance, roomId: string, advance = true) {
  return app.inject({ method: "POST", url: `/api/v1/rooms/${roomId}/map/tick`, payload: { advance } });
}

type TickBody = {
  ok: boolean;
  code?: string;
  events: Envelope[];
  moved: unknown[];
  map: { clock: { day: number; phase: string; tick: number } };
};

describe("#95 tick 原子批次验收（HTTP 端到端）", () => {
  it("time.advance 与模块 x.* 提案同批提交：事件顺序 clock.advanced → attr.changed，seq 连续", async () => {
    const { app, deps, roomId, actorId, modules } = await setup();
    const before = await deps.store.snapshot(roomId);
    const seqBefore = seqOf(deps, roomId);
    modules.proposals = [{
      op: "attr.delta",
      args: { entityId: actorId, key: "x.acceptance_tick", delta: 1 },
      reason: "验收用 tick 提案",
    }];

    const res = await tick(app, roomId);
    expect(res.statusCode).toBe(200);
    const body = res.json() as TickBody;
    expect(body.ok).toBe(true);
    expect(body.events.map((e) => e.type)).toEqual(["clock.advanced", "attr.changed"]);
    expect(body.events.map((e) => e.seq)).toEqual([seqBefore + 1, seqBefore + 2]);
    expect(body.moved).toEqual([]);
    expect(modules.phases).toEqual(["noon"]);

    const after = await deps.store.snapshot(roomId);
    expect(after.clock.phase).toBe("noon");
    expect(after.clock.phase).not.toBe(before.clock.phase);
    expect(after.entities[actorId]?.attrs["x.acceptance_tick"]).toBe(1);
    expect(body.map.clock.phase).toBe(after.clock.phase);
    expect(seqOf(deps, roomId)).toBe(seqBefore + 2);
    await app.close();
  });

  it("任一条提案被拒 → 整批不落库：无事件、时段/seq/状态不变；改好后重试只推进一次", async () => {
    const { app, deps, roomId, actorId, modules } = await setup();
    const before = await deps.store.snapshot(roomId);
    const seqBefore = seqOf(deps, roomId);

    modules.proposals = [{
      op: "attr.delta",
      args: { entityId: actorId, key: "acceptance_unknown_attr", delta: 1 },
      reason: "故意用未声明属性",
    }];
    const bad = await tick(app, roomId);
    const badBody = bad.json() as TickBody;
    expect(badBody.ok).toBe(false);
    expect(badBody.code).toBe("E_ATTR_UNKNOWN");
    expect(badBody.events ?? []).toEqual([]);
    expect((await deps.store.snapshot(roomId)).clock).toEqual(before.clock);
    expect((await deps.store.snapshot(roomId)).entities[actorId]?.attrs).toEqual(before.entities[actorId]?.attrs);
    expect(seqOf(deps, roomId)).toBe(seqBefore);

    // 同一房间重试：这次提案合法，时段只前进一格，seq 只加 2（advance + 提案）
    modules.proposals = [{
      op: "attr.delta",
      args: { entityId: actorId, key: "x.acceptance_tick", delta: 1 },
      reason: "修正后的 tick 提案",
    }];
    const retried = await tick(app, roomId);
    expect((retried.json() as TickBody).ok).toBe(true);
    const after = await deps.store.snapshot(roomId);
    expect(after.clock.phase).toBe("noon");
    expect(seqOf(deps, roomId)).toBe(seqBefore + 2);

    // advance:false 的重复 tick 没有 time.advance，也不会重复推进时段；空提案不写日志
    modules.proposals = [];
    const repeat = await tick(app, roomId, false);
    expect((repeat.json() as TickBody).ok).toBe(true);
    expect(seqOf(deps, roomId)).toBe(seqBefore + 2);
    expect((await deps.store.snapshot(roomId)).clock).toEqual(after.clock);
    await app.close();
  });

  it("actionsEnabled=false 时 tick 返回 429，时段与 seq 均不变", async () => {
    const { app, deps, roomId } = await setup();
    const before = await deps.store.snapshot(roomId);
    const seqBefore = seqOf(deps, roomId);
    const disabled = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/settings",
      headers: { "x-admin-token": "dev-admin", origin: "https://galgame.test" },
      payload: { actionsEnabled: false },
    });
    expect(disabled.statusCode).toBe(200);

    const res = await tick(app, roomId);
    expect(res.statusCode).toBe(429);
    expect((res.json() as { code: string }).code).toBe("E_RATE_LIMITED");
    expect((await deps.store.snapshot(roomId)).clock).toEqual(before.clock);
    expect(seqOf(deps, roomId)).toBe(seqBefore);
    await app.close();
  });
});
