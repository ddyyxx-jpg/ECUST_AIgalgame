import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@galgame/testkit";
import type { WorldState } from "../../../packages/shared/src/contract/types.ts";
import { DefaultArbiter } from "../../../packages/engine/src/arbiter.ts";
import { JsonRegistry } from "../../../packages/engine/src/registry.ts";
import { FileStore } from "../../../packages/engine/src/store.ts";
import {
  NpcDecisionService,
  buildDecisionOptions,
  buildPerception,
  fallbackChoice,
  parseDecision,
} from "./npc-decision.ts";

const OPT2 = [
  { index: 1, locId: "loc_a", label: "留在图书馆" },
  { index: 2, locId: "loc_b", label: "去食堂" },
] as const;

function state(overrides: Partial<WorldState> = {}): WorldState {
  return {
    schemaVersion: 2,
    room: {
      id: "room_a",
      mode: "solo",
      worldId: "w",
      members: [{ actorId: "plr", role: "player", joinedSeq: 1 }],
      scene: { locId: "loc_player", presentIds: ["plr"] },
      createdAt: 1,
      lastActiveAt: 1,
    },
    entities: {
      loc_a: { id: "loc_a", kind: "loc", name: "图书馆", attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 },
      loc_b: { id: "loc_b", kind: "loc", name: "食堂", attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 },
      loc_c: { id: "loc_c", kind: "loc", name: "宿舍", attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 },
      loc_player: { id: "loc_player", kind: "loc", name: "操场", attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 },
      npc_1: { id: "npc_1", kind: "npc", name: "林静", attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 },
      plr: { id: "plr", kind: "plr", name: "你", attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 },
    },
    links: [
      { id: "l1", kind: "located_in", from: "loc_a", to: "loc_b", createdAt: 0 },
      { id: "l2", kind: "located_in", from: "loc_b", to: "loc_c", createdAt: 0 },
      { id: "l3", kind: "located_in", from: "npc_1", to: "loc_a", createdAt: 0 },
      { id: "l4", kind: "located_in", from: "plr", to: "loc_player", createdAt: 0 },
    ],
    clock: { day: 1, phase: "morning", tick: 0 },
    plots: [],
    moduleState: {},
    ...overrides,
  };
}

describe("npc-decision 纯函数", () => {
  it("菜单只给留下 + 相邻地点；感知只含公开信息", () => {
    const s = state();
    s.entities.npc_2 = { id: "npc_2", kind: "npc", name: "赵可", attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 };
    s.links.push({ id: "l5", kind: "located_in", from: "npc_2", to: "loc_a", createdAt: 0 });
    const options = buildDecisionOptions(s, "npc_1", 4);
    expect(options.map((o) => o.locId)).toEqual(["loc_a", "loc_b"]);
    const perception = buildPerception(s, "npc_1", options)!;
    expect(perception.text).toContain("图书馆");
    expect(perception.text).toContain("1. 留在图书馆");
    expect(perception.text).toContain("赵可");
    expect(perception.text).not.toContain("secret");
  });

  it("解析 1-based choice；坏 JSON/越界返回 null；fallback 确定性", () => {
    expect(parseDecision({ choice: 2, reason: "去吃饭" }, OPT2)).toEqual({ choice: 2, reason: "去吃饭" });
    expect(parseDecision('```json\n{"choice":1}\n```', OPT2)).toEqual({ choice: 1 });
    expect(parseDecision({ choice: 3 }, OPT2)).toBeNull();
    expect(parseDecision("not json", OPT2)).toBeNull();
    const s = state();
    expect(fallbackChoice("room_a", "npc_1", s, 3)).toBe(fallbackChoice("room_a", "npc_1", s, 3));
    expect(fallbackChoice("room_a", "npc_1", s, 3)).toBeGreaterThanOrEqual(0);
    expect(fallbackChoice("room_a", "npc_1", s, 3)).toBeLessThan(3);
  });
});

