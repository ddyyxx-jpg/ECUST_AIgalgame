/**
 * issue #7：回合历史（TurnHistory + withTurnRecording + HTTP 读端点）。
 * 断言结构与游标，不断言叙事文案——文案由模型生成，不可断言。
 */
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { tempDir } from "@galgame/testkit";
import type { Store, Turn, TurnEvent } from "../../../packages/shared/src/index.ts";
import { createApp } from "./bootstrap.ts";
import type { ServerConfig } from "./config.ts";
import { registerRoutes } from "./routes.ts";
import { SaveIndex } from "./saves.ts";
import { TurnHistory, withTurnRecording } from "./turn-history.ts";

function testConfig(): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: tempDir("galgame-history-test-"),
    contentDir: "content",
    adminToken: "dev-admin",
    trustUserHeader: true,
    llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
    audit: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1000 },
  };
}

async function collect(iterable: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

/** 只有成员表可用于解析 userId 的最小 Store；历史层不碰状态本身 */
function fakeStore(members: { actorId: string; userId?: string }[]): Store {
  return {
    snapshot: async () => ({ room: { roomId: "room_x", members } }),
  } as unknown as Store;
}

describe("TurnHistory", () => {
  it("按 committedSeq 升序返回，坏行跳过，fromTurn/limit 分页正确", async () => {
    const dir = tempDir("galgame-history-unit-");
    const history = new TurnHistory(dir);
    for (const seq of [2, 1, 3]) {
      await history.append({
        formatVersion: 1,
        roomId: "room_x",
        turnId: `t${seq}`,
        committedSeq: seq,
        actorId: "plr_self",
        userId: "u_a",
        input: `in${seq}`,
        narrative: `n${seq}`,
        speakers: [],
        facts: [],
        createdAt: seq,
      });
    }
    // 半截行（进程崩溃残留）必须被跳过，而不是让整份历史不可读
    await (await import("node:fs/promises")).appendFile(history.fileFor("room_x"), '{"formatVersion":1,"roomId":', "utf8");

    const all = await history.readAll("room_x");
    expect(all.map((line) => line.committedSeq)).toEqual([1, 2, 3]);

    const page = await history.list("room_x", { limit: 2 });
    // 默认取最近片段（3.4.0 起）：长房间恢复展示最新对话而非序章
    expect(page.lines.map((line) => line.turnId)).toEqual(["t2", "t3"]);
    expect(page.lastCommittedSeq).toBe(3);
    expect(page.hasEarlier).toBe(true);

    const earlier = await history.list("room_x", { before: "2", limit: 2 });
    expect(earlier.lines.map((line) => line.turnId)).toEqual(["t1"]);
    expect(earlier.hasEarlier).toBe(false);

    const bySeq = await history.list("room_x", { fromTurn: "2" });
    expect(bySeq.lines.map((line) => line.turnId)).toEqual(["t3"]);

    const byTurn = await history.list("room_x", { fromTurn: "t1" });
    expect(byTurn.lines.map((line) => line.turnId)).toEqual(["t2", "t3"]);
  });

  it("同一 turnId 只记一次（seen 缓存重放不重复记账）", async () => {
    const dir = tempDir("galgame-history-dedupe-");
    const history = new TurnHistory(dir);
    const line = {
      formatVersion: 1 as const,
      roomId: "room_x",
      turnId: "t1",
      committedSeq: 1,
      actorId: "plr_self",
      input: "hi",
      narrative: "n",
      speakers: [],
      facts: [],
      createdAt: 1,
    };
    await history.append(line);
    await history.append({ ...line, narrative: "重放出来的另一份叙事" });
    expect(await history.readAll("room_x")).toHaveLength(1);
  });

  it("同 turnId 不同角色各自保留（去重作用域与引擎一致）", async () => {
    const dir = tempDir("galgame-history-actor-scope-");
    const history = new TurnHistory(dir);
    const base = {
      formatVersion: 1 as const,
      roomId: "room_x",
      turnId: "t_same",
      committedSeq: 1,
      input: "hi",
      narrative: "n",
      speakers: [],
      facts: [],
      createdAt: 1,
    };
    await history.append({ ...base, actorId: "plr_a" });
    await history.append({ ...base, actorId: "plr_b", committedSeq: 2 });
    const lines = await history.readAll("room_x");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.actorId).sort()).toEqual(["plr_a", "plr_b"]);
  });

  it("非法房间号不会穿越目录（落盘名走 hash 前缀）", () => {
    const history = new TurnHistory(tempDir("galgame-history-safe-"));
    expect(history.fileFor("room_abc-123")).toContain("room_abc-123.history.jsonl");
    expect(history.fileFor("../../etc/passwd")).toContain("x_");
  });
});

