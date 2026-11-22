/**
 * 存档索引（issue #7）：`data/users/<safeUserId>/saves.json`。
 *
 * 为什么是"索引"而不是存档本体：世界状态的事件日志在 `data/rooms/`，这里只记
 * "这个账号玩过哪些房间、最后一次提交到哪"。删索引不删房间（玩家还能靠 roomId 回来）。
 * 目录名与 `FileImpressions` 一致地做 sha256 去重，避免 `a/b` 与 `a_b` 撞同一份文件。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** 与 docs/09 对齐的存档条目；`formatVersion` 只在破坏性变更时 +1 */
export interface SaveEntry {
  roomId: string;
  scenarioId: string;
  createdAt: number;
  updatedAt: number;
  lastTurnId: string;
  lastCommittedSeq: number;
  /**
   * 建房时服务端签发的房间内角色 id。
   * 3.3 之前的老存档没有这个字段，恢复时由前端从房间成员表兜底；新存档必须写。
   */
  actorId?: string;
  formatVersion: 1;
  /** issue #98：命名槽归属（缺省 = 历史默认存档，保持兼容） */
  slotId?: string;
}

/** issue #98：账号内的命名房间槽映射；删槽只删映射，房间事件/历史不动 */
export interface SaveSlot {
  slotId: string;
  label: string;
  roomId: string;
  createdAt: number;
  updatedAt: number;
}

export interface SavesFile {
  version: 1;
  userId: string;
  saves: SaveEntry[];
  /** issue #98：旧文件无此字段时视为空，条目原样保留 */
  slots?: SaveSlot[];
}

/** 单账号最多保留的存档数：只是索引，超了淘汰最久未更新的（房间本身不删） */
export const MAX_SAVES = 100;
/** 单账号命名槽上限（issue #98） */
export const MAX_SLOTS = 20;
export const SLOT_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const SLOT_LABEL_MAX = 40;

/** 槽操作的业务结果；错误码复用 §7 闭集，不新增 E_* */
export type SlotResult<T> = { ok: true; value: T } | {
  ok: false;
  code: "E_OVER_LIMIT" | "E_ID_TAKEN" | "E_REF_NOT_FOUND" | "E_SCHEMA_INVALID";
};

/** 目录名：可读前缀 + sha256 前缀（单射、防穿越/撞名）。重建工具与 SaveIndex 共用。 */
export function saveFilePath(root: string, userId: string): string {
  const readable = userId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24) || "u";
  const digest = createHash("sha256").update(userId, "utf8").digest("hex").slice(0, 24);
  return path.join(root, `${readable}-${digest}`, "saves.json");
}

export const savesFileSchema = z.object({
  version: z.literal(1),
  userId: z.string(),
  saves: z.array(z.object({
    roomId: z.string(),
    scenarioId: z.string(),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
    lastTurnId: z.string(),
    lastCommittedSeq: z.number().int().nonnegative(),
    actorId: z.string().optional(),
    formatVersion: z.literal(1),
    slotId: z.string().optional(),
  }).passthrough()),
  slots: z.array(z.object({
    slotId: z.string(),
    label: z.string(),
    roomId: z.string(),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
  }).passthrough()).optional(),
}).passthrough();

export class SaveIndex {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** 可读前缀 + sha256：既是单射（防穿越/防撞目录），又方便运维认人 */
  private file(userId: string): string {
    return saveFilePath(this.root, userId);
  }

