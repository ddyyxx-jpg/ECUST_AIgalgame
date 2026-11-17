/**
 * 存档索引（issue #7）：`data/users/<safeUserId>/saves.json`。
 *
 * 为什么是"索引"而不是存档本体：世界状态的事件日志在 `data/rooms/`，这里只记
 * "这个账号玩过哪些房间、最后一次提交到哪"。删索引不删房间（玩家还能靠 roomId 回来）。
 * 目录名与 `FileImpressions` 一致地做 sha256 去重，避免 `a/b` 与 `a_b` 撞同一份文件。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** 与 docs/09 对齐的存档条目；`formatVersion` 只在破坏性变更时 +1 */
export interface SaveEntry {
  roomId: string;
  scenarioId: string;
  createdAt: number;
  updatedAt: number;
  lastTurnId: string;
  lastCommittedSeq: number;
  formatVersion: 1;
}

interface SavesFile {
  version: 1;
  userId: string;
  saves: SaveEntry[];
}

/** 单账号最多保留的存档数：只是索引，超了淘汰最久未更新的（房间本身不删） */
const MAX_SAVES = 100;

function isSaveEntry(v: unknown): v is SaveEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.roomId === "string" &&
    typeof e.scenarioId === "string" &&
    typeof e.createdAt === "number" &&
    typeof e.updatedAt === "number" &&
    typeof e.lastTurnId === "string" &&
    typeof e.lastCommittedSeq === "number" &&
    e.formatVersion === 1
  );
}

export class SaveIndex {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** 可读前缀 + sha256：既是单射（防穿越/防撞目录），又方便运维认人 */
  private file(userId: string): string {
    const readable = userId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24) || "u";
    const digest = createHash("sha256").update(userId, "utf8").digest("hex").slice(0, 24);
    return path.join(this.root, `${readable}-${digest}`, "saves.json");
  }

  async list(userId: string): Promise<SaveEntry[]> {
    const file = await this.read(userId);
    return [...file.saves].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 建房登记：同一房间重复 upsert 时保留更早的 createdAt（幂等） */
  async upsert(userId: string, entry: SaveEntry): Promise<void> {
    await this.mutate(userId, (file) => {
      const existing = file.saves.find((s) => s.roomId === entry.roomId);
      if (existing) {
        existing.scenarioId = entry.scenarioId;
        existing.updatedAt = entry.updatedAt;
        existing.lastTurnId = entry.lastTurnId;
        existing.lastCommittedSeq = entry.lastCommittedSeq;
        return;
      }
      file.saves.push(entry);
      file.saves.sort((a, b) => b.updatedAt - a.updatedAt);
      file.saves = file.saves.slice(0, MAX_SAVES);
    });
  }

  /**
   * 回合提交后推进游标。返回 false 表示索引里没有这条（建房时没带 userId 的老房间）——
   * 历史照常记，只是存档列表里看不到它；这不是错误。
   */
  async touch(userId: string, roomId: string, turnId: string, committedSeq: number): Promise<boolean> {
    let updated = false;
    await this.mutate(userId, (file) => {
      const entry = file.saves.find((s) => s.roomId === roomId);
      if (!entry) return;
      entry.lastTurnId = turnId;
      entry.lastCommittedSeq = committedSeq;
      entry.updatedAt = this.now();
      updated = true;
    });
    return updated;
  }

  /** 只删索引，不删房间：返回是否真的删掉了一条 */
  async remove(userId: string, roomId: string): Promise<boolean> {
    let removed = false;
    await this.mutate(userId, (file) => {
      const before = file.saves.length;
      file.saves = file.saves.filter((s) => s.roomId !== roomId);
      removed = file.saves.length < before;
    });
    return removed;
  }

  private async read(userId: string): Promise<SavesFile> {
    try {
      const raw = JSON.parse(await readFile(this.file(userId), "utf8")) as Partial<SavesFile>;
      const saves = Array.isArray(raw.saves) ? raw.saves.filter(isSaveEntry) : [];
      return { version: 1, userId, saves };
    } catch {
      // 文件缺失/损坏都按"没有存档"处理：索引是可重建投影，不能把服务拖死
      return { version: 1, userId, saves: [] };
    }
  }

  private mutate(userId: string, fn: (file: SavesFile) => void): Promise<void> {
    const prev = this.chains.get(userId) ?? Promise.resolve();
    const task = prev.then(async () => {
      const file = await this.read(userId);
      fn(file);
      await this.write(userId, file);
    });
    this.chains.set(userId, task.catch(() => undefined));
    return task;
  }

  private async write(userId: string, file: SavesFile): Promise<void> {
    const target = this.file(userId);
    await mkdir(path.dirname(target), { recursive: true });
    // 先写临时文件再 rename：避免进程中断留下半截 JSON
    const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, JSON.stringify(file), "utf8");
    await rename(tmp, target);
  }
}
