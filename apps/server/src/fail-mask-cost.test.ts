/**
 * issue #62：travel 的早期失败（取快照之前）不能每次请求都回放整条事件日志。
 *
 * 旧实现里 E_SCENE_NOT_FOUND / 规划在建点 E_FORBIDDEN 走 `outbound(fail(...), roomId)`，
 * 无 state → `maskTurnEvents` 回退 `store.snapshot(roomId)`，FileStore 每次 ensure + replay
 * 整条日志（O(事件数)）。这里用带 snapshot 计数的假 Store 断言：同一房间连续早期失败只有
 * 第一次付快照代价，之后复用按房间缓存的轻量占位表。同时回归 #58 的失败脱敏语义。
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
  ValidationResult,
  WorldState,
} from "../../../packages/shared/src/contract/types.ts";
import { MapService } from "./map.ts";

const ROOM = "room_fail_mask_cost";
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

function worldMap(sceneBName: string, sceneBStatus: string) {
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

/** 假 Store：snapshot 计数，用来观察早期失败是否回放事件日志。 */
function makeCountingStore(s: WorldState, counter: { snapshots: number }): Store {
  return {
    snapshot: async () => {
      counter.snapshots += 1;
      return s;
    },
    events: async () => [],
    replay: async () => s,
    flush: async () => undefined,
  };
}

function makeArbiter(): Arbiter {
  return {
    apply: async (): Promise<ApplyResult> =>
      ({ ok: true, mode: "atomic", seq: 1, applied: [], rejected: [], events: [] }),
    dryRun: async (): Promise<ValidationResult> => ({ ok: true, rejected: [] }),
  };
}

async function setup(sceneBName = "乙地", sceneBStatus = "built") {
  const root = tempDir("galgame-fail-mask-cost-");
  const contentDir = path.join(root, "content");
  const dataDir = path.join(root, "data");
  const mapFile = path.join(contentDir, "modules", "map", "data", "world_map.json");
  await mkdir(path.dirname(mapFile), { recursive: true });
  await writeFile(mapFile, JSON.stringify(worldMap(sceneBName, sceneBStatus)), "utf8");

  const counter = { snapshots: 0 };
  return {
    counter,
    service: new MapService({
      store: makeCountingStore(state(), counter),
      turn: { run: async function* () {} } as unknown as Turn,
      arbiter: makeArbiter(),
      modules: { tick: async () => [] } as unknown as Modules,
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

describe("MapService · 早期失败脱敏成本（issue #62）", () => {
  it("连续两次 E_SCENE_NOT_FOUND 早期失败只有第一次触发 snapshot", async () => {
    const { service, counter } = await setup();
    const first = await service.travel(ROOM, "plr_self", "loc_missing");
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.code).toBe("E_SCENE_NOT_FOUND");
    expect(counter.snapshots).toBe(1); // 未命中缓存：回退一次快照

    const second = await service.travel(ROOM, "plr_self", "loc_missing");
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("E_SCENE_NOT_FOUND");
    expect(counter.snapshots).toBe(1); // 命中缓存：不再回放事件日志
  });

  it("连续两次规划点 E_FORBIDDEN 不重复 snapshot，且 #58 脱敏语义不回归", async () => {
    // 场景名里嵌未认识真名与已认识真名，验证早期失败 message 的脱敏口径
    const { service, counter } = await setup(`${UNKNOWN}和${KNOWN}的地盘`, "planned");
    const first = await service.travel(ROOM, "plr_self", SCENE_B);
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.code).toBe("E_FORBIDDEN");
    expect(first.message).not.toContain(UNKNOWN); // 未认识真名被遮
    expect(first.message).toContain(LOOK); // 外貌占位出现
    expect(first.message).toContain(KNOWN); // 已认识名保留
    expect(first.message).toContain("规划中，尚未建成"); // 错误文案完整
    expect(counter.snapshots).toBe(1);

    const second = await service.travel(ROOM, "plr_self", SCENE_B);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.message).not.toContain(UNKNOWN);
    expect(second.message).toContain(LOOK);
    expect(second.message).toContain(KNOWN);
    expect(counter.snapshots).toBe(1); // 第二次零快照
  });

  it("不同种类的早期失败共享同一房间缓存", async () => {
    const { service, counter } = await setup("乙地", "planned");
    const missing = await service.travel(ROOM, "plr_self", "loc_missing");
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe("E_SCENE_NOT_FOUND");
    expect(counter.snapshots).toBe(1);

    const forbidden = await service.travel(ROOM, "plr_self", SCENE_B);
    expect(forbidden.ok).toBe(false);
    if (forbidden.ok) return;
    expect(forbidden.code).toBe("E_FORBIDDEN");
    expect(counter.snapshots).toBe(1); // 第二种早期失败同样命中缓存
  });
});
