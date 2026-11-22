import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { expect, it, vi } from "vitest";
import { tempDir } from "@galgame/testkit";
import { createApp } from "./bootstrap.ts";
import { registerRoutes } from "./routes.ts";
import { GossipHost } from "../../../packages/engine/src/v2/index.ts";

const fault = vi.hoisted(() => ({
  directory: "",
  phase: "" as "" | "temporary" | "directory",
  synced: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      const [file, , options] = args;
      if (fault.phase === "temporary" && typeof file === "string" && path.dirname(file) === fault.directory) {
        expect(options).toMatchObject({ flush: true });
        fault.phase = "";
        throw new Error("simulated temporary file sync failure");
      }
      return fs.writeFile(...args);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (args[1] === "r" && typeof args[0] === "string") {
        const directory = args[0];
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          fault.synced.push(directory);
          if (directory === fault.directory && fault.phase === "directory") {
            fault.phase = "";
            throw new Error("simulated directory sync failure");
          }
          await sync();
        });
      }
      return handle;
    },
  };
});

const config = (dataDir: string) => ({
  port: 0, host: "127.0.0.1", dataDir, contentDir: "content", adminToken: "test-admin",
  trustUserHeader: true, inviteCode: "test-invite",
  llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
  audit: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1000 },
});

it("先持久化新数据根目录的目录项，再处理注册和首次建房", async () => {
  const root = tempDir("galgame-fresh-data-");
  const nested = path.join(root, "nested");
  const dataDir = path.join(nested, "data");
  fault.synced.length = 0;

  const deps = await createApp(config(dataDir));
  expect(fault.synced.slice(-2)).toEqual([root, nested]);
  const account = await deps.auth.register({
    username: "durable_user", password: "password-for-local-test", inviteCode: "test-invite",
  }, "127.0.0.1");
  expect(account.ok).toBe(true);
  await deps.createRoom("solo");
  expect(fault.synced).toContain(dataDir);
  expect(fault.synced).toContain(path.join(dataDir, "rooms"));
});

it("初始化同步失败后，重试会补做父目录同步", async () => {
  const root = tempDir("galgame-data-retry-");
  const nested = path.join(root, "nested");
  const dataDir = path.join(nested, "data");
  fault.directory = root;
  fault.phase = "directory";
  try {
    await expect(createApp(config(dataDir))).rejects.toThrow("simulated directory sync failure");
    await expect(stat(dataDir)).rejects.toMatchObject({ code: "ENOENT" });
    fault.synced.length = 0;
    await createApp(config(dataDir));
    expect(fault.synced).toEqual([root, nested]);
  } finally {
    fault.directory = "";
    fault.phase = "";
  }
});

it.skipIf(process.getuid?.() === 0)("既存数据目录的父目录仅可穿越时，服务仍能写入", async () => {
  const root = tempDir("galgame-provisioned-parent-");
  const parent = path.join(root, "search-only");
  const dataDir = path.join(parent, "data");
  await mkdir(dataDir, { recursive: true });
  await chmod(parent, 0o111);
  try {
    const deps = await createApp(config(dataDir));
    const { roomId } = await deps.createRoom("solo");
    expect((await deps.store.events(roomId, 1)).length).toBeGreaterThan(0);
  } finally {
    await chmod(parent, 0o700);
  }
});

it("区分替换前和替换后故障，只冻结结果待核对的房间", async () => {
  const dataDir = tempDir("galgame-save-sync-");
  const deps = await createApp(config(dataDir));
  const app = Fastify();
  registerRoutes(app, deps);
  try {
    const userId = "u_sync";
    const otherUser = "u_other";
    const { roomId, actorId } = await deps.createRoom("solo", userId);
    const healthy = await deps.createRoom("solo", otherUser);
    const headers = { "x-user-id": userId };
    const url = `/api/v1/rooms/${roomId}/turns`;
    const clientTurnId = "test_sync";
    const submit = () => app.inject({
      method: "POST", url, headers,
      payload: { clientTurnId, actorId, input: "我去图书馆看看" },
    });
    fault.directory = path.join(dataDir, "rooms");
    const file = path.join(fault.directory, `${roomId}.jsonl`);
    const original = await readFile(file, "utf8");

    fault.phase = "temporary";
    const failedWrite = await submit();
    expect(failedWrite.body).toContain('"code":"E_STORE_FAULT"');
    expect(failedWrite.body).toContain('"retryable":true');
    expect(await readFile(file, "utf8")).toBe(original);
    expect(deps.ledger?.get({ userId, roomId, clientTurnId })?.state).toBe("failed");

    fault.phase = "directory";
    const unknown = await submit();
    expect(unknown.body).toContain('"code":"E_STORE_FAULT"');
    expect(unknown.body).toContain('"retryable":false');
    expect(unknown.body).not.toContain("turn.commit");
    expect(deps.ledger?.get({ userId, roomId, clientTurnId })?.state).toBe("unconfirmed");
    expect((await readFile(file, "utf8")).startsWith(original)).toBe(true);
    expect(await readFile(file, "utf8")).not.toBe(original);
    expect((await submit()).statusCode).toBe(503);

    const ok = await app.inject({
      method: "POST", url: `/api/v1/rooms/${healthy.roomId}/turns`, headers: { "x-user-id": otherUser },
      payload: { clientTurnId, actorId: healthy.actorId, input: "我去图书馆看看" },
    });
    expect(ok.body).toContain("turn.commit");
  } finally {
    fault.directory = "";
    fault.phase = "";
    await deps.ledger?.flush();
    await app.close();
  }
});


