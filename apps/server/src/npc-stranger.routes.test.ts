/**
 * 陌生人机制的集成测试（审阅 P0/P1 要求）：
 * - `/state`、`/history` 不得下发未认识 NPC 的真名；
 * - 未 commit 的回合不解锁；
 * - 目标不在场不解锁；
 * - 有目标 + 问名字 + commit 才解锁该目标。
 */
import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { TurnEvent, WorldState } from "../../../packages/shared/src/contract/types.ts";
import { registerRoutes } from "./routes.ts";
import { JsonRegistry } from "../../../packages/engine/src/registry.ts";

const ROOM = "room_stranger";
const PLR = "plr_me";
const LIN = "npc_lin";
const BAI = "npc_bai";

function entity(id: string, kind: "plr" | "npc", name: string, attrs: Record<string, unknown> = {}) {
  return { id, kind, name, attrs, tags: [], origin: "seed" as const, canon: true, status: "active" as const, createdAt: 0, updatedAt: 0 };
}

function stateWith(knownLin = false): WorldState {
  return {
    schemaVersion: 2,
    room: {
      id: ROOM,
      mode: "solo",
      worldId: "w",
      members: [{ actorId: PLR, role: "player", joinedSeq: 1 }],
      scene: { locId: "loc_lib", presentIds: [PLR, LIN] },
      createdAt: 1,
      lastActiveAt: 1,
    },
    entities: {
      loc_lib: entity("loc_lib", "plr", "图书馆"), // 只为占位：kind 用 plr 避免 gallery 干扰
      [PLR]: entity(PLR, "plr", "你"),
      [LIN]: entity(LIN, "npc", "林静", knownLin ? { knows_name: true } : {}),
      [BAI]: entity(BAI, "npc", "白晓通", {}),
    },
    links: [],
    clock: { day: 1, phase: "morning", tick: 0 },
    plots: [],
    moduleState: {},
  } as unknown as WorldState;
}

async function makeApp(opts: { state?: WorldState; events?: TurnEvent[]; learn?: (roomId: string, ids: string[]) => Promise<void> } = {}) {
  const state = opts.state ?? stateWith();
  const learn = opts.learn ?? vi.fn(async () => undefined);
  const app = Fastify();
  registerRoutes(app, {
    store: {
      snapshot: async () => state,
      listRooms: async () => [ROOM],
      events: async () => [],
    },
    turn: {
      run: async function* () {
        for (const ev of opts.events ?? []) yield ev;
      },
    },
    map: {},
    registry: new JsonRegistry({ attrs: [{ key: "stamina", type: "number", scope: ["npc"], min: 0, max: 100, default: 100, visibility: "public", display: { label: "体力" } }] as never }),
    settings: { view: () => ({ mode: "offline", baseUrl: "", model: "", persisted: false }), apply: async () => ({ ok: false }), clear: async () => undefined },
    scenarios: { openings: [], npcs: [] },
    appearance: new Map([[LIN, "坐在借还台后的女生"], [BAI, "抱着校刊的女生"]]),
    history: {
      list: async () => ({
        lines: [{ turnId: "t1", seq: 1, narrative: "林静把书按住，白晓通抬头看你。", facts: ["林静记住了你"], at: 1 }],
        lastCommittedSeq: 1,
      }),
    },
    saves: { upsert: async () => undefined, list: async () => [], remove: async () => false },
    createRoom: async () => ({ roomId: ROOM, actorId: PLR }),
    learnNpcNames: learn,
    version: "test",
  } as never);
  await app.ready();
  return { app, learn };
}

describe("陌生人机制：/state 与 /history 脱敏", () => {
  it("/state 不下发未认识 NPC 的真名（用外貌占位名）", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/v1/rooms/${ROOM}/state` });
    const text = res.body;
    expect(text).not.toContain("林静");
    expect(text).not.toContain("白晓通");
    expect(text).toContain("坐在借还台后的女生");
    await app.close();
  });

  it("已认识的人保留真名", async () => {
    const { app } = await makeApp({ state: stateWith(true) });
    const res = await app.inject({ method: "GET", url: `/api/v1/rooms/${ROOM}/state` });
    expect(res.body).toContain("林静");
    expect(res.body).not.toContain("白晓通");
    await app.close();
  });

  it("/history 回放按当前认识状态脱敏", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/v1/rooms/${ROOM}/history` });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("林静");
    expect(res.body).not.toContain("白晓通");
    expect(res.body).toContain("坐在借还台后的女生");
    await app.close();
  });
});