  async list(userId: string): Promise<SaveEntry[]> {
    const file = await this.read(userId);
    return [...file.saves].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** issue #98：列出命名槽（旧索引无 slots → 空数组，条目不动） */
  async listSlots(userId: string): Promise<SaveSlot[]> {
    const file = await this.read(userId);
    return [...(file.slots ?? [])].sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * 绑定/改绑命名槽。房间必须属于该账号（saves 里有条目）——槽不创建房间。
   * 返回业务结果而非抛错，HTTP 层按 code 映射状态。
   */
  async putSlot(userId: string, input: { slotId?: string; label: string; roomId: string; createOnly?: boolean }): Promise<SlotResult<SaveSlot>> {
    const label = input.label.trim();
    if ((input.slotId !== undefined && !SLOT_ID_RE.test(input.slotId)) || !label ||
        label.length > SLOT_LABEL_MAX || !input.roomId) {
      return { ok: false, code: "E_SCHEMA_INVALID" };
    }
    let result: SlotResult<SaveSlot> = { ok: false, code: "E_ID_TAKEN" };
    await this.mutate(userId, (file) => {
      const slots = file.slots ?? (file.slots = []);
      const slotId = input.slotId ?? randomUUID();
      const existing = slots.find((s) => s.slotId === slotId);
      if (slots.some((s) => s.roomId === input.roomId && s.slotId !== slotId)) {
        result = { ok: false, code: "E_ID_TAKEN" };
        return false;
      }
      if (!file.saves.some((s) => s.roomId === input.roomId)) {
        result = { ok: false, code: "E_REF_NOT_FOUND" };
        return false;
      }
      // docs/03 §5.2.7：POST 是"建槽"，显式带已存在 slotId 必须 E_ID_TAKEN；
      // 更新只能走 PUT。判断放在 mutate 内（与槽表同一把串行锁），避免路由层先查后写的竞态。
      if (existing && input.createOnly) {
        result = { ok: false, code: "E_ID_TAKEN" };
        return false;
      }
      if (existing) {
        const previousRoom = existing.roomId;
        existing.label = label;
        existing.roomId = input.roomId;
        existing.updatedAt = this.now();
        if (previousRoom !== input.roomId) {
          const oldEntry = file.saves.find((s) => s.roomId === previousRoom);
          if (oldEntry) delete oldEntry.slotId;
        }
        const entry = file.saves.find((s) => s.roomId === input.roomId);
        if (entry) entry.slotId = slotId;
        result = { ok: true, value: { ...existing } };
        return true;
      }
      if (slots.length >= MAX_SLOTS) {
        result = { ok: false, code: "E_OVER_LIMIT" };
        return false;
      }
      const slot: SaveSlot = {
        slotId, label, roomId: input.roomId, createdAt: this.now(), updatedAt: this.now(),
      };
      slots.push(slot);
      const entry = file.saves.find((s) => s.roomId === input.roomId);
      if (entry) entry.slotId = slotId;
      result = { ok: true, value: { ...slot } };
      return true;
    });
    return result;
  }

  /** 删槽只删映射，saves 条目与房间数据不动 */
  async deleteSlot(userId: string, slotId: string): Promise<boolean> {
    if (!SLOT_ID_RE.test(slotId)) return false;
    return this.mutate(userId, (file) => {
      const bound = file.slots?.find((s) => s.slotId === slotId)?.roomId;
      const before = file.slots?.length ?? 0;
      file.slots = (file.slots ?? []).filter((s) => s.slotId !== slotId);
      if ((file.slots?.length ?? 0) === before) return false;
      const entry = file.saves.find((s) => s.roomId === bound);
      // 只清 schema 声明的字段，不碰 passthrough 的用户扩展
      if (entry) delete entry.slotId;
      return true;
    });
  }

  /** 建房登记：同一房间重复 upsert 时保留更早的 createdAt（幂等） */
  async upsert(userId: string, entry: SaveEntry): Promise<void> {
    await this.mutate(userId, (file) => {
      const existing = file.saves.find((s) => s.roomId === entry.roomId);
      if (existing) {
        if (entry.lastCommittedSeq < existing.lastCommittedSeq) return false;
        existing.scenarioId = entry.scenarioId;
        existing.updatedAt = entry.updatedAt;
        existing.lastTurnId = entry.lastTurnId;
        existing.lastCommittedSeq = entry.lastCommittedSeq;
        if (entry.actorId) existing.actorId = entry.actorId;
        return true;
      }
      file.saves.push(entry);
      file.saves.sort((a, b) => b.updatedAt - a.updatedAt);
      file.saves = file.saves.slice(0, MAX_SAVES);
      return true;
    });
  }

  /** 回合提交后推进游标。未登记的房间或迟到的较低序号返回 false。 */
  touch(userId: string, roomId: string, turnId: string, committedSeq: number): Promise<boolean> {
    return this.mutate(userId, (file) => {
      const entry = file.saves.find((s) => s.roomId === roomId);
      // 严格前进才推进：相同 seq 是同一回合的重放（重试/重复回调），不刷新 updatedAt，
      // 否则「我的存档」的排序会被无意义的重复提交搅动。
      if (!entry || committedSeq <= entry.lastCommittedSeq) return false;
      entry.lastTurnId = turnId;
      entry.lastCommittedSeq = committedSeq;
      entry.updatedAt = this.now();
      return true;
    });
  }

  /** 只删索引，不删房间：返回是否真的删掉了一条（含该房间的悬空命名槽） */
  remove(userId: string, roomId: string): Promise<boolean> {
    return this.mutate(userId, (file) => {
      const before = file.saves.length;
      file.saves = file.saves.filter((s) => s.roomId !== roomId);
      const slotsBefore = file.slots?.length ?? 0;
      if (file.slots) file.slots = file.slots.filter((s) => s.roomId !== roomId);
      const slotRemoved = (file.slots?.length ?? 0) < slotsBefore;
      return file.saves.length < before || slotRemoved;
    });
  }

  private async read(userId: string): Promise<SavesFile> {
    let text: string;
    try {
      text = await readFile(this.file(userId), "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, userId, saves: [] };
      throw Object.assign(new Error("读取存档索引失败", { cause }), { code: "E_STORE_FAULT" });
    }
    try {
      // 任一条目损坏都中止，避免部分解析成功后把原始条目覆盖掉。
      const doc: SavesFile = savesFileSchema.parse(JSON.parse(text));
      if (doc.userId !== userId) throw new Error("存档索引归属不符");
      return doc;
    } catch (cause) {
      throw Object.assign(new Error("存档索引无效", { cause }), { code: "E_STORE_FAULT" });
    }
  }

  private mutate(userId: string, fn: (file: SavesFile) => boolean): Promise<boolean> {
    const prev = this.chains.get(userId) ?? Promise.resolve();
    const task = prev.then(async () => {
      const file = await this.read(userId);
      const changed = fn(file);
      if (changed) await this.write(userId, file);
      return changed;
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