function pause() {
  let arrived!: () => void;
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => { arrived = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  return { arrived, resume, paused, gate };
}

async function createPlayerRoom(app: FastifyInstance, userId: string) {
  const headers = { "x-user-id": userId };
  const response = await app.inject({ method: "POST", url: "/api/v1/rooms", headers, payload: { mode: "solo" } });
  expect(response.statusCode).toBe(200);
  return response.json() as { roomId: string; actorId: string };
}

it.each([
  { pauseAt: "turn.delta", successorSucceeds: false },
  { pauseAt: "turn.patch", successorSucceeds: false },
  { pauseAt: "turn.patch", successorSucceeds: true },
])("先前已落盘的回合按自身序号确认（$pauseAt，后续提交成功=$successorSucceeds）", async ({ pauseAt, successorSucceeds }) => {
  const dataDir = tempDir("galgame-save-concurrent-");
  const deps = await createApp(config(dataDir));
  const app = Fastify();
  registerRoutes(app, deps);
  const userId = "u_concurrent";
  const headers = { "x-user-id": userId };
  const { roomId, actorId } = await createPlayerRoom(app, userId);
  const clientTurnId = "turn_a";
  const { arrived, resume, paused, gate } = pause();
  const run = deps.turn.run.bind(deps.turn);
  vi.spyOn(deps.turn, "run").mockImplementation(async function* (req) {
    for await (const event of run(req)) {
      if (req.clientTurnId === clientTurnId && event.type === pauseAt) {
        arrived();
        await gate;
      }
      yield event;
    }
  });

  try {
    const pending = app.inject({
      method: "POST", url: `/api/v1/rooms/${roomId}/turns`, headers,
      payload: { clientTurnId, actorId, input: "我去图书馆看看" },
    });
    await Promise.race([paused, pending.then(() => { throw new Error("turn finished before pause point"); })]);
    const sequence = (await deps.store.events(roomId, 1)).at(-1)!.seq;
    let lastCommittedSeq = sequence;
    if (successorSucceeds) {
      expect(await deps.map.travel(roomId, actorId, "loc_teaching_1")).toMatchObject({ ok: true });
      lastCommittedSeq = (await deps.store.events(roomId, 1)).at(-1)!.seq;
      expect(lastCommittedSeq).toBeGreaterThan(sequence);
    } else {
      fault.directory = path.join(dataDir, "rooms");
      fault.phase = "directory";
      expect(await deps.map.tick(roomId, { advance: true })).toMatchObject({ ok: false, code: "E_STORE_FAULT" });
    }
    resume();

    const response = await pending;
    expect(response.body).toContain("turn.commit");
    expect(response.body).not.toContain("turn.error");
    expect(deps.ledger.get({ userId, roomId, clientTurnId })).toMatchObject({ state: "committed", committedSeq: sequence });
    const history = await deps.history.readAll(roomId);
    expect(history[0]).toMatchObject({ committedSeq: sequence, clientTurnId });
    expect(history.at(-1)?.committedSeq).toBe(lastCommittedSeq);
    expect(await deps.saves.list(userId)).toMatchObject([{
      lastCommittedSeq, lastTurnId: history.at(-1)?.turnId,
    }]);
  } finally {
    resume();
    fault.directory = "";
    fault.phase = "";
    await deps.ledger.flush();
    await app.close();
  }
});

it("已提交的地图移动在房间随后冻结时仍更新所属账号的历史和存档", async () => {
  const dataDir = tempDir("galgame-save-travel-");
  const deps = await createApp(config(dataDir));
  const app = Fastify();
  registerRoutes(app, deps);
  const userId = "u_travel";
  const { roomId, actorId } = await createPlayerRoom(app, userId);
  const { arrived, resume, paused, gate } = pause();
  const run = deps.turn.run.bind(deps.turn);
  vi.spyOn(deps.turn, "run").mockImplementation(async function* (req) {
    for await (const event of run(req)) {
      if (event.type === "turn.patch") {
        arrived();
        await gate;
      }
      yield event;
    }
  });
  try {
    const travel = deps.map.travel(roomId, actorId, "loc_teaching_1");
    await Promise.race([paused, travel.then(() => { throw new Error("travel finished before pause point"); })]);
    const sequence = (await deps.store.events(roomId, 1)).at(-1)!.seq;
    fault.directory = path.join(dataDir, "rooms");
    fault.phase = "directory";
    expect(await deps.map.tick(roomId, { advance: true })).toMatchObject({ ok: false, code: "E_STORE_FAULT" });
    resume();

    expect(await travel).toMatchObject({ ok: true, map: { player: { locId: "loc_teaching_1" } } });
    expect(await deps.history.readAll(roomId)).toMatchObject([{ userId, committedSeq: sequence }]);
    expect(await deps.saves.list(userId)).toMatchObject([{ roomId, lastCommittedSeq: sequence }]);
  } finally {
    resume();
    fault.directory = "";
    fault.phase = "";
    await app.close();
  }
});

it("未写入的另一个请求遇到冻结房间时释放自身额度", async () => {
  const dataDir = tempDir("galgame-save-blocked-turn-");
  const deps = await createApp(config(dataDir));
  const app = Fastify();
  registerRoutes(app, deps);
  const userId = "u_blocked";
  const { roomId, actorId } = await createPlayerRoom(app, userId);
  const clientTurnId = "turn_not_started";
  const scope = { userId, roomId, clientTurnId };
  const { arrived, resume, paused, gate } = pause();
  const transition = deps.ledger.transitionDurable.bind(deps.ledger);
  vi.spyOn(deps.ledger, "transitionDurable").mockImplementation(async (...args) => {
    const result = await transition(...args);
    if (args[0].clientTurnId === clientTurnId && args[1] === "running") {
      arrived();
      await gate;
    }
    return result;
  });
  const run = vi.spyOn(deps.turn, "run");
  try {
    const pending = app.inject({
      method: "POST", url: `/api/v1/rooms/${roomId}/turns`, headers: { "x-user-id": userId },
      payload: { clientTurnId, actorId, input: "我去图书馆看看" },
    });
    await Promise.race([paused, pending.then(() => { throw new Error("turn finished before quota pause"); })]);
    fault.directory = path.join(dataDir, "rooms");
    fault.phase = "directory";
    expect(await deps.map.tick(roomId, { advance: true })).toMatchObject({ ok: false, code: "E_STORE_FAULT" });
    resume();

    const response = await pending;
    expect(response.body).toContain('"code":"E_STORE_FAULT"');
    expect(response.body).toContain('"retryable":false');
    expect(run).not.toHaveBeenCalled();
    expect(deps.ledger.get(scope)?.state).toBe("failed");
    expect(deps.ledger.todayTurns(userId)).toBe(0);
    expect(await deps.history.readAll(roomId)).toEqual([]);
  } finally {
    resume();
    fault.directory = "";
    fault.phase = "";
    await deps.ledger.flush();
    await app.close();
  }
});

it("故障房间不会中断永久记忆和私信的后台扫描", async () => {
  const dataDir = tempDir("galgame-save-background-");
  const interval = globalThis.setInterval;
  const callbacks = new Map<number, () => void>();
  const spy = vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, delay: number) => {
    callbacks.set(delay, fn);
    const timer = interval(fn, delay);
    clearInterval(timer);
    return timer;
  }) as typeof setInterval);
  vi.stubEnv("GALGAME_GOSSIP_SCAN_MS", "200");
  const deps = await createApp({
    ...config(dataDir),
    canonize: { enabled: true, baseUrl: "", model: "", apiKey: "", timeoutMs: 1, dailyCap: 1, scanMinutes: 1 },
  }).finally(() => {
    spy.mockRestore();
    vi.unstubAllEnvs();
  });
  const a = await deps.createRoom("solo");
  const b = await deps.createRoom("solo");
  const [faulty, healthy] = [a.roomId, b.roomId].sort() as [string, string];
  fault.directory = path.join(dataDir, "rooms");
  fault.phase = "directory";
  const canonize = vi.spyOn(deps.canonize, "retireRoom");
  const gossip = vi.spyOn(GossipHost.prototype, "step");
  try {
    expect(await deps.map.tick(faulty, { advance: true })).toMatchObject({ ok: false, code: "E_STORE_FAULT" });
    callbacks.get(60_000)!();
    callbacks.get(200)!();
    await vi.waitFor(() => {
      expect(canonize.mock.calls).toEqual([[healthy]]);
      expect(gossip.mock.calls).toEqual([[healthy]]);
    });
  } finally {
    canonize.mockRestore();
    gossip.mockRestore();
    fault.directory = "";
    fault.phase = "";
  }
});
