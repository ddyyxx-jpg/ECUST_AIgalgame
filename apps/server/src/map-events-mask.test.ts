/**
 * issue #53：地图 travel / tick 的出站脱敏。
 *
 * travel 的 turn.run 事件与 tick 的 arbiter.apply envelopes 原先原样下发，一旦事件里带
 * 未认识 NPC 真名（turn.delta / turn.facts / payload 文本）就会泄露。这里用注入的假依赖
 * 造出"事件里真的有真名"的场景，断言两个端点响应 0 命中真名、已知 NPC 名字原样保留。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@galgame/testkit";
import type {
  ApplyResult,
  Arbiter,
  Dialogue,
  Envelope,
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

const ROOM = "room_mask";
const UNKNOWN = "严守一";
const OTHER_UNKNOWN = "周明远";
const KNOWN = "林静";
const LOOK = "穿白衬衫的男生";

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
      scene: { locId: "loc_a", presentIds: ["plr_self", "npc_unknown", "npc_other", "npc_known"] },
      createdAt: 0,
      lastActiveAt: 0,
    },
    entities: {
      loc_a: mkEntity("loc_a", "loc", "甲地", false),
      loc_b: mkEntity("loc_b", "loc", "乙地", false),
      plr_self: mkEntity("plr_self", "plr", "你", false),
      npc_unknown: mkEntity("npc_unknown", "npc", UNKNOWN, false),
      npc_other: mkEntity("npc_other", "npc", OTHER_UNKNOWN, false),
      npc_known: mkEntity("npc_known", "npc", KNOWN, true),
    },
    links: [
      { id: "l1", kind: "located_in", from: "plr_self", to: "loc_b", createdAt: 0 },
      { id: "l2", kind: "located_in", from: "npc_unknown", to: "loc_a", createdAt: 0 },
    ],
    clock: { day: 1, phase: "morning", tick: 0 },
    plots: [],
    moduleState: {},
  };
}

const WORLD_MAP = {
  schemaVersion: 1,
  worldId: "w",
  width: 600,
  height: 400,
  startLocId: "loc_a",
  scenes: [
    { id: "loc_a", name: "甲地", desc: "start", x: 10, y: 10, links: [{ kind: "scene", id: "loc_b" }], dialogues: [] },
    {
      id: "loc_b",
      name: "乙地",
      desc: "target",
      x: 20,
      y: 20,
      links: [],
      dialogues: [{ id: "dlg_b", npcId: "npc_unknown", title: "低语", lines: [`${UNKNOWN}：此处风大。`] }],
    },
  ],
};

function env(type: string, payload: unknown, seq = 1): Envelope {
  return { v: 1, id: `evt_${type}_${seq}`, roomId: ROOM, seq, ts: 1, actorId: "system", type, payload };
}

function makeStore(s: WorldState): Store {
  return {
    snapshot: async () => s,
    events: async () => [],
    replay: async () => s,
    flush: async () => undefined,
  };
}

function makeTurn(events: TurnEvent[]): Turn {
  return {
    run: async function* (): AsyncIterable<TurnEvent> {
      for (const e of events) yield e;
    },
  };
}

function makeArbiter(events: Envelope[]): Arbiter {
  return {
    apply: async (): Promise<ApplyResult> => ({ ok: true, mode: "atomic", seq: 1, applied: [], rejected: [], events }),
    dryRun: async (): Promise<ValidationResult> => ({ ok: true, rejected: [] }),
  };
}

async function setup(opts: { turnEvents?: TurnEvent[]; applyEvents?: Envelope[]; appearance?: Map<string, string> } = {}) {
  const root = tempDir("galgame-map-mask-test-");
  const contentDir = path.join(root, "content");
  const dataDir = path.join(root, "data");
  const mapFile = path.join(contentDir, "modules", "map", "data", "world_map.json");
  await mkdir(path.dirname(mapFile), { recursive: true });
  await writeFile(mapFile, JSON.stringify(WORLD_MAP), "utf8");

  const s = state();
  return {
    service: new MapService({
      store: makeStore(s),
      turn: makeTurn(opts.turnEvents ?? []),
      arbiter: makeArbiter(opts.applyEvents ?? []),
      modules: { tick: async () => [] } as unknown as Modules,
      dialogue: {} as unknown as Dialogue,
      llm: {} as unknown as LlmPort,
      registry: {} as unknown as Registry,
      contentDir,
      dataDir,
      adminToken: "dev-admin",
      appearance: opts.appearance ?? new Map([["npc_unknown", LOOK]]),
    }),
  };
}

describe("MapService · 地图事件出站脱敏（issue #53）", () => {
  it("travel：turn.delta / turn.facts 里的未认识真名 0 命中，已知 NPC 名保留", async () => {
    const { service } = await setup({
      turnEvents: [
        { type: "turn.delta", field: "dialogue", text: `${UNKNOWN}：你好，我是新来的。${OTHER_UNKNOWN}在旁边点头。${KNOWN}也在。` },
        { type: "turn.facts", facts: [`【世界印象】${UNKNOWN}记住了你`] },
        { type: "turn.commit", turnId: "t1", seq: 1 },
      ],
    });
    const res = await service.travel(ROOM, "plr_self", "loc_b");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const dumped = JSON.stringify(res.events);
    expect(dumped).not.toContain(UNKNOWN);
    expect(dumped).not.toContain(OTHER_UNKNOWN);
    expect(dumped).toContain(KNOWN); // knows_name=true → 原样保留
    expect(dumped).toContain(LOOK); // 外貌占位
    expect(dumped).toContain("一位陌生的同学"); // 无外貌 → 序号占位
    // scene 详情里的台词文本同样走这层掩码
    expect(JSON.stringify(res.scene.dialogues)).not.toContain(UNKNOWN);
  });

  it("tick：apply envelopes 与 moved 摘要里的未认识真名 0 命中，已知 NPC 名保留", async () => {
    const { service } = await setup({
      applyEvents: [
        env("memory.write", { text: `${UNKNOWN}把你记在心里`, actorId: "npc_unknown" }),
        env("actor.moved", { actorId: "npc_unknown", from: "loc_a", to: "loc_b" }),
        env("narrative", { text: `${KNOWN}：你来了。` }),
      ],
    });
    const res = await service.tick(ROOM, { advance: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(JSON.stringify(res.events)).not.toContain(UNKNOWN);
    expect(JSON.stringify(res.events)).toContain(KNOWN);
    expect(res.moved).toEqual([{ actorId: "npc_unknown", name: LOOK, from: "loc_a", to: "loc_b" }]);
    expect(JSON.stringify(res)).not.toContain(UNKNOWN);
  });

  it("没有未认识 NPC 时，事件原样返回（不改结构、不误伤已知名字）", async () => {
    const turnEvents: TurnEvent[] = [
      { type: "turn.delta", field: "narrative", text: `${KNOWN}：欢迎。` },
      { type: "turn.commit", turnId: "t2", seq: 1 },
    ];
    const { service } = await setup({ turnEvents, appearance: new Map() });
    const res = await service.travel(ROOM, "plr_self", "loc_b");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.events).toEqual(turnEvents);
  });
});
