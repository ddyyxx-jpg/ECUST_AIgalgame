/**
 * 后台任务的追加式 JSONL 投影（PR-2）。
 * 只记录 job 生命周期，不碰世界状态：删掉整个目录也只是丢历史，不影响存档。
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

/** 生命周期四态（PR #125 P2：deferred 没有写入点，已移除） */
export type JobStatus = "prepared" | "inflight" | "done" | "failed";

export interface JobRecord {
  id: string;
  kind: string;
  roomId: string;
  basedOnSeq: number;
  status: JobStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
  receipt?: Record<string, unknown>;
}

export interface JobReconcile {
  runnable: JobRecord[];
  orphaned: JobRecord[];
}

const ROOM_ID_RE = /^[A-Za-z0-9._-]+$/;
const STATUSES = new Set<JobStatus>(["prepared", "inflight", "done", "failed"]);
/** 终态只写一次：只允许 活着 → inflight → done/failed；done/failed 不再被改写 */
const TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  prepared: ["inflight", "failed"],
  inflight: ["done", "failed"],
  done: [],
  failed: [],
};

/** 同文件在进程内串行 append，避免并发写互相穿插；键为绝对文件路径 */
const appendQueues = new Map<string, Promise<void>>();

export class JobLedger {
  /** now 可注入：让 transition 的 updatedAt 与 BackgroundCycle 的时钟同源，测试可复现 */
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** roomId 进文件名，必须挡住路径穿越 */
  private fileOf(roomId: string): string {
    if (typeof roomId !== "string" || !ROOM_ID_RE.test(roomId)) {
      throw new Error(`非法 roomId: ${String(roomId)}`);
    }
    return path.join(this.dir, roomId + ".jsonl");
  }

  /** 不缓存：每次读文件，最后一个同 id 记录即当前投影；坏行跳过 */
  async list(roomId: string): Promise<JobRecord[]> {
    const file = this.fileOf(roomId);
    const raw = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return "";
      throw e;
    });
    // 文件名是房间的权威来源：只允许读取 roomId 与所在文件一致的记录，
    // 防止错放的记录被 transition 写进别的房间（PR #147 P2-3）。
    const expectedRoomId = path.basename(file, ".jsonl");
    const latest = new Map<string, JobRecord>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        console.warn(`[job-ledger] 跳过坏行：${line.slice(0, 120)}`);
        continue;
      }
      if (!rec || typeof rec !== "object" || !isJobRecord(rec)) {
        console.warn(`[job-ledger] 跳过非法记录：${line.slice(0, 120)}`);
        continue;
      }
      if (rec.roomId !== expectedRoomId) {
        console.warn(`[job-ledger] 跳过 roomId 不匹配记录：期望 ${expectedRoomId}，实际 ${String(rec.roomId)}`);
        continue;
      }
      latest.set(rec.id, rec);
    }
    return [...latest.values()];
  }

  async append(rec: JobRecord): Promise<void> {
    const file = this.fileOf(rec.roomId);
    const line = JSON.stringify(rec) + "\n";
    const prev = appendQueues.get(file) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, line, "utf8");
    });
    appendQueues.set(file, next);
    try {
      await next;
    } finally {
      if (appendQueues.get(file) === next) appendQueues.delete(file);
    }
  }

  /**
   * 找最新记录 → 合并 patch 与 updatedAt → 追加；不存在返回 null。
   * 终态（done/failed）不再改写：重复收尾时返回当前记录而不追加，保证 failed 只写一次。
   */
  async transition(
    roomId: string,
    id: string,
    patch: Partial<Pick<JobRecord, "status" | "attempts" | "lastError" | "receipt">>,
  ): Promise<JobRecord | null> {
    const current = (await this.list(roomId)).find((r) => r.id === id);
    if (!current) return null;
    if (patch.status && !TRANSITIONS[current.status].includes(patch.status)) return current;
    const next: JobRecord = { ...current, ...patch, updatedAt: this.now() };
    await this.append(next);
    return next;
  }

  async reconcile(roomId: string): Promise<JobReconcile> {
    const all = await this.list(roomId);
    return {
      runnable: all.filter((r) => r.status === "prepared"),
      orphaned: all.filter((r) => r.status === "inflight"),
    };
  }
}

function isJobRecord(v: object): v is JobRecord {
  const r = v as Partial<JobRecord>;
  return (
    typeof r.id === "string" &&
    r.id.length > 0 &&
    // roomId 必须是非空字符串；与文件名的比对在 list() 中按所在文件完成
    typeof r.roomId === "string" &&
    r.roomId.length > 0 &&
    typeof r.status === "string" &&
    STATUSES.has(r.status as JobStatus)
  );
}
