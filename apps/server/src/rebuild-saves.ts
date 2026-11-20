/**
 * 存档索引只读重建（issue #122）：索引是投影，房间 `data/rooms/*.jsonl` 与
 * `data/history/*.history.jsonl` 才是权威。本模块只"读权威 → 重建投影"，
 * 绝不写 `data/rooms/`，也不触发 Arbiter（I1：世界状态无人能绕过裁决改）。
 *
 * 归属口径：`room.member.joined` 的 `userId` 是唯一账号来源，成员表里没写的
 * 老房间（3.1 之前）不会产生任何条目——宁可少补，也不串号。
 * 单调游标口径沿用 SaveIndex.touch：只有 committedSeq 严格前进才刷新，
 * 相同 seq（重放）不刷新 updatedAt，更不会用旧条目覆盖已存在的新条目。
 */
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_SAVES, saveFilePath, savesFileSchema } from "./saves.ts";
import type { SaveEntry, SavesFile } from "./saves.ts";
import type { TurnHistoryLine } from "./turn-history.ts";

export interface RebuildOptions {
  /** 房间事件日志目录（data/rooms） */
  roomsDir: string;
  /** 历史投影目录（data/history） */
  historyDir: string;
  /** 存档索引根目录（data/users）；传临时目录即可做离线演练 */
  savesDir: string;
  /** 只在 CLI 真正落盘时给 true；演练/测试默认只返回计划 */
  write?: boolean;
  /** 告警回调（坏档、越权、旧索引不可读都只告警不抛出） */
  warn?: (message: string) => void;
}

export interface RebuildReport {
  /** 扫描到的房间数 */
  roomsScanned: number;
  /** 跳过（坏档 / 无 join / 无 commit）的房间数 */
  roomsSkipped: number;
  /** 按 userId 归并的条目（只含能合法解析的） */
  rebuilt: Map<string, SaveEntry[]>;
  /** 实际写入的 saves.json 路径 */
  written: string[];
  /** 跳过的备份路径（写失败时保留的 .bak） */
  backups: string[];
}

interface RoomFacts {
  roomId: string;
  /** actorId → userId，来自 room.member.joined */
  owners: Map<string, string>;
  /** 每个 committedSeq 最后一次 turn.commit 的 turnId（seq 单调） */
  commits: Map<number, string>;
  createdAt: number;
}

const warnOf = (o: RebuildOptions) => o.warn ?? ((m: string) => console.warn(m));

/** 房间日志文件名 → roomId（FileStore 只写 [A-Za-z0-9_-]{1,80} 的安全 id） */
function roomIdOf(file: string): string | undefined {
  if (!file.endsWith(".jsonl") || file.endsWith(".history.jsonl")) return undefined;
  const id = file.slice(0, -".jsonl".length);
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : undefined;
}

/** 与 TurnHistory.safeRoomFile 同口径（历史投影文件名可能是 hash） */
function safeRoomFile(roomId: string): string {
  if (/^[A-Za-z0-9_-]{1,80}$/.test(roomId)) return roomId;
  // 这里房间 id 来自安全白名单，走不到 hash 分支；保留兜底只为与投影侧一致
  return roomId.replace(/[^A-Za-z0-9_-]/g, "_");
}

function record(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** 解析单个房间日志；任何格式问题都抛错，由调用方跳过并告警。 */
function parseRoom(text: string, roomId: string): RoomFacts {
  const owners = new Map<string, string>();
  const commits = new Map<number, string>();
  let createdAt = 0;
  let expected = 1;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let env: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") throw new Error("非对象事件");
      env = parsed as Record<string, unknown>;
    } catch (cause) {
      throw new Error(`第 ${expected} 条附近不是合法 JSON`, { cause });
    }
    if (env.roomId !== roomId) throw new Error(`事件 roomId=${String(env.roomId)} 与文件名不符`);
    if (env.seq !== expected) throw new Error(`seq 不连续：期望 ${expected}，实得 ${String(env.seq)}`);
    expected += 1;
    if (createdAt === 0 && typeof env.ts === "number") createdAt = env.ts;

    if (env.type === "room.member.joined") {
      const member = record(env, ["payload", "member"]);
      if (!member || typeof member !== "object") throw new Error("room.member.joined 缺少 member");
      const memberObj = member as Record<string, unknown>;
      const actorId = record(memberObj, ["actorId"]);
      const userId = record(memberObj, ["userId"]);
      if (typeof actorId !== "string" || typeof userId !== "string" || !userId) {
        // 没有 userId 的老房间合法但不产生归属，跳过这条即可
        continue;
      }
      owners.set(actorId, userId);
    } else if (env.type === "turn.committed") {
      // 引擎真正落 EventLog 的提交标记（arbiter.commitMarker）；turn.commit 只是 SSE 事件，
      // 从不写日志（#123 P0-A：fixture 必须与发射处逐字一致）。
      const turnId = record(env, ["payload", "turnId"]);
      const committedSeq = record(env, ["payload", "committedSeq"]);
      if (typeof turnId !== "string" || typeof committedSeq !== "number" || !Number.isInteger(committedSeq) || committedSeq < 1) {
        throw new Error("turn.committed 缺少合法 turnId/committedSeq");
      }
      commits.set(committedSeq, turnId);
    }
  }
  return { roomId, owners, commits, createdAt };
}

