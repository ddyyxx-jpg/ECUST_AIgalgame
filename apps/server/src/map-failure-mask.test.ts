/**
 * issue #58：地图 travel / tick 的失败响应（ok:false）出站脱敏。
 *
 * PR #55 只让成功响应走 maskTurnEvents，失败响应以"message 只含场景 id/名与错误码"
 * 为由漏过。一旦 message/details 里带未认识 NPC 真名就会泄露一级认识口径。这里用注入
 * 的假依赖造出"失败文本里真的有真名"的场景，断言两个端点响应 0 命中真名、已知 NPC
 * 名字原样保留，且错误码 / 场景 id 不被误伤。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@galgame/testkit";
import type {
  ApplyResult,
  Arbiter,
  Dialogue,
  Entity,
  LlmPort,
  Modules,
  Registry,
  Store,
  Turn,
  TurnEvent,
  ValidationResult,
  WorldState,
} from "../../../packages/shared/src/contract/types.ts";
import { MapService } from "./map.ts";

const ROOM = "room_fail_mask";
const UNKNOWN = "严守一";
const KNOWN = "林静";
const LOOK = "穿白衬衫的男生";
const SCENE_A = "loc_a";
const SCENE_B = "loc_b";

function mkEntity(id: string, kind: Entity["kind"], name: string, known: boolean): Entity {
  return {
    id,
    kind,
    name,
    attrs: kind === "npc" ? { knows_name: known } : {},
    tags: [],
    origin: "seed",
    canon: true,
    status: "active",
    createdAt: 0,
    updatedAt: 0,
  };
}

function state(): WorldState {
  return {
    schemaVersion: 2,
    room: {
      id: ROOM,
      mode: "solo",
      worldId: "w",
      members: [{ actorId: "plr_self", role: "player", joinedSeq: 1 }],
      scene: { locId: SCENE_A, presentIds: ["plr_self", "npc_unknown", "npc_known"] },
      createdAt: 0,
      lastActiveAt: 0,
    },
    entities: {
      loc_a: mkEntity(SCENE_A, "loc", "甲地", false),
      loc_b: mkEntity(SCENE_B, "loc", "乙地", false),
      plr_self: mkEntity("plr_self", "plr", "你", false),
      npc_unknown: mkEntity("npc_unknown", "npc", UNKNOWN, false),
      npc_known: mkEntity("npc_known", "npc", KNOWN, true),
    },
    links: [
      { id: "l1", kind: "located_in", from: "plr_self", to: SCENE_B, createdAt: 0 },
      { id: "l2", kind: "located_in", from: "npc_unknown", to: SCENE_A, createdAt: 0 },
    ],
    clock: { day: 1, phase: "morning", tick: 0 },
    plots: [],
    moduleState: {},
  };
}

function worldMap(sceneBName = "乙地", sceneBStatus = "built") {
  return {
    schemaVersion: 1,
    worldId: "w",
    width: 600,
    height: 400,
    startLocId: SCENE_A,
    scenes: [
      { id: SCENE_A, name: "甲地", desc: "start", x: 10, y: 10, status: "built", links: [{ kind: "scene", id: SCENE_B }], dialogues: [] },
      { id: SCENE_B, name: sceneBName, desc: "target", x: 20, y: 20, status: sceneBStatus, links: [], dialogues: [] },
    ],
  };
}

function makeStore(s: WorldState): Store {
  return {
    snapshot: async () => s,
    events: async () => [],
    replay: async () => s,
    flush: async () => undefined,
  };
}

function makeTurn(events: TurnEvent[], thrown?: Error): Turn {
  return {
    run: async function* (): AsyncIterable<TurnEvent> {
      if (thrown) throw thrown;
      for (const e of events) yield e;
    },
  };
}

function makeArbiter(applyResult?: ApplyResult): Arbiter {
  return {
    apply: async (): Promise<ApplyResult> =>
      applyResult ?? { ok: true, mode: "atomic", seq: 1, applied: [], rejected: [], events: [] },
    dryRun: async (): Promise<ValidationResult> => ({ ok: true, rejected: [] }),
  };
}

async function setup(opts: {
  turnEvents?: TurnEvent[];
  turnThrow?: Error;
  applyResult?: ApplyResult;
  sceneBName?: string;
  sceneBStatus?: string;
} = {}) {
  const root = tempDir("galgame-map-fail-mask-");
  const contentDir = path.join(root, "content");
  const dataDir = path.join(root, "data");
  const mapFile = path.join(contentDir, "modules", "map", "data", "world_map.json");
  await mkdir(path.dirname(mapFile), { recursive: true });
  await writeFile(mapFile, JSON.stringify(worldMap(opts.sceneBName, opts.sceneBStatus)), "utf8");

  return {
    service: new MapService({
      store: makeStore(state()),
      turn: makeTurn(opts.turnEvents ?? [], opts.turnThrow),
      arbiter: makeArbiter(opts.applyResult),
      modules: { tick: async () => [{ op: "time.advance", args: { phase: "noon" } }] } as unknown as Modules,
      dialogue: {} as unknown as Dialogue,
      llm: {} as unknown as LlmPort,
      registry: {} as unknown as Registry,
      contentDir,
      dataDir,
      adminToken: "dev-admin",
      appearance: new Map([["npc_unknown", LOOK]]),
    }),
  };
}

describe("MapService · 失败响应出站脱敏（issue #58）", () => {
  it("travel：turn.error 失败 message 里的未认识真名 0 命中，已知名与错误码/场景 id 保留", async () => {
    const { service } = await setup({
      turnEvents: [
        {
          type: "turn.error",
          code: "E_MODULE_FAULT",
          message: `${UNKNOWN}拦住了你，进不去 ${SCENE_B}；${KNOWN}在旁边。`,
          retryable: false,
        },
      ],
    });
    const res = await service.travel(ROOM, "plr_self", SCENE_B);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("E_MODULE_FAULT"); // 错误码不被误伤
    expect(res.message).not.toContain(UNKNOWN);
    expect(res.message).toContain(LOOK); // 外貌占位
    expect(res.message).toContain(KNOWN); // knows_name=true → 原样保留
    expect(res.message).toContain(SCENE_B); // 场景 id 不被误伤
  });

  it("travel：早期失败（无 state，走 snapshot 回退分支）同样脱敏", async () => {
    // 场景名里嵌一个未认识真名，制造 E_FORBIDDEN 的失败 message；该返回点在快照之前，
    // 验证 outbound 在拿不到 state 时回退到 store.snapshot 仍能脱敏。
    const { service } = await setup({ sceneBName: `${UNKNOWN}的地盘`, sceneBStatus: "planned" });
    const res = await service.travel(ROOM, "plr_self", SCENE_B);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("E_FORBIDDEN");
    expect(res.message).not.toContain(UNKNOWN);
    expect(res.message).toContain(LOOK);
    expect(res.message).toContain("规划中，尚未建成");
  });

  it("travel：turn.run 抛错（catch 失败路径）时异常文本里的真名被遮", async () => {
    const { service } = await setup({ turnThrow: new Error(`${UNKNOWN}让路塌了，${KNOWN}没事`) });
    const res = await service.travel(ROOM, "plr_self", SCENE_B);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("E_MODULE_FAULT");
    expect(res.message).not.toContain(UNKNOWN);
    expect(res.message).toContain(LOOK);
    expect(res.message).toContain(KNOWN);
  });

  it("tick：apply rejected 的 detail 含未认识真名时同样脱敏", async () => {
    const { service } = await setup({
      applyResult: {
        ok: false,
        mode: "atomic",
        seq: 1,
        applied: [],
        rejected: [
          {
            proposal: { op: "time.advance", args: { phase: "noon" } },
            code: "E_MODULE_FAULT",
            detail: `${UNKNOWN}拦住了时段推进，${KNOWN}不受影响`,
          },
        ],
        events: [],
      },
    });
    const res = await service.tick(ROOM, { advance: false });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("E_MODULE_FAULT");
    expect(res.message).not.toContain(UNKNOWN);
    expect(res.message).toContain(LOOK);
    expect(res.message).toContain(KNOWN);
  });
});