describe("withTurnRecording", () => {
  it("提交后写一行：叙事拼接、facts、committedSeq、userId 来自成员表", async () => {
    const history = new TurnHistory(tempDir("galgame-history-wrap-"));
    const saves = new SaveIndex(tempDir("galgame-history-wrap-saves-"));
    await saves.upsert("u_a", {
      roomId: "room_x",
      scenarioId: "transfer",
      createdAt: 1,
      updatedAt: 1,
      lastTurnId: "",
      lastCommittedSeq: 0,
      formatVersion: 1,
    });
    const inner: Turn = {
      async *run(): AsyncIterable<TurnEvent> {
        yield { type: "turn.accepted", turnId: "t1" };
        yield { type: "turn.delta", field: "narrative", text: "第一段" };
        yield { type: "turn.delta", field: "narrative", text: "第二段" };
        yield { type: "turn.facts", facts: ["你走到了一食堂"] };
        yield { type: "turn.commit", turnId: "t1", seq: 7 };
      },
    };
    const wrapped = withTurnRecording(inner, { history, saves, store: fakeStore([{ actorId: "plr_self", userId: "u_a" }]) });
    const events = await collect(wrapped.run({ roomId: "room_x", actorId: "plr_self", input: "去一食堂", clientTurnId: "c1" }));

    expect(events).toHaveLength(5);
    const lines = await history.readAll("room_x");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      formatVersion: 1,
      roomId: "room_x",
      turnId: "t1",
      committedSeq: 7,
      actorId: "plr_self",
      userId: "u_a",
      input: "去一食堂",
      narrative: "第一段\n第二段",
      speakers: [],
      facts: ["你走到了一食堂"],
    });
    const saved = await saves.list("u_a");
    expect(saved[0]?.lastTurnId).toBe("t1");
    expect(saved[0]?.lastCommittedSeq).toBe(7);
  });

  it("没有 turn.commit（失败/回滚的回合）不写历史", async () => {
    const history = new TurnHistory(tempDir("galgame-history-fail-"));
    const saves = new SaveIndex(tempDir("galgame-history-fail-saves-"));
    const inner: Turn = {
      async *run(): AsyncIterable<TurnEvent> {
        yield { type: "turn.accepted", turnId: "t1" };
        yield { type: "turn.delta", field: "narrative", text: "半截叙事" };
        yield { type: "turn.error", code: "E_MODULE_FAULT", message: "模块坏了", retryable: false };
      },
    };
    const wrapped = withTurnRecording(inner, { history, saves, store: fakeStore([]) });
    await collect(wrapped.run({ roomId: "room_x", actorId: "plr_self", input: "试试", clientTurnId: "c1" }));
    expect(await history.readAll("room_x")).toHaveLength(0);
  });

  it("消费者提前 break 也不会丢已提交回合（finally 记账）", async () => {
    const history = new TurnHistory(tempDir("galgame-history-break-"));
    const inner: Turn = {
      async *run(): AsyncIterable<TurnEvent> {
        yield { type: "turn.accepted", turnId: "t1" };
        yield { type: "turn.commit", turnId: "t1", seq: 3 };
        yield { type: "turn.facts", facts: ["不会被消费者读到"] };
      },
    };
    const wrapped = withTurnRecording(inner, {
      history,
      saves: new SaveIndex(tempDir("galgame-history-break-saves-")),
      store: fakeStore([{ actorId: "plr_self", userId: "u_a" }]),
    });
    for await (const event of wrapped.run({ roomId: "room_x", actorId: "plr_self", input: "hi", clientTurnId: "c1" })) {
      if (event.type === "turn.commit") break;
    }
    const lines = await history.readAll("room_x");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.committedSeq).toBe(3);
  });
});

