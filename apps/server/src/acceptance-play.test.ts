/**
 * #94 玩法验收补口：模块清单/意图/工具完整性 + 20 回合顺序提交与重放 + registry 驱动的 View。
 *
 * 只断言 Proposal / 事件 / 视图结构，不断言叙事文案（AGENTS.md 铁律 7）。
 * 回归项（坏 JSON 重问 / E_LLM_FORMAT / E_STORE_FAULT / 幂等 / expectedSeq）已由
 * packages/engine/src/turn.test.ts、turn.idempotency.test.ts、arbiter.test.ts、
 * atomicity.test.ts、turn.parse.test.ts 覆盖，这里不重复。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@galgame/testkit";
import { MockLlm } from "../../../packages/llm/src/mock.ts";
import { DefaultArbiter } from "../../../packages/engine/src/arbiter.ts";
import { ModuleHost } from "../../../packages/engine/src/modules.ts";
import { InMemoryMemory } from "../../../packages/engine/src/memory.ts";
import { emptyRegistry, JsonRegistry } from "../../../packages/engine/src/registry.ts";
import { FileStore } from "../../../packages/engine/src/store.ts";
import { DefaultTurn } from "../../../packages/engine/src/turn.ts";
import { parseCommitEvidence } from "../../../packages/engine/src/turn.evidence.ts";
import { OP_NAMES } from "../../../packages/shared/src/contract/types.ts";
import type {
  AttrDef, Entity, ModuleContext, ModuleInfo, ModuleManifest, ModuleOutcome, Modules, Proposal, TurnEvent, WorldState,
} from "../../../packages/shared/src/contract/types.ts";
import coreModule from "../../../content/modules/core/module.ts";
import introduceModule from "../../../content/modules/introduce/module.ts";
import mapModule from "../../../content/modules/map/module.ts";
import tradeModule from "../../../content/modules/trade/module.ts";
import { makeCtx, makeRegistry, makeRoom, SELF_ID } from "../../../packages/testkit/src/index.ts";
import { buildGalleryView } from "./gallery.ts";

const MODULES_DIR = path.join(process.cwd(), "content/modules");

function entity(id: string, kind: Entity["kind"], name: string, attrs: Entity["attrs"] = {}): Entity {
  return { id, kind, name, attrs, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 };
}

/** 带地点/在场 NPC 的最小世界，供 intent/tool 直接调用（不依赖 HTTP） */
function gameplayState(): WorldState {
  const state = makeRoom();
  state.entities.loc_library = entity("loc_library", "loc", "图书馆");
  state.entities.loc_canteen = entity("loc_canteen", "loc", "食堂");
  state.entities[SELF_ID].attrs.money = 60;
  state.room.scene.locId = "loc_canteen";
  state.room.scene.presentIds = [SELF_ID, "npc_lin"];
  state.links = [
    { id: "l1", kind: "located_in", from: SELF_ID, to: "loc_canteen", createdAt: 0 },
    { id: "l2", kind: "located_in", from: "npc_lin", to: "loc_canteen", createdAt: 0 },
    { id: "l3", kind: "located_in", from: "loc_canteen", to: "loc_library", createdAt: 0 },
  ];
  return state;
}

async function assertProposals(outcome: ModuleOutcome | Promise<ModuleOutcome>, label: string): Promise<void> {
  const result = await outcome;
  expect(result.ok, label).toBe(true);
  for (const p of result.proposals) {
    expect(OP_NAMES, `${label}: ${p.op}`).toContain(p.op);
    expect(p.args).toBeTypeOf("object");
  }
}

/** 每回合产一条合法 x.* 提案，让 20 回合的 seq 连续增长并真实落盘 */
class TurnModules implements Modules {
  async load(): Promise<void> {}
  list(): ModuleInfo[] {
    return [];
  }
  get(): ModuleInfo | undefined {
    return undefined;
  }
  async dispatchIntent(ctx: ModuleContext): Promise<ModuleOutcome> {
    const proposals: Proposal[] = [{
      op: "attr.delta",
      args: { entityId: ctx.actorId, key: "x.acceptance_turns", delta: 1 },
      reason: "验收回合提案",
    }];
    return { ok: true, proposals };
  }
  async callTool(): Promise<ModuleOutcome> {
    return { ok: false, proposals: [] };
  }
  async tick(): Promise<Proposal[]> {
    return [];
  }
  context(): never[] {
    return [];
  }
  view(): null {
    return null;
  }
}

