/**
 * issue #61：场景对话 `/map/dialogue` 的成功台词与失败文本出站脱敏。
 *
 * PR #52 确立一级认识口径（未认识 NPC 不下发真名）；#53/#58 已覆盖 travel / tick，
 * 但 openDialogue 直接回传 seed 台词、catch 直接回传 e.message，未认识真名可绕过口径。
 * 这里用注入的假 Dialogue 造出"台词/异常文本里真的有真名"的场景，断言成功响应 lines
 * 与失败响应 message 里未认识真名 0 命中、已认识名原样保留、错误码不被误伤。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@galgame/testkit";
import type {
  Dialogue,
  DialogueSession,
  DialogueSpec,
  DialogueStep,
  DialogueSummary,
  Entity,
  LlmPort,
  Modules,
  Registry,
  Store,
  Turn,
  WorldState,
} from "../../../packages/shared/src/contract/types.ts";
import { MapService } from "./map.ts";

const ROOM = "room_dialogue_mask";
const UNKNOWN = "严守一";
const KNOWN = "林静";
const LOOK = "穿白衬衫的男生";
const SCENE = "loc_a";
const DIALOGUE = "dlg_a";
const SESSION = "sess_a";

/** 台词种子：未认识真名出现两次，已认识真名出现一次 */
const SEED_LINES = [
  `${UNKNOWN}把借阅章按回印泥里，没有抬头。`,
  `${KNOWN}在旁边说：「${UNKNOWN}，你又走神了。」`,
];

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
      scene: { locId: SCENE, presentIds: ["plr_self", "npc_unknown", "npc_known"] },
      createdAt: 0,
      lastActiveAt: 0,
    },
    entities: {
      loc_a: mkEntity(SCENE, "loc", "甲地", false),
      plr_self: mkEntity("plr_self", "plr", "你", false),
      npc_unknown: mkEntity("npc_unknown", "npc", UNKNOWN, false),
      npc_known: mkEntity("npc_known", "npc", KNOWN, true),
    },
    links: [{ id: "l1", kind: "located_in", from: "npc_unknown", to: SCENE, createdAt: 0 }],
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
  startLocId: SCENE,
  scenes: [
    {
      id: SCENE,
      name: "甲地",
      desc: "start",
      x: 10,
      y: 10,
      // 场景种子台词里含未认识真名（issue #61 的原始泄露面）
      dialogues: [{ id: DIALOGUE, npcId: "npc_unknown", title: "低语", lines: SEED_LINES }],
    },
  ],
};

function makeStore(s: WorldState): Store {
  return {
    snapshot: async () => s,
    events: async () => [],
    replay: async () => s,
    flush: async () => undefined,
  };
}

/** 假 Dialogue：step 把 spec.seed.lines 逐行作为该 NPC 的 utterance 吐回，可注入抛错 */
function makeDialogue(thrown?: Error): Dialogue {
  let lines: string[] = [];
  let index = 0;
  return {
    open: async (spec: DialogueSpec): Promise<DialogueSession> => {
      lines = Array.isArray(spec.seed?.lines) ? (spec.seed.lines as string[]) : [];
      index = 0;
      return {
        id: SESSION,
        roomId: spec.roomId,
        participants: [...spec.participants],
        directorId: spec.directorId,
        turn: 0,
        maxTurns: spec.maxTurns ?? 0,
        status: "open",
        visibility: spec.visibility ?? "private",
        seed: spec.seed ?? {},
      };
    },
    step: async (sessionId: string): Promise<DialogueStep> => {
      if (thrown) throw thrown;
      const text = lines[index] ?? "";
      index += 1;
      return {
        sessionId,
        turn: index,
        utterances: [{ actorId: "npc_unknown", text }],
        proposals: [],
        done: index >= lines.length,
      };
    },
    interject: async (): Promise<DialogueStep> => {
      throw new Error("unused");
    },
    close: async (sessionId: string): Promise<DialogueSummary> => ({ sessionId, turn: index, proposals: [] }),
  };
}

async function setup(opts: { dialogueThrow?: Error } = {}) {
  const root = tempDir("galgame-map-dialogue-mask-");
  const contentDir = path.join(root, "content");
  const dataDir = path.join(root, "data");
  const mapFile = path.join(contentDir, "modules", "map", "data", "world_map.json");
  await mkdir(path.dirname(mapFile), { recursive: true });
  await writeFile(mapFile, JSON.stringify(WORLD_MAP), "utf8");

  return {
    service: new MapService({
      store: makeStore(state()),
      turn: {} as unknown as Turn,
      arbiter: {
        apply: async () => ({ ok: true, mode: "atomic", seq: 1, applied: [], rejected: [], events: [] }),
        dryRun: async () => ({ ok: true, rejected: [] }),
      },
      modules: {} as unknown as Modules,
      dialogue: makeDialogue(opts.dialogueThrow),
      llm: {} as unknown as LlmPort,
      registry: {} as unknown as Registry,
      contentDir,
      dataDir,
      adminToken: "dev-admin",
      appearance: new Map([["npc_unknown", LOOK]]),
    }),
  };
}

describe("MapService · 场景对话出站脱敏（issue #61）", () => {
  it("成功：seed 台词里未认识真名 0 命中，已认识名原样保留，NPC 名用外貌占位", async () => {
    const { service } = await setup();
    const res = await service.openDialogue(ROOM, "plr_self", SCENE, DIALOGUE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const lines = JSON.stringify(res.lines);
    expect(lines).not.toContain(UNKNOWN);
    expect(lines).toContain(LOOK); // 未认识 → 外貌占位
    expect(lines).toContain(KNOWN); // knows_name=true → 原样保留
    expect(res.lines).toHaveLength(SEED_LINES.length + 1); // 陌生人开场 + 台词
    expect(res.npc.id).toBe("npc_unknown");
    expect(res.npc.name).toBe(LOOK);
    expect(res.sessionId).toBe(SESSION);
  });

  it("失败：catch 的异常 message 里未认识真名 0 命中，错误码保留、已知名保留", async () => {
    const { service } = await setup({ dialogueThrow: new Error(`${UNKNOWN}拒绝开口，${KNOWN}在场`) });
    const res = await service.openDialogue(ROOM, "plr_self", SCENE, DIALOGUE);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("E_MODULE_FAULT"); // 错误码不被误伤
    expect(res.message).not.toContain(UNKNOWN);
    expect(res.message).toContain(LOOK);
    expect(res.message).toContain(KNOWN);
  });
});