describe("NpcDecisionService", () => {
  it("开启后调用一次模型并把选择写成 move 租约", async () => {
    const applied: unknown[] = [];
    let expected: number | undefined;
    let messages: { role: string; content: string }[] = [];
    const service = new NpcDecisionService({
      store: { snapshot: async () => state(), load: async () => 7 },
      arbiter: { apply: async (_room, ops, _cause, opts) => { applied.push(ops); expected = opts?.expectedSeq; return { ok: true }; } },
      llm: {
        chat: async (req) => {
          messages = req.messages as { role: string; content: string }[];
          return { raw: '{"choice":2}', json: { choice: 2 }, usage: { promptTokens: 1, completionTokens: 1, calls: 1 }, model: "fake", latencyMs: 1 };
        },
      },
      policy: { enabled: true, maxPerBeat: 1, intervalTicks: 1, hourlyCalls: 10, maxOptions: 4 },
    });
    await service.run("room_a", state());
    expect(applied).toHaveLength(1);
    // 部分兼容网关只给 system 会续写协议；必须补一条 user
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    const ops = applied[0] as { args: { entityId: string; key: string; value: string } }[];
    expect(ops[0].args.entityId).toBe("npc_1");
    expect(ops[0].args.key).toBe("sim_lease");
    expect(JSON.parse(ops[0].args.value)).toMatchObject({ action: "move", target: "loc_b", phase: "morning" });
    expect(expected).toBe(7);
  });

  it("NPC 只是原地停留（stay 租约）时仍可被自由活动接管", async () => {
    const applied: unknown[] = [];
    const stay = JSON.stringify({ action: "stay", target: "loc_a", remaining: 2, phase: "morning" });
    const base = state();
    const withStay = {
      ...base,
      entities: { ...base.entities, npc_1: { ...base.entities.npc_1!, attrs: { sim_lease: stay } } },
    } as WorldState;
    const service = new NpcDecisionService({
      store: { snapshot: async () => withStay, load: async () => 3 },
      arbiter: { apply: async (_room, ops) => { applied.push(ops); return { ok: true }; } },
      llm: {
        chat: async () => ({ raw: '{"choice":2}', json: { choice: 2 }, usage: { promptTokens: 1, completionTokens: 1, calls: 1 }, model: "fake", latencyMs: 1 }),
      },
      policy: { enabled: true, maxPerBeat: 1, intervalTicks: 1, hourlyCalls: 10, maxOptions: 4 },
    });
    await service.run("room_a", withStay);
    expect(applied).toHaveLength(1);
  });

  it("模型用 option/action/字符串表达选择时也能解析", () => {
    expect(parseDecision({ option: 2 }, OPT2)).toEqual({ choice: 2 });
    expect(parseDecision({ action: 1 }, OPT2)).toEqual({ choice: 1 });
    expect(parseDecision({ action: "stay in canteen" }, OPT2)).toEqual({ choice: 1, reason: "stay in canteen" });
    expect(parseDecision({ action: "去食堂" }, OPT2)).toEqual({ choice: 2, reason: "去食堂" });
    expect(parseDecision({ choice: "2" }, OPT2)).toEqual({ choice: 2 });
  });

  it("思考型模型把 JSON 夹在推理后面时也能解析", () => {
    const raw = '先想想：他应该去食堂。\n{"choice": 2, "reason": "去吃饭"}';
    expect(parseDecision(raw, OPT2)).toEqual({ choice: 2, reason: "去吃饭" });
  });

  it("慢决策期间玩家写了 talk 租约：放弃写入，不覆盖冻结", async () => {
    let reads = 0;
    let writes = 0;
    const service = new NpcDecisionService({
      store: {
        load: async () => 7,
        snapshot: async () => {
          reads += 1;
          const s = state();
          if (reads > 1) s.entities.npc_1!.attrs.sim_lease = JSON.stringify({ action: "talk", target: "loc_a", remaining: 1, phase: "morning" });
          return s;
        },
      },
      arbiter: { apply: async () => { writes += 1; return { ok: true }; } },
      llm: {
        chat: async () => ({ raw: '{"choice":2}', json: { choice: 2 }, usage: { promptTokens: 1, completionTokens: 1, calls: 1 }, model: "fake", latencyMs: 1 }),
      },
      policy: { enabled: true, maxPerBeat: 1, intervalTicks: 1, hourlyCalls: 10, maxOptions: 4 },
    });
    await service.run("room_a");
    expect(writes).toBe(0);
  });

  it("慢决策跨 phase：放弃写入，不用旧 phase 的租约污染下一段", async () => {
    let writes = 0;
    const warnings: string[] = [];
    const service = new NpcDecisionService({
      store: {
        load: async () => 7,
        // run() 用的是传入的 morning 快照；applyLease 重读时已经到 noon。
        snapshot: async () => ({ ...state(), clock: { day: 1, phase: "noon" as const, tick: 0 } }),
      },
      arbiter: { apply: async () => { writes += 1; return { ok: true }; } },
      llm: {
        chat: async () => ({ raw: '{"choice":2}', json: { choice: 2 }, usage: { promptTokens: 1, completionTokens: 1, calls: 1 }, model: "fake", latencyMs: 1 }),
      },
      policy: { enabled: true, maxPerBeat: 1, intervalTicks: 1, hourlyCalls: 10, maxOptions: 4 },
      warn: (m) => warnings.push(m),
    });
    await service.run("room_a", state());
    expect(writes).toBe(0);
    expect(warnings.join("\n")).toContain("决策跨 phase");
  });

  it("关闭时不调模型、不写状态", async () => {
    let calls = 0;
    const service = new NpcDecisionService({
      store: { snapshot: async () => state() },
      arbiter: { apply: async () => { throw new Error("should not write"); } },
      llm: { chat: async () => { calls += 1; throw new Error("should not call"); } },
      policy: { enabled: false, maxPerBeat: 1, intervalTicks: 1, hourlyCalls: 10, maxOptions: 4 },
    });
    await service.run("room_a", state());
    expect(calls).toBe(0);
  });
});


