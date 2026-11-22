/**
 * 持久化的两个硬约束（Issue #1 复审 BLOCKER-1 / MAJOR-1）：
 *  1. 写盘失败必须"内存不变 + 可重试"，不能出现客户端收到 error、服务端状态已改。
 *  2. 重启后第一回合不能假报 E_SEQ_GAP —— seq 必须取自载入后的日志，而不是懒加载前的 0。
 *
 * 这两个场景是真实故障（磁盘满、进程被 kill、容器重启），不是理论洁癖：
 * 前者会让"重试"变成重复执行，后者会让房间重启后再也进不去。
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AttrDef, Envelope, Proposal } from "../../shared/src/contract/types.ts";
import { DefaultArbiter } from "./arbiter.ts";
import { JsonRegistry } from "./registry.ts";
import { FileStore } from "./store.ts";

const ROOM = "room_durable";
const PLR = "plr_me";
const SHOP = "loc_shop";

const ATTRS: AttrDef[] = [
  { key: "money", type: "number", scope: ["plr"], min: 0, max: 10_000, default: 60, visibility: "public", display: { label: "钱" } },
  { key: "stamina", type: "number", scope: ["plr"], min: 0, max: 100, default: 60, visibility: "public", display: { label: "体力" } },
];

const ENTITY = {
  id: PLR,
  kind: "plr" as const,
  name: "我",
  attrs: { money: 60, stamina: 60 },
  tags: [],
  origin: "seed" as const,
  canon: true,
  status: "active" as const,
  createdAt: 0,
  updatedAt: 0,
};

function seedEnv(seq: number): Envelope {
  return {
    v: 1,
    id: `evt_seed_${seq}`,
    roomId: ROOM,
    seq,
    ts: seq,
    actorId: "system",
    type: "entity.created",
    payload: { entity: { ...ENTITY, id: seq === 1 ? SHOP : PLR, kind: seq === 1 ? "loc" : "plr", name: seq === 1 ? "小店" : "我" } },
  };
}

function cause(id = "evt_turn_1"): Envelope {
  return { v: 1, id, roomId: ROOM, seq: 0, ts: 1000, actorId: PLR, type: "turn.accepted", payload: {} };
}

const DEC: Proposal[] = [{ op: "attr.delta", args: { entityId: PLR, key: "stamina", delta: -5 }, reason: "跑步", by: "test" }];

function registry(): JsonRegistry {
  return new JsonRegistry({ attrs: ATTRS, events: [], intents: [], tools: [], ops: [] });
}

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "galgame-durable-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

it("同进程并发首次提交可创建新目录，同房间仍按序串行", async () => {
  const dir = path.join(await tempDir(), "data", "rooms");
  const other = "room_other";
  const store = new FileStore(dir);
  await Promise.all([
    store.append(ROOM, [seedEnv(1)]),
    store.append(ROOM, [seedEnv(2)]),
    store.append(other, [{ ...seedEnv(1), roomId: other }]),
  ]);
  const restored = new FileStore(dir);
  expect(await restored.load(ROOM)).toBe(2);
  expect(await restored.load(other)).toBe(1);
});

describe("BLOCKER-1：落盘失败 → 状态不变、可安全重试", () => {
  it("目录只读时 apply 返回 E_STORE_FAULT，内存与 seq 都不变；恢复后重试只生效一次", async () => {
    const dir = await tempDir();
    const seed = new FileStore(dir);
    await seed.append(ROOM, [seedEnv(1), seedEnv(2)]);

    // 让目录只读：读档仍可（load 成功），写盘失败（EACCES）—— 真实故障的最小复现，不用 mock fs
    await chmod(dir, 0o555);
    const store = new FileStore(dir);
    const arbiter = new DefaultArbiter({ store, registry: registry(), now: () => 1000 });
    const beforeSeq = await store.load(ROOM);
    expect(beforeSeq).toBe(2);

    const r = await arbiter.apply(ROOM, DEC, cause());
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("E_STORE_FAULT");
    expect(r.events).toHaveLength(0);
    // 内存与 seq 都没变：客户端收到 error 时服务端状态必须还是旧的，否则重试会重复执行
    expect(store.seq(ROOM)).toBe(2);
    expect((await store.snapshot(ROOM)).entities[PLR]?.attrs.stamina).toBe(60);

    await chmod(dir, 0o755);
    const ok = await arbiter.apply(ROOM, DEC, cause("evt_turn_retry"));
    expect(ok.ok).toBe(true);
    expect(store.seq(ROOM)).toBe(3);

    // 重启读档：只有一次成功提交，没有幽灵事件
    const restored = new FileStore(dir);
    expect(await restored.load(ROOM)).toBe(3);
    expect((await restored.snapshot(ROOM)).entities[PLR]?.attrs.stamina).toBe(55);
    const lines = (await readFile(path.join(dir, `${ROOM}.jsonl`), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
  });
});

describe("MAJOR-1：重启后 seq 必须来自载入后的日志", () => {
  it("新实例 load() 返回真实 seq（seq() 在载入前是 0，不能拿它做校验）", async () => {
    const dir = await tempDir();
    const a = new FileStore(dir);
    await a.append(ROOM, [seedEnv(1), seedEnv(2)]);

    const b = new FileStore(dir);
    expect(b.seq(ROOM)).toBe(0); // 未载入：这是内存视图的诚实值
    expect(await b.load(ROOM)).toBe(2); // 载入后才是真相
    expect(b.seq(ROOM)).toBe(2);
  });

  it("重启后第一回合带 expectedSeq 不会假报 E_SEQ_GAP", async () => {
    const dir = await tempDir();
    const a = new FileStore(dir);
    await a.append(ROOM, [seedEnv(1), seedEnv(2)]);

    const b = new FileStore(dir);
    const arbiter = new DefaultArbiter({ store: b, registry: registry(), now: () => 1000 });
    const r = await arbiter.apply(ROOM, DEC, cause("evt_after_restart"), { expectedSeq: 2 });

    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.seq).toBe(3);
  });
});

describe("日志断档", () => {
  it("拒绝读写断档房间，保留原文件的全部内容", async () => {
    const dir = await tempDir();
    const file = path.join(dir, `${ROOM}.jsonl`);
    const events = [seedEnv(1), seedEnv(3), seedEnv(4)];
    const original = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    await writeFile(file, original, "utf8");

    const store = new FileStore(dir);
    await expect(store.load(ROOM)).rejects.toMatchObject({ code: "E_STORE_FAULT" });
    await expect(store.append(ROOM, [seedEnv(2)])).rejects.toMatchObject({ code: "E_STORE_FAULT" });
    expect(store.seq(ROOM)).toBe(0);
    expect(await readFile(file, "utf8")).toBe(original);
  });
});
