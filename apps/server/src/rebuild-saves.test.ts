/**
 * issue #122 / PR #123 返工：存档索引只读重建。
 *
 * 强制门禁（AGENTS.md §12）：fixture 不再手工编造事件类型。房间日志一律由真实
 * FileStore.append 写出，提交标记用引擎权威的 commitMarker 构造——真实引擎只落
 * `turn.committed`（commitMarker, packages/engine/src/arbiter.ts:203-215），
 * 旧测试手造 `turn.commit` 骗过了全部断言，却在真实数据上空转。
 * 断言只查结构/数值，不断言文案。
 */
import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileStore, TURN_COMMITTED_TYPE, commitMarker } from "@galgame/engine";
import type { Envelope } from "@galgame/shared";
import { tempDir } from "@galgame/testkit";
import { rebuildSavesIndex } from "./rebuild-saves.ts";
import { SaveIndex, saveFilePath } from "./saves.ts";

/** 用真实 FileStore.append 写房间日志：join 形状逐字对齐 apps/server/src/bootstrap.ts:554-562 */
async function writeRoom(rooms: string, opts: {
  roomId?: string;
  joinUserId?: string;
  joinActorId?: string;
  commits?: { seq: number; turnId: string }[];
  seed?: boolean;
}): Promise<void> {
  const roomId = opts.roomId ?? "room_a";
  const store = new FileStore(rooms);
  const actorId = opts.joinActorId ?? "plr_a";
  const events: Envelope[] = [];
  let seq = 1;
  if (opts.seed !== false) {
    events.push({
      v: 1, id: `evt_seed_${roomId}`, roomId, seq: seq++, ts: 1000, actorId: "system",
      type: "entity.created",
      payload: { entity: { id: "e1", kind: "plr", name: "你", attrs: {}, tags: [], origin: "seed", canon: false, status: "active", createdAt: 1000, updatedAt: 1000 } },
    });
  }
  const joinedSeq = seq;
  events.push({
    v: 1, id: `evt_join_${roomId}`, roomId, seq: seq++, ts: 1000, actorId: "system",
    type: "room.member.joined",
    payload: { member: { actorId, role: "player", joinedSeq, online: true, ...(opts.joinUserId ? { userId: opts.joinUserId } : {}) } },
  });
  for (const c of opts.commits ?? []) {
    // commitMarker 产出 payload（clientTurnId/turnId/actorId/committedSeq），
    // seq/roomId/ts 由 Arbiter 在 append 时补（packages/engine/src/arbiter.ts:199-210）
    const marker = commitMarker({ clientTurnId: `c_${roomId}_${c.seq}`, turnId: c.turnId, actorId, committedSeq: c.seq });
    events.push({ ...marker, roomId, seq: c.seq, ts: 2000 });
  }
  await store.append(roomId, events);
}

async function setup(): Promise<{ root: string; rooms: string; history: string; saves: string }> {
  const root = tempDir("galgame-rebuild-");
  const rooms = path.join(root, "rooms");
  const history = path.join(root, "history");
  const saves = path.join(root, "users");
  await mkdir(rooms, { recursive: true });
  await mkdir(history, { recursive: true });
  return { root, rooms, history, saves };
}

