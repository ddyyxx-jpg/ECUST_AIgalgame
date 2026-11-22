/**
 * issue #99：导出→导入→回放 round-trip，以及坏档 fail-closed / 冲突不覆盖。
 * 断言的是事件链、checksum 与投影结构（不是文案）；导入只经 EventLog.append 落库。
 */
import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileStore } from "@galgame/engine";
import type { Envelope } from "@galgame/shared";
import { tempDir } from "@galgame/testkit";
import {
  archiveChecksum, buildArchive, importArchive, inspectArchive, planImport,
  type SaveArchive,
} from "./save-archive.ts";

const ROOM = "room_archive";

/** 用真实投影会处理的事件类型造日志：建实体 → 改属性 → 回合提交（末条是未知类型，投影 no-op）。 */
function sampleEvents(roomId = ROOM): Envelope[] {
  const entity = {
    id: "plr_a", kind: "plr", name: "你", attrs: {}, tags: [],
    origin: "seed", canon: false, status: "active", createdAt: 1, updatedAt: 1,
  };
  return [
    { v: 1, id: "evt_1", roomId, seq: 1, ts: 1000, actorId: "system", type: "entity.created", payload: { entity } },
    { v: 1, id: "evt_2", roomId, seq: 2, ts: 1001, actorId: "plr_a", type: "attr.changed", payload: { entityId: "plr_a", key: "x.mood", from: 0, to: 5, clamped: false } },
    { v: 1, id: "evt_3", roomId, seq: 3, ts: 1002, actorId: "plr_a", type: "turn.commit", payload: { turnId: "t1", seq: 3 } },
  ];
}

function roomsDir(): string {
  return path.join(tempDir("galgame-archive-"), "rooms");
}

/** 改了事件后同步重算 checksum，才能测到 checksum 之后的校验分支。 */
function reseal(archive: SaveArchive): SaveArchive {
  archive.checksum = archiveChecksum(archive.events);
  archive.eventCount = archive.events.length;
  archive.seq = archive.events[archive.events.length - 1]!.seq;
  return archive;
}