describe("HTTP：/rooms/:roomId/history 与 /me/saves", () => {
  it("回合后历史可读，成员可读、非成员 403、世界房间 404", async () => {
    const deps = await createApp(testConfig());
    const { roomId, actorId } = await deps.createRoom("solo", "u_a");
    const events = await collect(deps.turn.run({ roomId, actorId, input: "你好", clientTurnId: "c1", userId: "u_a" }));
    const commit = events.at(-1);
    expect(commit?.type).toBe("turn.commit");
    const committedSeq = commit?.type === "turn.commit" ? commit.seq : -1;

    const app = Fastify();
    registerRoutes(app, deps);

    const mine = await app.inject({
      method: "GET",
      url: `/api/v1/rooms/${roomId}/history`,
      headers: { "x-user-id": "u_a" },
    });
    expect(mine.statusCode).toBe(200);
    const body = mine.json() as { ok: boolean; history: { input: string; committedSeq: number; userId?: string }[]; lastCommittedSeq: number };
    expect(body.ok).toBe(true);
    expect(body.history.at(-1)?.input).toBe("你好");
    expect(body.history.at(-1)?.committedSeq).toBe(committedSeq);
    expect(body.lastCommittedSeq).toBe(committedSeq);

    // 同 clientTurnId 重放（Turn 的幂等缓存）不能重复记历史
    await collect(deps.turn.run({ roomId, actorId, input: "你好", clientTurnId: "c1", userId: "u_a" }));
    const replayed = await app.inject({
      method: "GET",
      url: `/api/v1/rooms/${roomId}/history`,
      headers: { "x-user-id": "u_a" },
    });
    expect((replayed.json() as { history: unknown[] }).history).toHaveLength(1);

    const other = await app.inject({
      method: "GET",
      url: `/api/v1/rooms/${roomId}/history`,
      headers: { "x-user-id": "u_b" },
    });
    expect(other.statusCode).toBe(403);
    expect((other.json() as { code: string }).code).toBe("E_FORBIDDEN");

    const world = await app.inject({ method: "GET", url: `/api/v1/rooms/${deps.worldRoom}/history` });
    expect(world.statusCode).toBe(404);
    expect((world.json() as { code: string }).code).toBe("E_ROOM_NOT_FOUND");
    await app.close();
  });

  it("建房即登记索引（带 scenarioId），回合推进游标；DELETE 只删索引不删房间", async () => {
    const deps = await createApp(testConfig());
    const app = Fastify();
    registerRoutes(app, deps);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      headers: { "x-user-id": "u_a" },
      payload: { mode: "solo", scenarioId: "scholarship" },
    });
    expect(created.statusCode).toBe(200);
    const createdBody = created.json() as { roomId: string; actorId: string };
    const { roomId, actorId } = createdBody;
    expect(actorId).toMatch(/^plr_[0-9a-f]{8}$/);
    expect(actorId).not.toBe("plr_self");

    const initial = await app.inject({ method: "GET", url: "/api/v1/me/saves", headers: { "x-user-id": "u_a" } });
    const initialBody = initial.json() as { saves: { roomId: string; scenarioId: string; lastCommittedSeq: number; actorId?: string }[] };
    expect(initialBody.saves).toHaveLength(1);
    expect(initialBody.saves[0]?.scenarioId).toBe("scholarship");
    expect(initialBody.saves[0]?.actorId).toBe(actorId);

    const events = await collect(deps.turn.run({ roomId, actorId, input: "你好", clientTurnId: "c1", userId: "u_a" }));
    const commit = events.at(-1);
    const committedSeq = commit?.type === "turn.commit" ? commit.seq : -1;

    const after = await app.inject({ method: "GET", url: "/api/v1/me/saves", headers: { "x-user-id": "u_a" } });
    const afterBody = after.json() as { saves: { lastCommittedSeq: number; lastTurnId: string }[] };
    expect(afterBody.saves[0]?.lastCommittedSeq).toBe(committedSeq);
    expect(afterBody.saves[0]?.lastTurnId).not.toBe("");

    // 另一个账号看不到这条
    const other = await app.inject({ method: "GET", url: "/api/v1/me/saves", headers: { "x-user-id": "u_b" } });
    expect((other.json() as { saves: unknown[] }).saves).toHaveLength(0);

    const removed = await app.inject({ method: "DELETE", url: `/api/v1/me/saves/${roomId}`, headers: { "x-user-id": "u_a" } });
    expect((removed.json() as { removed: boolean }).removed).toBe(true);
    const state = await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/state`, headers: { "x-user-id": "u_a" } });
    expect(state.statusCode).toBe(200);
    // 历史也还在（删除只针对索引）
    const history = await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/history`, headers: { "x-user-id": "u_a" } });
    expect((history.json() as { history: unknown[] }).history).toHaveLength(1);
    await app.close();
  });

  it("没有身份时不返回/不登记存档（400 与空列表语义）", async () => {
    const deps = await createApp(testConfig());
    const app = Fastify();
    registerRoutes(app, deps);
    const res = await app.inject({ method: "GET", url: "/api/v1/me/saves" });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("E_SCHEMA_INVALID");
    await app.close();
  });
});