describe("#94 玩法模块完整性验收", () => {
  const ids = readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  it("每个模块目录的 manifest 字段齐全，意图/工具名都落在 <id>.<verb> 命名空间", () => {
    expect(ids).toEqual(expect.arrayContaining(["core", "introduce", "map", "trade"]));
    for (const id of ids) {
      const raw = readFileSync(path.join(MODULES_DIR, id, "manifest.json"), "utf8");
      const m = JSON.parse(raw) as ModuleManifest;
      expect(m.id, id).toBe(id);
      expect(m.apiVersion, id).toBe(3);
      expect(m.name, id).toBeTruthy();
      expect(m.priority, id).toBeTypeOf("number");
      const caps = m.capabilities ?? {};
      for (const name of [...(caps.intents ?? []), ...(caps.tools ?? [])]) {
        expect(name.startsWith(`${id}.`), `${id}: ${name}`).toBe(true);
      }
      for (const trigger of caps.triggers ?? []) {
        expect(["morning", "noon", "afternoon", "evening", "night"]).toContain(trigger);
      }
    }
  });

  it("宿主自动发现并加载全部模块，无 fault；声明的 intent/tool 都能分发且只产合法 Proposal", async () => {
    const host = new ModuleHost({ dir: MODULES_DIR });
    await host.load();
    for (const id of ids) {
      expect(host.get(id)?.loaded, id).toBe(true);
      expect(host.get(id)?.fault, id).toBeUndefined();
    }

    const state = gameplayState();
    const ctx = (input: string): ModuleContext => makeCtx({ state, input });

    // 各模块自己的 intent 处理函数（绕过优先级，逐个验收）
    await assertProposals(coreModule.intent?.(ctx("看看")) ?? { ok: false, proposals: [] }, "core.intent");
    await assertProposals(introduceModule.intent?.(ctx("我叫小明")) ?? { ok: false, proposals: [] }, "introduce.intent");
    await assertProposals(mapModule.intent?.(ctx("看看地图")) ?? { ok: false, proposals: [] }, "map.intent");
    await assertProposals(tradeModule.intent?.(ctx("这里有什么")) ?? { ok: false, proposals: [] }, "trade.intent");

    // 宿主分发：core 优先级最高，"去图书馆" 应路由到 core.move，产出 move.to
    const routed = await host.dispatchIntent(ctx("去图书馆"));
    await assertProposals(routed, "host.dispatchIntent");
    expect(routed.proposals[0]?.op).toBe("move.to");

    // 所有 manifest 声明的 tool 都可达；业务错误（E_REF_NOT_FOUND 等）可接受，
    // 但绝不能是「工具没登记」或「宿主隔离故障」。
    for (const id of ids) {
      const manifest = JSON.parse(readFileSync(path.join(MODULES_DIR, id, "manifest.json"), "utf8")) as ModuleManifest;
      for (const name of manifest.capabilities?.tools ?? []) {
        const out = await host.callTool(name, { locId: "loc_library", goodId: "coffee", count: 1 }, ctx(""));
        expect(["E_TOOL_NOT_FOUND", "E_MODULE_FAULT"], `${name} 必须可被分发`).not.toContain(out.error?.code ?? "");
      }
    }
  });
});