describe("save-archive (#99)", () => {
  it("导出→换目录导入→回放：checksum 与投影一致", async () => {
    const events = sampleEvents();
    const source = new FileStore(roomsDir());
    await source.append(ROOM, events);
    const projection = await source.snapshot(ROOM);

    const archive = buildArchive({ roomId: ROOM, events, projection, savedAt: 12345 });
    const file = path.join(tempDir("galgame-archive-file-"), "archive.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(archive), "utf8");
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));

    const checked = inspectArchive(raw);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;

    const target = new FileStore(roomsDir());
    const result = await importArchive({ archive: checked.archive, events: checked.events, store: target });
    expect(result).toMatchObject({ ok: true, action: "create", appended: 3, seq: 3 });
    expect(await target.replay(ROOM)).toEqual(checked.projection);
    expect(await target.replay(ROOM)).toEqual(projection);
    expect(archiveChecksum(await target.events(ROOM, 1))).toBe(archive.checksum);
  });

  it("坏 checksum / 坏结构 / 未知版本 / 断链 / 投影不符一律拒绝，不落库", async () => {
    const events = sampleEvents();
    const good = buildArchive({ roomId: ROOM, events, savedAt: 1 });

    const tampered = structuredClone(good);
    (tampered.events[1]!.payload as Record<string, unknown>)["to"] = 999;
    expect(inspectArchive(tampered)).toMatchObject({ ok: false, code: "E_SCHEMA_INVALID", message: expect.stringContaining("checksum") });

    const badZod = structuredClone(good) as unknown as Record<string, unknown>;
    delete badZod["seq"];
    expect(inspectArchive(badZod).ok).toBe(false);

    const badFormat = structuredClone(good);
    badFormat.formatVersion = 2;
    expect(inspectArchive(badFormat)).toMatchObject({ ok: false, message: expect.stringContaining("归档版本") });

    const badSchema = structuredClone(good);
    badSchema.schemaVersion = 999;
    expect(inspectArchive(badSchema)).toMatchObject({ ok: false, message: expect.stringContaining("schemaVersion") });

    const badContract = structuredClone(good);
    badContract.contractVersion = "9.9.9";
    expect(inspectArchive(badContract)).toMatchObject({ ok: false, message: expect.stringContaining("契约版本") });

    const gap = structuredClone(good);
    gap.events.splice(1, 1);
    reseal(gap);
    expect(inspectArchive(gap)).toMatchObject({ ok: false, code: "E_SEQ_GAP" });

    const foreign = structuredClone(good);
    foreign.events[2]!.roomId = "room_other";
    reseal(foreign);
    expect(inspectArchive(foreign)).toMatchObject({ ok: false, code: "E_SCHEMA_INVALID" });

    const badProjection = structuredClone(good);
    (badProjection.projection as { room: { mode: string } }).room.mode = "multi";
    expect(inspectArchive(badProjection)).toMatchObject({ ok: false, code: "E_PRECONDITION" });

    // 坏档在 CLI 里根本进不了 importArchive；这里确认目标目录仍无房间文件
    const target = roomsDir();
    expect(inspectArchive(tampered).ok).toBe(false);
    const store = new FileStore(target);
    await store.load(ROOM);
    expect(await store.events(ROOM, 1)).toHaveLength(0);
  });

  it("目标已有日志时：前缀可续导、完全相同幂等、冲突拒绝且不覆盖", async () => {
    const events = sampleEvents();
    const archive = buildArchive({ roomId: ROOM, events, savedAt: 1 });

    const target = new FileStore(roomsDir());
    await target.append(ROOM, events.slice(0, 2));
    expect(planImport(events, 2, events.slice(0, 2))).toMatchObject({ action: "extend" });
    const extended = await importArchive({ archive, events, store: target });
    expect(extended).toMatchObject({ ok: true, action: "extend", appended: 1, seq: 3 });
    expect(await target.replay(ROOM)).toEqual(archive.projection);

    const noop = await importArchive({ archive, events, store: target });
    expect(noop).toMatchObject({ ok: true, action: "noop", appended: 0 });
    expect(await target.seq(ROOM)).toBe(3);

    const conflictEvents = structuredClone(events.slice(0, 2));
    (conflictEvents[1]!.payload as Record<string, unknown>)["to"] = 77;
    const conflictStore = new FileStore(roomsDir());
    await conflictStore.append(ROOM, conflictEvents);
    const result = await importArchive({ archive, events, store: conflictStore });
    expect(result).toMatchObject({ ok: false, code: "E_PRECONDITION" });
    // 拒绝后原日志逐字节不变（没有半落库）
    expect(await conflictStore.events(ROOM, 1)).toEqual(conflictEvents);
    expect(await conflictStore.seq(ROOM)).toBe(2);
  });

  it("归档带存档索引快照时，导入后一并恢复 saves.json 投影", async () => {
    const events = sampleEvents();
    const { SaveIndex } = await import("./saves.ts");
    const { saveFilePath } = await import("./saves.ts");
    const sourceIndex = new SaveIndex(path.join(tempDir("galgame-archive-src-"), "users"));
    const entry = {
      roomId: ROOM, scenarioId: "default", createdAt: 10, updatedAt: 20,
      lastTurnId: "t1", lastCommittedSeq: 3, actorId: "plr_a", formatVersion: 1 as const,
    };
    await sourceIndex.upsert("u_a", entry);
    const archive = buildArchive({
      roomId: ROOM, events, savedAt: 1,
      saveIndex: { userId: "u_a", saves: [entry] },
    });
    const checked = inspectArchive(JSON.parse(JSON.stringify(archive)));
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;

    const usersDir = path.join(tempDir("galgame-archive-dst-"), "users");
    const targetIndex = new SaveIndex(usersDir);
    const result = await importArchive({
      archive: checked.archive, events: checked.events,
      store: new FileStore(roomsDir()),
      saveIndexStore: targetIndex, saveIndexData: checked.saveIndexData,
    });
    expect(result).toMatchObject({ ok: true, saveIndexRestored: true });
    expect(await targetIndex.list("u_a")).toMatchObject([{ roomId: ROOM, lastTurnId: "t1" }]);
    expect(saveFilePath(usersDir, "u_a")).toContain("saves.json");
  });
});