describe("NpcDecisionService 真实落盘", () => {
  it("通过 DefaultArbiter 写入 FileStore，快照里能读到决策租约", async () => {
    const dir = tempDir("galgame-npc-decision-");
    const room = "room_probe";
    const store = new FileStore(dir, { worldId: "w", locId: "loc_player" });
    let seq = await store.load(room);
    const entity = (id: string, kind: string, name: string) => ({
      id, kind, name, attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0,
    });
    const append = async (type: string, payload: unknown) => {
      seq += 1;
      await store.append(room, [{ v: 1, id: `evt_probe_${seq}`, roomId: room, seq, ts: 1, actorId: "system", type, payload }]);
    };
    await append("entity.created", { entity: entity("loc_a", "loc", "图书馆") });
    await append("entity.created", { entity: entity("loc_b", "loc", "食堂") });
    await append("entity.created", { entity: entity("loc_player", "loc", "教学楼") });
    await append("entity.created", { entity: entity("npc_1", "npc", "林") });
    await append("entity.created", { entity: entity("plr", "plr", "我") });
    await append("link.created", { link: { id: "l1", kind: "located_in", from: "npc_1", to: "loc_a", createdAt: 0 } });
    await append("link.created", { link: { id: "l2", kind: "located_in", from: "plr", to: "loc_player", createdAt: 0 } });
    await append("link.created", { link: { id: "l3", kind: "located_in", from: "loc_a", to: "loc_b", createdAt: 0 } });
    await append("scene.changed", { locId: "loc_player", presentIds: ["plr"] });

    const registry = await JsonRegistry.load(path.join(process.cwd(), "content", "registry"));
    const arbiter = new DefaultArbiter({ store, registry });
    const service = new NpcDecisionService({
      store, arbiter, llm: { chat: async () => ({ raw: "", json: { choice: 2 }, usage: { promptTokens: 1, completionTokens: 1, calls: 1 }, model: "fake", latencyMs: 1 }) },
      policy: { enabled: true, maxPerBeat: 1, intervalTicks: 1, hourlyCalls: 5, maxOptions: 4 },
      warn: () => {},
    });
    await service.run(room);
    const snap = await store.snapshot(room);
    const lease = JSON.parse(String(snap.entities.npc_1.attrs.sim_lease));
    expect(lease).toMatchObject({ action: "move", target: "loc_b", remaining: 1, phase: "morning" });
  });

  it("去掉「留下」选项后，模型回 stay 不会被误映射成 1 号移动选项", () => {
    const moves = [
      { index: 1, locId: "loc_canteen", label: "去食堂" },
      { index: 2, locId: "loc_library", label: "去图书馆" },
    ];
    expect(parseDecision({ action: "stay in canteen" }, moves)).toBeNull();
    expect(parseDecision({ action: "留在原地" }, moves)).toBeNull();
  });
});
