/**
 * 世界印象的落盘（P4，docs/08 §8）：`data/users/<userId>/impressions.json`。
 *
 * 为什么不是世界状态：印象是"给某个玩家看的提示"，同一个世界层事件对不同玩家投递结果不同，
 * 放进世界状态会让回放依赖"谁在线"。所以它是**用户投影**（可重建、可丢、坏了不影响存档）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Id, ImpressionNotice } from "../../../packages/shared/src/index.ts";
import { pendingNotices } from "../../../packages/engine/src/impressions.ts";
import type { Impressions } from "../../../packages/engine/src/impressions.ts";

interface UserFile {
  version: 1;
  userId: Id;
  notices: ImpressionNotice[];
}

export class FileImpressions implements Impressions {
  constructor(
    private readonly root: string,
    private readonly opts: { ttlDays: number; now?: () => number } = { ttlDays: 30 },
  ) {}

  private file(userId: Id): string {
    // userId 只允许安全字符（来自 X-User-Id，已截断 64）：防路径穿越
    const safe = userId.replace(/[^A-Za-z0-9_-]/g, "_");
    return path.join(this.root, safe, "impressions.json");
  }

  private async read(userId: Id): Promise<UserFile> {
    try {
      const raw = JSON.parse(await readFile(this.file(userId), "utf8")) as Partial<UserFile>;
      const notices = Array.isArray(raw.notices) ? raw.notices.filter((n): n is ImpressionNotice => !!n && typeof n.id === "string") : [];
      return { version: 1, userId, notices };
    } catch {
      return { version: 1, userId, notices: [] };
    }
  }

  private async write(file: UserFile): Promise<void> {
    const target = this.file(file.userId);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(file), "utf8");
  }

  /** canonize 成功后入队（按 memoryId 去重：同一件事只提示一次） */
  async enqueue(notices: ImpressionNotice[]): Promise<void> {
    for (const notice of notices) {
      const file = await this.read(notice.userId);
      if (file.notices.some((n) => n.memoryId === notice.memoryId)) continue;
      file.notices.push(notice);
      await this.write(file);
    }
  }

  async pending(userId: Id, _roomId: Id, limit: number): Promise<ImpressionNotice[]> {
    const file = await this.read(userId);
    return pendingNotices(file.notices, {
      ttlDays: this.opts.ttlDays,
      now: this.opts.now ? this.opts.now() : Date.now(),
      limit,
    });
  }

  async markDelivered(notices: ImpressionNotice[]): Promise<void> {
    if (notices.length === 0) return;
    const ts = this.opts.now ? this.opts.now() : Date.now();
    const byUser = new Map<Id, Set<Id>>();
    for (const n of notices) {
      const set = byUser.get(n.userId) ?? new Set<Id>();
      set.add(n.id);
      byUser.set(n.userId, set);
    }
    for (const [userId, wanted] of byUser) {
      const file = await this.read(userId);
      let changed = false;
      for (const n of file.notices) {
        if (wanted.has(n.id) && !n.deliveredAt) {
          n.deliveredAt = ts;
          changed = true;
        }
      }
      if (changed) await this.write(file);
    }
  }

  async count(userId: Id): Promise<number> {
    const file = await this.read(userId);
    return file.notices.filter((n) => !n.deliveredAt).length;
  }
}