describe("陌生人机制：解锁条件", () => {
  const commit: TurnEvent[] = [
    { type: "turn.accepted", turnId: "t1" },
    { type: "turn.delta", field: "narrative", text: "林静：林静，安静的静。" },
    { type: "turn.commit", turnId: "t1", seq: 2 },
  ];

  it("commit + 目标在场 + 问名字 → 只解锁目标", async () => {
    const { app, learn } = await makeApp({ events: commit });
    await app.inject({ method: "POST", url: `/api/v1/rooms/${ROOM}/turns`, payload: { actorId: PLR, input: "你叫什么名字？", clientTurnId: "c1", targetNpcId: LIN } });
    expect(learn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(learn).mock.calls[0]?.[1]).toEqual([LIN]);
    await app.close();
  });

  it("回合失败（turn.error）不解锁", async () => {
    const { app, learn } = await makeApp({
      events: [
        { type: "turn.accepted", turnId: "t1" },
        { type: "turn.error", code: "E_UPSTREAM", message: "模型挂了", retryable: true } as TurnEvent,
      ],
    });
    await app.inject({ method: "POST", url: `/api/v1/rooms/${ROOM}/turns`, payload: { actorId: PLR, input: "你叫什么名字？", clientTurnId: "c1", targetNpcId: LIN } });
    expect(learn).not.toHaveBeenCalled();
    await app.close();
  });

  it("目标不在场（presentIds 里没有）不解锁", async () => {
    // 台词里没有自我介绍，只有普通寒暄：确保解锁判断不会因为"场内有别人报了名字"而误触发
    const { app, learn } = await makeApp({
      events: [
        { type: "turn.accepted", turnId: "t1" },
        { type: "turn.delta", field: "narrative", text: "林静：你好，小声一点。" },
        { type: "turn.commit", turnId: "t1", seq: 2 },
      ],
    });
    await app.inject({ method: "POST", url: `/api/v1/rooms/${ROOM}/turns`, payload: { actorId: PLR, input: "你叫什么名字？", clientTurnId: "c1", targetNpcId: BAI } });
    expect(learn).not.toHaveBeenCalled();
    await app.close();
  });

  it("有对话目标、对方自己报名字（玩家没问）→ 也解锁（回归：以前 target 存在就跳过台词判定）", async () => {
    const { app, learn } = await makeApp({
      events: [
        { type: "turn.accepted", turnId: "t1" },
        { type: "turn.delta", field: "narrative", text: "林静：林静，安静的静。你是新来的？" },
        { type: "turn.commit", turnId: "t1", seq: 2 },
      ],
    });
    await app.inject({ method: "POST", url: `/api/v1/rooms/${ROOM}/turns`, payload: { actorId: PLR, input: "你好", clientTurnId: "c1", targetNpcId: LIN } });
    expect(learn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(learn).mock.calls[0]?.[1]).toEqual([LIN]);
    await app.close();
  });

  it("有对话目标但台词没有自报姓名 → 不解锁", async () => {
    const { app, learn } = await makeApp({
      events: [
        { type: "turn.accepted", turnId: "t1" },
        { type: "turn.delta", field: "narrative", text: "林静：你好，小声一点，这边有人自习。" },
        { type: "turn.commit", turnId: "t1", seq: 2 },
      ],
    });
    await app.inject({ method: "POST", url: `/api/v1/rooms/${ROOM}/turns`, payload: { actorId: PLR, input: "你好", clientTurnId: "c1", targetNpcId: LIN } });
    expect(learn).not.toHaveBeenCalled();
    await app.close();
  });
});