/** 读历史投影：turnId + committedSeq → createdAt（最后一条）。历史坏行按投影侧口径跳过。 */
async function readHistory(historyDir: string, roomId: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const text = await readFile(path.join(historyDir, `${safeRoomFile(roomId)}.history.jsonl`), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let lineObj: TurnHistoryLine;
      try {
        lineObj = JSON.parse(line) as TurnHistoryLine;
      } catch {
        continue;
      }
      if (typeof lineObj?.turnId === "string" && typeof lineObj.committedSeq === "number" && typeof lineObj.createdAt === "number") {
        map.set(`${lineObj.committedSeq}\u0000${lineObj.turnId}`, lineObj.createdAt);
      }
    }
  } catch {
    // 历史可能缺失（功能上线前的房间）——不影响根据事件日志重建
  }
  return map;
}

/** 读旧索引（不抛错：坏档也允许重建，原件留 .bak）。 */
async function readExisting(savesDir: string, userId: string, warn: (m: string) => void): Promise<SavesFile | undefined> {
  const file = saveFilePath(savesDir, userId);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const doc = savesFileSchema.parse(JSON.parse(text));
    if (doc.userId !== userId) throw new Error("归属不符");
    return doc;
  } catch (cause) {
    warn(`[rebuild-saves] 旧索引不可读，将按 .bak 保留后重建：${file}（${(cause as Error).message}）`);
    return undefined;
  }
}

/** 单调合并：旧条目较新（seq 更大或 seq 相同但 updatedAt 更新）时不覆盖。 */
function merge(existing: SavesFile | undefined, candidates: SaveEntry[]): SaveEntry[] {
  const byRoom = new Map<string, SaveEntry>();
  for (const entry of existing?.saves ?? []) byRoom.set(entry.roomId, entry);
  for (const candidate of candidates) {
    const old = byRoom.get(candidate.roomId);
    if (!old || candidate.lastCommittedSeq > old.lastCommittedSeq ||
        (candidate.lastCommittedSeq === old.lastCommittedSeq && candidate.updatedAt > old.updatedAt)) {
      // #123 P1-E：命名槽关联挂在已有条目上；候选条目替换时保留，避免重建后 listSlots() 失联。
      const next = old?.slotId && !candidate.slotId ? { ...candidate, slotId: old.slotId } : candidate;
      byRoom.set(candidate.roomId, next);
    }
  }
  return [...byRoom.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SAVES);
}

/** 写前留 .bak、tmp + rename 原子替换（同 SaveIndex.write）。 */
async function persist(file: string, doc: SavesFile, report: RebuildReport): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await copyFile(file, `${file}.bak`);
    report.backups.push(`${file}.bak`);
  } catch {
    // 旧档不存在（删档后重建）无需备份
  }
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(doc), "utf8");
  await rename(tmp, file);
  report.written.push(file);
}

/** 扫描全部房间并按 userId 归并；write=false 时只产出计划（供测试/演练）。 */
export async function rebuildSavesIndex(opts: RebuildOptions): Promise<RebuildReport> {
  const warn = warnOf(opts);
  const report: RebuildReport = { roomsScanned: 0, roomsSkipped: 0, rebuilt: new Map(), written: [], backups: [] };
  const perUser = new Map<string, SaveEntry[]>();

  let files: string[];
  try {
    files = (await readdir(opts.roomsDir)).filter((f) => roomIdOf(f) !== undefined);
  } catch {
    warn(`[rebuild-saves] 房间目录不存在或不可读：${opts.roomsDir}`);
    return report;
  }

  for (const file of files) {
    const roomId = roomIdOf(file)!;
    report.roomsScanned += 1;
    let facts: RoomFacts;
    try {
      facts = parseRoom(await readFile(path.join(opts.roomsDir, file), "utf8"), roomId);
    } catch (cause) {
      warn(`[rebuild-saves] 跳过坏档房间 ${roomId}：${(cause as Error).message}`);
      report.roomsSkipped += 1;
      continue;
    }
    if (facts.commits.size === 0 || facts.owners.size === 0) {
      // 无提交回合 / 无归属成员（老房间）都不产生条目
      report.roomsSkipped += 1;
      continue;
    }
    const historyMap = await readHistory(opts.historyDir, roomId);
    const lastSeq = Math.max(...facts.commits.keys());
    const turnId = facts.commits.get(lastSeq)!;
    for (const userId of new Set(facts.owners.values())) {
      // 一个房间可能有多个 player 归属，每个账号各得一条；actorId 取该用户第一条成员记录
      const actorId = [...facts.owners.entries()].find(([, u]) => u === userId)?.[0];
      const entry: SaveEntry = {
        roomId,
        scenarioId: "default", // 事件日志不记 scenarioId；重建按建房默认值（docs/09 §4）
        createdAt: facts.createdAt || lastSeq,
        updatedAt: historyMap.get(`${lastSeq}\u0000${turnId}`) ?? (facts.createdAt || lastSeq),
        lastTurnId: turnId,
        lastCommittedSeq: lastSeq,
        ...(actorId ? { actorId } : {}),
        formatVersion: 1,
      };
      const list = perUser.get(userId) ?? [];
      list.push(entry);
      perUser.set(userId, list);
    }
  }

  for (const [userId, candidates] of perUser) {
    const existing = await readExisting(opts.savesDir, userId, warn);
    const merged = merge(existing, candidates);
    report.rebuilt.set(userId, merged);
    if (existing && JSON.stringify(existing.saves) === JSON.stringify(merged)) continue;
    if (opts.write) {
      // #123 P1-E：slots 是独立于 saves 的投影，重建只能补 saves，不能把命名槽整段抹掉。
      await persist(saveFilePath(opts.savesDir, userId), {
        version: 1, userId, saves: merged,
        ...(existing?.slots !== undefined ? { slots: existing.slots } : {}),
      }, report);
    }
  }
  return report;
}