describe("#94 单房回合链验收", () => {
  it("连续 20 回合 accepted→commit、seq 递增 1，进程重启后日志完整重放", async () => {
    const dir = tempDir("galgame-accept-turns-");
    const opts = { worldId: "world_campus", locId: "loc_library" };
    const store = new FileStore(dir, opts);
    const registry = emptyRegistry();
    const arbiter = new DefaultArbiter({ store, registry });
    const modules = new TurnModules();
    const turn = new DefaultTurn({
      store, arbiter, registry, modules,
      llm: new MockLlm({ responses: [] }),
      memory: new InMemoryMemory(),
    });
    const roomId = "room_accept_94";
    const start = await store.load(roomId);
    // 播种玩家实体（createInitialState 是空世界），这条种子事件构成 seq 1
    await store.append(roomId, [{
      v: 1, id: "evt_accept_seed", roomId, seq: start + 1, ts: 1, actorId: "system",
      type: "entity.created", payload: { entity: entity(SELF_ID, "plr", "我") },
    }]);
    const seededSeq = start + 1;

    for (let i = 0; i < 20; i += 1) {
      const events: TurnEvent[] = [];
      for await (const ev of turn.run({
        roomId, actorId: SELF_ID, input: "看看", clientTurnId: `c94_${i}`, options: { skipLLM: true },
      })) events.push(ev);
      expect(events.map((e) => e.type), `第 ${i + 1} 回合`).toEqual(["turn.accepted", "turn.patch", "turn.commit"]);
      const commit = events.at(-1);
      // #76：每回合落库 attr.changed + turn.committed marker 共 2 条 Envelope，
      // marker 是同批最后一条，其 seq 即本回合 committedSeq；turn.commit.seq 与它相等。
      const commitSeq = seededSeq + 2 * (i + 1);
      expect(commit?.type === "turn.commit" ? commit.seq : -1, `第 ${i + 1} 回合 commit.seq`).toBe(commitSeq);
      expect(store.seq(roomId), `第 ${i + 1} 回合落库后最新 seq`).toBe(commitSeq);
      const marker = (await store.events(roomId, seededSeq + 2 * i + 2)).find((e) => e.type === "turn.committed");
      expect(marker?.seq, `第 ${i + 1} 回合 marker seq`).toBe(commitSeq);
      expect(parseCommitEvidence(marker!)?.committedSeq, `第 ${i + 1} 回合 marker committedSeq`).toBe(commitSeq);
    }

    const finalSeq = store.seq(roomId);
    const restarted = new FileStore(dir, opts);
    expect(await restarted.load(roomId)).toBe(finalSeq);
    expect(restarted.seq(roomId)).toBe(finalSeq);
    const log = await restarted.events(roomId, 1);
    expect(log).toHaveLength(finalSeq);
    expect(log.map((e) => e.seq)).toEqual(Array.from({ length: finalSeq }, (_, i) => i + 1));
    expect(log.filter((e) => e.type === "attr.changed")).toHaveLength(20);
    // #76：每个成功回合另有 1 条 turn.committed 证据标记，跨重启后必须能重建幂等键
    expect(log.filter((e) => e.type === "turn.committed")).toHaveLength(20);
    const replayed = await restarted.snapshot(roomId);
    expect(replayed.entities[SELF_ID]?.attrs["x.acceptance_turns"]).toBe(20);
  });
});

describe("#94 registry 驱动视图验收（I2）", () => {
  it("只在 registry 增加属性声明（不改引擎/前端），Gallery View 就多出该字段", async () => {
    const raw = JSON.parse(readFileSync(path.join(process.cwd(), "content/registry/attrs.json"), "utf8")) as { attrs: AttrDef[] };
    const probeKey = "acceptance_probe";
    const probe: AttrDef = {
      key: probeKey, type: "number", scope: ["npc"], min: 0, max: 10,
      default: 0, visibility: "public", display: { label: "验收探针" },
    };
    const state = makeRoom();
    state.entities.npc_lin.attrs.knows_name = true;
    state.entities.npc_lin.attrs[probeKey] = 7;

    const before = buildGalleryView({ roomId: state.room.id, state, registry: new JsonRegistry({ attrs: raw.attrs }), profiles: [] });
    const after = buildGalleryView({
      roomId: state.room.id, state,
      registry: new JsonRegistry({ attrs: [...raw.attrs, probe] }), profiles: [],
    });
    const statsOf = (view: ReturnType<typeof buildGalleryView>) =>
      view.npcs.find((n) => n.id === "npc_lin")?.stats ?? [];
    expect(statsOf(before).some((s) => s.key === probeKey)).toBe(false);
    expect(statsOf(after).some((s) => s.key === probeKey)).toBe(true);
    // 结构断言：读数视图带 display，不带原始 attrs 通道的精确数值字段
    const added = statsOf(after).find((s) => s.key === probeKey);
    expect(added?.display).toBeTruthy();
    expect(added).not.toHaveProperty("attrs");
  });
});
