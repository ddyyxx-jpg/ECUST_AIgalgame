/** Store 的契约：日志是唯一真相，snapshot 只是缓存的投影。 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Envelope } from "../../shared/src/contract/types.ts";
import { applyEvent, createInitialState } from "./projection.ts";
import { DefaultArbiter } from "./arbiter.ts";
import { emptyRegistry } from "./registry.ts";
import { EventSourcedStore, FileStore, isSafeRoomId } from "./store.ts";

const ROOM = "room_test";

function env(seq: number, type: string, payload: unknown): Envelope {
  return { v: 1, id: `evt_${seq}`, roomId: ROOM, seq, ts: seq * 10, actorId: "plr_me", type, payload };
}

const npc = {
  id: "npc_lin",
  kind: "npc",
  name: "林月",
  attrs: { stamina: 80 },
  tags: [],
  origin: "seed",
  canon: true,
  status: "active",
  createdAt: 0,
  updatedAt: 0,
};

describe("EventSourcedStore", () => {
  it("空房间返回初始状态（校门 / 第 1 天上午）", async () => {
    const store = new EventSourcedStore();
    const s = await store.snapshot(ROOM);
    expect(s.schemaVersion).toBeGreaterThan(0);
    expect(s.room.scene.locId).toBe("loc_campus_gate");
    expect(s.clock).toEqual({ day: 1, phase: "morning", tick: 0 });
    expect(s.entities).toEqual({});
    expect(store.seq(ROOM)).toBe(0);
  });

  it("append 后 seq 单调、投影可见、事件可回读", async () => {
    const store = new EventSourcedStore();
    store.append(ROOM, [env(1, "entity.created", { entity: npc })]);
    store.append(ROOM, [env(2, "attr.changed", { entityId: "npc_lin", key: "stamina", from: 80, to: 65, clamped: false })]);
    expect(store.seq(ROOM)).toBe(2);
    expect(store.state(ROOM).entities.npc_lin?.attrs.stamina).toBe(65);
    const events = await store.events(ROOM, 2);
    expect(events.map((e) => e.seq)).toEqual([2]);
  });

  it("seq 断号直接报错（说明出现了第二个写入口）", () => {
    const store = new EventSourcedStore();
    store.append(ROOM, [env(1, "entity.created", { entity: npc })]);
    expect(() => store.append(ROOM, [env(3, "entity.created", { entity: { ...npc, id: "npc_2" } })])).toThrow(/E_SEQ_GAP/);
  });

  it("events(fromSeq, limit) 按 seq 切片", async () => {
    const store = new EventSourcedStore();
    store.append(ROOM, [
      env(1, "entity.created", { entity: npc }),
      env(2, "attr.changed", { entityId: "npc_lin", key: "stamina", from: 80, to: 79, clamped: false }),
      env(3, "attr.changed", { entityId: "npc_lin", key: "stamina", from: 79, to: 78, clamped: false }),
    ]);
    expect((await store.events(ROOM, 1, 2)).map((e) => e.seq)).toEqual([1, 2]);
    expect((await store.events(ROOM, 2)).map((e) => e.seq)).toEqual([2, 3]);
  });

  it("replay 与 snapshot 一致，toSeq 可以回到过去（determinism 的最小证据）", async () => {
    const store = new EventSourcedStore();
    store.append(ROOM, [
      env(1, "entity.created", { entity: npc }),
      env(2, "attr.changed", { entityId: "npc_lin", key: "stamina", from: 80, to: 70, clamped: false }),
    ]);
    expect(await store.replay(ROOM)).toEqual(await store.snapshot(ROOM));
    expect((await store.replay(ROOM, 1)).entities.npc_lin?.attrs.stamina).toBe(80);
  });

  it("snapshot 是副本：调用方改了它不会污染日志", async () => {
    const store = new EventSourcedStore();
    store.append(ROOM, [env(1, "entity.created", { entity: npc })]);
    const snap = await store.snapshot(ROOM);
    snap.entities.npc_lin!.name = "被改坏了";
    expect(store.state(ROOM).entities.npc_lin?.name).toBe("林月");
  });
});

describe("FileStore（jsonl 一房间一文件）", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function tempDir(): Promise<string> {
    const d = await mkdtemp(path.join(tmpdir(), "galgame-store-"));
    dirs.push(d);
    return d;
  }

  it("写盘后可被新实例回放成同一状态", async () => {
    const dir = await tempDir();
    const a = new FileStore(dir);
    await a.append(ROOM, [env(1, "entity.created", { entity: npc })]);
    await a.append(ROOM, [env(2, "attr.changed", { entityId: "npc_lin", key: "stamina", from: 80, to: 40, clamped: false })]);
    await a.flush();
    const file = await readFile(path.join(dir, `${ROOM}.jsonl`), "utf8");
    expect(file.trim().split("\n")).toHaveLength(2);

    const b = new FileStore(dir);
    expect((await b.snapshot(ROOM)).entities.npc_lin?.attrs.stamina).toBe(40);
    expect(await b.replay(ROOM)).toEqual(await a.replay(ROOM));
  });

  it("roomId 只接受安全字符：路径穿越 id 在进入文件路径前被拒", async () => {
    const dir = await tempDir();
    const store = new FileStore(dir);
    expect(isSafeRoomId(ROOM)).toBe(true);
    expect(isSafeRoomId("room_world_ecust")).toBe(true);
    expect(isSafeRoomId("../pwn")).toBe(false);
    expect(isSafeRoomId("..%2F..%2Fpwn")).toBe(false);
    await expect(store.append("../pwn", [env(1, "entity.created", { entity: npc })])).rejects.toMatchObject({ code: "E_SCHEMA_INVALID" });
  });

  it("半行或有效 JSON 的坏事件均拒绝载入并保留源文件", async () => {
    const dir = await tempDir();
    const file = path.join(dir, `${ROOM}.jsonl`);
    const good = JSON.stringify(env(1, "entity.created", { entity: npc }));
    const store = new FileStore(dir);
    for (const bad of ['{"v":1', JSON.stringify(env(2, "entity.created", {}))]) {
      const original = good + "\n" + bad;
      await writeFile(file, original);
      await expect(store.snapshot(ROOM)).rejects.toMatchObject({ code: "E_STORE_FAULT" });
      expect(await readFile(file, "utf8")).toBe(original);
    }
    await writeFile(file, good + "\n");
    expect((await store.snapshot(ROOM)).entities.npc_lin?.name).toBe("林月");
  });

  it("裁决生成的长关系 ID 及删除事件在重启后仍能回放", async () => {
    const dir = await tempDir();
    const store = new FileStore(dir);
    const arbiter = new DefaultArbiter({ store, registry: emptyRegistry() });
    const from = "npc_" + "a".repeat(48);
    const to = "npc_" + "b".repeat(48);
    const cause = env(1, "turn.input", {});
    const created = await arbiter.apply(ROOM, [
      { op: "entity.create", args: { id: from, kind: "npc", name: "A", tags: ["t".repeat(40)] } },
      { op: "entity.create", args: { id: to, kind: "npc", name: "B" } },
      { op: "link.create", args: { kind: "knows", from, to, audience: [""] } },
      { op: "plot.upsert", args: { goal: "g".repeat(130), actors: [from, to] } },
    ], cause);
    expect(created.ok).toBe(true);
    const state = await store.snapshot(ROOM);
    const linkId = state.links[0]!.id;
    expect(linkId.length).toBeGreaterThan(96);
    expect(state.links[0]?.audience).toEqual([""]);
    expect(await new FileStore(dir).snapshot(ROOM)).toEqual(state);

    const removed = await arbiter.apply(ROOM, [{ op: "link.remove", args: { linkId } }], cause);
    expect(removed.ok).toBe(true);
    expect((await new FileStore(dir).snapshot(ROOM)).links).toEqual([]);
  });

  it("v2 私信旧档（gossip 转发、message 自带 seq/visibility）可直接载入，无需迁移", async () => {
    const dir = await tempDir();
    const file = path.join(dir, `${ROOM}.jsonl`);
    // 0a862d9 首次引入 msg.sent 时的载荷形状：message.seq 与 visibility 都在，
    // 没有后续版本新增的顶层字段。严格校验不能把这种合法旧档判成坏档。
    const legacy = [
      env(1, "entity.created", { entity: npc }),
      {
        v: 1, id: "evt_2", roomId: ROOM, seq: 2, ts: 20, actorId: "npc_lin", type: "msg.sent",
        audience: ["npc_lin", "plr_me"],
        payload: {
          message: {
            id: `msg_${ROOM}_evt_1_1`, roomId: ROOM, from: "npc_lin", to: "plr_me",
            kind: "gossip", content: "旧档里的转发私信", hop: 1, confidence: 0.8,
            visibility: "private", createdAt: 5, seq: 1,
          },
        },
      },
    ];
    const original = legacy.map((event) => JSON.stringify(event)).join("\n") + "\n";
    await writeFile(file, original, "utf8");

    const store = new FileStore(dir);
    expect(await store.load(ROOM)).toBe(2);
    expect((await store.snapshot(ROOM)).entities.npc_lin?.name).toBe("林月");
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("replay 用的是同一套 applyEvent（与内存版逐字段相等）", () => {
    const state = applyEvent(createInitialState(ROOM), env(1, "entity.created", { entity: npc }));
    expect(state.entities.npc_lin?.status).toBe("active");
  });
});

describe("FileStore 读档失败不污染已载入标记（issue #7）", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function tempDir(): Promise<string> {
    const d = await mkdtemp(path.join(tmpdir(), "galgame-store-load-"));
    dirs.push(d);
    return d;
  }

  it.skipIf(process.getuid?.() === 0)("目录权限恢复后重新载入原日志，并接续写入", async () => {
    const dir = await tempDir();
    const seed = new FileStore(dir);
    await seed.append(ROOM, [env(1, "entity.created", { entity: npc })]);
    const store = new FileStore(dir);
    await chmod(dir, 0o000);
    try {
      await expect(store.load(ROOM)).rejects.toMatchObject({ code: "EACCES" });
      await expect(store.listRooms()).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(dir, 0o700);
    }

    expect(await store.load(ROOM)).toBe(1);
    await store.append(ROOM, [env(2, "attr.changed", { entityId: npc.id, key: "stamina", to: 40 })]);
    expect(await new FileStore(dir).events(ROOM, 1)).toMatchObject([{ seq: 1 }, { seq: 2 }]);
  });

  it("确实不存在的房间可以写入首批日志", async () => {
    const dir = await tempDir();
    const store = new FileStore(dir);
    expect(await store.load(ROOM)).toBe(0);
    await store.append(ROOM, [env(1, "entity.created", { entity: npc })]);
    expect(await new FileStore(dir).load(ROOM)).toBe(1);
  });

  it("readFile 第一次失败 → 未标记已载入；故障恢复后第二次 load 能读到真实日志", async () => {
    const dir = await tempDir();
    const file = path.join(dir, `${ROOM}.jsonl`);
    // 用同名目录占位：existsSync 为真、readFile 稳定抛 EISDIR。
    // 不依赖 root/权限，也不 mock fs —— 模拟的是"文件在、但这次读失败"（网络盘/占用/权限等）。
    await mkdir(file);

    const store = new FileStore(dir);
    await expect(store.load(ROOM)).rejects.toThrow(/EISDIR/);
    // 失败不能留下"已载入"幻觉：否则后续 append 会按 seq 0 续写，把真实日志覆盖掉
    expect(store.seq(ROOM)).toBe(0);

    // 故障恢复：占位目录换成合法日志，第二次 load 必须真正重读并恢复数据
    await rm(file, { recursive: true, force: true });
    const lines = [
      env(1, "entity.created", { entity: npc }),
      env(2, "attr.changed", { entityId: "npc_lin", key: "stamina", from: 80, to: 40, clamped: false }),
    ];
    await writeFile(file, lines.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    expect(await store.load(ROOM)).toBe(2);
    expect(store.seq(ROOM)).toBe(2);
    expect((await store.snapshot(ROOM)).entities.npc_lin?.attrs.stamina).toBe(40);
  });

  it("目录路径不可用（ENOTDIR）时 load 与 listRooms 都上抛，不当作空房间", async () => {
    const base = await tempDir();
    // 用普通文件占位目录路径：readFile("<file>/room.jsonl") 与 readdir("<file>") 都稳定抛 ENOTDIR。
    // 与 chmod 用例不同，这条不依赖"非 root"，CI 以 root 跑时仍能覆盖「非 ENOENT 必须上抛」的分支。
    const dir = path.join(base, "not-a-dir");
    await writeFile(dir, "not a directory", "utf8");

    const store = new FileStore(dir);
    await expect(store.load(ROOM)).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(store.listRooms()).rejects.toMatchObject({ code: "ENOTDIR" });
    // 读失败不能留下"已载入"幻觉：否则后续 append 会按 seq 0 续写并覆盖真实日志
    expect(store.seq(ROOM)).toBe(0);

    // 故障解除（换回真实目录）后可正常读写
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir);
    await store.append(ROOM, [env(1, "entity.created", { entity: npc })]);
    expect(await new FileStore(dir).listRooms()).toEqual([ROOM]);
  });
});