describe("rebuildSavesIndex (#122)", () => {
  it("真实 FileStore 日志（turn.committed）→ 按成员归属恢复游标，updatedAt 取历史", async () => {
    const { rooms, history, saves } = await setup();
    await writeRoom(rooms, {
      roomId: "room_a", joinUserId: "u_a", joinActorId: "plr_a",
      commits: [{ seq: 3, turnId: "t1" }, { seq: 4, turnId: "t2" }],
    });
    await writeRoom(rooms, {
      roomId: "room_b", joinUserId: "u_b", joinActorId: "plr_b",
      commits: [{ seq: 3, turnId: "t3" }],
    });

    // 反手校验 fixture 确实是引擎发射的类型与字段名（§12 门禁）
    const raw = (await readFile(path.join(rooms, "room_a.jsonl"), "utf8")).trim().split("\n")
      .map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> });
    expect(raw.map((e) => e.type)).toContain(TURN_COMMITTED_TYPE);
    expect(Object.keys(raw.find((e) => e.type === TURN_COMMITTED_TYPE)!.payload))
      .toEqual(expect.arrayContaining(["turnId", "committedSeq", "clientTurnId", "actorId"]));

    await writeFile(path.join(history, "room_a.history.jsonl"), [
      JSON.stringify({ formatVersion: 1, roomId: "room_a", turnId: "t2", committedSeq: 4, actorId: "plr_a", input: "", narrative: "", speakers: [], facts: [], createdAt: 321 }),
    ].join("\n") + "\n", "utf8");

    const report = await rebuildSavesIndex({ roomsDir: rooms, historyDir: history, savesDir: saves, write: true });
    expect(report.roomsScanned).toBe(2);
    expect(report.roomsSkipped).toBe(0);
    expect(report.rebuilt.size).toBe(2);
    const a = report.rebuilt.get("u_a")!;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ roomId: "room_a", lastTurnId: "t2", lastCommittedSeq: 4, updatedAt: 321, actorId: "plr_a", formatVersion: 1 });
    expect(report.rebuilt.get("u_b")![0]).toMatchObject({ roomId: "room_b", lastTurnId: "t3", lastCommittedSeq: 3 });
    const written = JSON.parse(await readFile(saveFilePath(saves, "u_a"), "utf8")) as { version: number; userId: string; saves: unknown[] };
    expect(written).toMatchObject({ version: 1, userId: "u_a" });
    expect(written.saves).toHaveLength(1);
  });

  it("不覆盖较新的已有条目；相同 seq 不刷新 updatedAt", async () => {
    const { rooms, history, saves } = await setup();
    await writeRoom(rooms, { joinUserId: "u_a", commits: [{ seq: 3, turnId: "t_old" }] });
    const existingFile = saveFilePath(saves, "u_a");
    await mkdir(path.dirname(existingFile), { recursive: true });
    await writeFile(existingFile, JSON.stringify({
      version: 1, userId: "u_a",
      saves: [{ roomId: "room_a", scenarioId: "transfer", createdAt: 10, updatedAt: 999, lastTurnId: "t_new", lastCommittedSeq: 9, actorId: "plr_a", formatVersion: 1 }],
    }), "utf8");
    const report = await rebuildSavesIndex({ roomsDir: rooms, historyDir: history, savesDir: saves, write: true });
    const entry = report.rebuilt.get("u_a")![0]!;
    expect(entry).toMatchObject({ lastCommittedSeq: 9, lastTurnId: "t_new", updatedAt: 999 });
    expect(report.written).toHaveLength(0);
    expect((await readFile(existingFile, "utf8"))).toContain("t_new");
  });

  it("无 commit 房间 / 无 userId 的老房间不生成条目；坏档房间跳过并告警", async () => {
    const { rooms, history, saves } = await setup();
    await writeRoom(rooms, { roomId: "no_commit", joinUserId: "u_a" });
    await writeRoom(rooms, { roomId: "legacy", commits: [{ seq: 3, turnId: "t1" }] });
    await writeFile(path.join(rooms, "broken.jsonl"), "not-json\n", "utf8");
    const warnings: string[] = [];
    const report = await rebuildSavesIndex({
      roomsDir: rooms, historyDir: history, savesDir: saves,
      warn: (m) => warnings.push(m),
    });
    expect(report.rebuilt.size).toBe(0);
    expect(report.roomsSkipped).toBe(3);
    expect(warnings.some((w) => w.includes("broken"))).toBe(true);
    expect(report.written).toHaveLength(0);
  });

  it("坏索引不阻断重建；写前留 .bak，tmp+rename 原子替换", async () => {
    const { rooms, history, saves } = await setup();
    await writeRoom(rooms, { joinUserId: "u_a", commits: [{ seq: 3, turnId: "t1" }] });
    const target = saveFilePath(saves, "u_a");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "{ broken json", "utf8");
    const warnings: string[] = [];
    const report = await rebuildSavesIndex({
      roomsDir: rooms, historyDir: history, savesDir: saves, write: true,
      warn: (m) => warnings.push(m),
    });
    expect(warnings.some((w) => w.includes("旧索引不可读"))).toBe(true);
    expect(report.written).toContain(target);
    expect(report.backups).toContain(`${target}.bak`);
    expect(await readFile(`${target}.bak`, "utf8")).toBe("{ broken json");
    const after = JSON.parse(await readFile(target, "utf8")) as { saves: unknown[] };
    expect(after.saves).toHaveLength(1);
  });

  it("P1-E：真实旧索引的命名槽 + 房间仍有新 commit → 重建后槽与 slotId 都保留", async () => {
    const { rooms, history, saves } = await setup();
    await writeRoom(rooms, { roomId: "room_a", joinUserId: "u_a", commits: [{ seq: 3, turnId: "t_new" }] });
    const index = new SaveIndex(saves, () => 1500);
    await index.upsert("u_a", {
      roomId: "room_a", scenarioId: "default", createdAt: 1000, updatedAt: 1500,
      lastTurnId: "t_old", lastCommittedSeq: 1, actorId: "plr_a", formatVersion: 1,
    });
    const slot = await index.putSlot("u_a", { slotId: "s_main", label: "主线", roomId: "room_a" });
    expect(slot).toMatchObject({ ok: true, value: { slotId: "s_main" } });

    const report = await rebuildSavesIndex({ roomsDir: rooms, historyDir: history, savesDir: saves, write: true });
    expect(report.rebuilt.get("u_a")![0]).toMatchObject({ lastCommittedSeq: 3, slotId: "s_main" });
    // 端到端消费：真实 SaveIndex.listSlots 读回，不是只看写出去的 JSON
    const restored = new SaveIndex(saves, () => 1500);
    expect(await restored.listSlots("u_a")).toMatchObject([{ slotId: "s_main", roomId: "room_a" }]);
    expect(await restored.list("u_a")).toMatchObject([{ roomId: "room_a", slotId: "s_main" }]);
  });

  it("P1-E：悬空槽（roomId 已不在索引）在重建时清掉", async () => {
    const { rooms, history, saves } = await setup();
    await writeRoom(rooms, { roomId: "room_a", joinUserId: "u_a", commits: [{ seq: 3, turnId: "t1" }] });
    const target = saveFilePath(saves, "u_a");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify({
      version: 1, userId: "u_a",
      saves: [{ roomId: "room_a", scenarioId: "default", createdAt: 1, updatedAt: 1, lastTurnId: "", lastCommittedSeq: 1, formatVersion: 1 }],
      slots: [
        { slotId: "s_alive", label: "在", roomId: "room_a", createdAt: 1, updatedAt: 1 },
        { slotId: "s_gone", label: "不在", roomId: "room_deleted", createdAt: 1, updatedAt: 1 },
      ],
    }), "utf8");
    await rebuildSavesIndex({ roomsDir: rooms, historyDir: history, savesDir: saves, write: true });
    const after = JSON.parse(await readFile(target, "utf8")) as { slots: { slotId: string }[] };
    expect(after.slots.map((s) => s.slotId)).toEqual(["s_alive"]);
  });
});
