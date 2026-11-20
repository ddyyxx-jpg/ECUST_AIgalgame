/**
 * 每房间单飞的后台工作循环：prepare → inflight → done/failed，带看门狗与 idle 等待。
 * 单飞锁只在本进程内；跨重启的遗留状态由 JobLedger.reconcile 处理。
 */
import { randomBytes } from "node:crypto";
import type { JobLedger } from "./job-ledger.ts";

export type CycleReason = "busy" | "stalled" | "error";

export interface CycleOutcome {
  ok: boolean;
  reason?: CycleReason;
  jobId?: string;
  error?: string;
}

export interface CycleOptions {
  kind: string;
  basedOnSeq: number;
  stallMs?: number;
}

export interface CycleTaskContext {
  signal: AbortSignal;
  jobId: string;
}

interface Entry {
  kind: string;
  jobId: string;
  startedAt: number;
  controller: AbortController;
  waiters: Set<(idle: boolean) => void>;
}

type Settled =
  | { status: "done"; value: Record<string, unknown> | void }
  | { status: "error"; error: string }
  | { status: "stalled" | "aborted" };

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class BackgroundCycle {
  private readonly ledger?: JobLedger;
  private readonly now: () => number;
  private readonly defaultStallMs: number;
  private readonly idFactory?: () => string;
  private readonly active = new Map<string, Entry>();

  constructor(opts: {
    ledger?: JobLedger;
    now?: () => number;
    defaultStallMs?: number;
    idFactory?: () => string;
  } = {}) {
    this.ledger = opts.ledger;
    this.now = opts.now ?? Date.now;
    this.defaultStallMs = opts.defaultStallMs ?? 120_000;
    this.idFactory = opts.idFactory;
  }

  isBusy(roomId: string): boolean {
    return this.active.has(roomId);
  }

  inflight(roomId: string): { kind: string; jobId: string; startedAt: number } | null {
    const e = this.active.get(roomId);
    return e ? { kind: e.kind, jobId: e.jobId, startedAt: e.startedAt } : null;
  }

  /** 投影写失败只 warn：账本不可用的情况下后台工作照常跑 */
  private async safeWrite(op: () => Promise<unknown>): Promise<void> {
    try {
      await op();
    } catch (e) {
      console.warn("[background] ledger 写入失败：", e instanceof Error ? e.message : e);
    }
  }

  private release(roomId: string, entry: Entry): void {
    if (this.active.get(roomId) !== entry) return;
    this.active.delete(roomId);
    for (const w of [...entry.waiters]) w(true);
  }

  async run(
    roomId: string,
    opts: CycleOptions,
    task: (ctx: CycleTaskContext) => Promise<Record<string, unknown> | void>,
  ): Promise<CycleOutcome> {
    if (this.active.has(roomId)) return { ok: false, reason: "busy" };

    const jobId = this.idFactory ? this.idFactory() : `${opts.kind}_${this.now()}_${randomBytes(4).toString("hex").slice(0, 8)}`;
    const startedAt = this.now();
    const controller = new AbortController();
    const entry: Entry = { kind: opts.kind, jobId, startedAt, controller, waiters: new Set() };
    this.active.set(roomId, entry);
    const stallMs = Math.max(1, opts.stallMs ?? this.defaultStallMs);

    try {
      let attempts = 0;
      if (this.ledger) {
        await this.safeWrite(() =>
          this.ledger!.append({
            id: jobId,
            kind: opts.kind,
            roomId,
            basedOnSeq: opts.basedOnSeq,
            status: "prepared",
            attempts,
            createdAt: startedAt,
            updatedAt: startedAt,
          }),
        );
        await this.safeWrite(() =>
          this.ledger!.transition(roomId, jobId, { status: "inflight", attempts: ++attempts }),
        );
      }

      let stalled = false;
      let resolveAbort!: (status: "stalled" | "aborted") => void;
      const aborted = new Promise<"stalled" | "aborted">((resolve) => {
        resolveAbort = resolve;
      });
      const onAbort = () => resolveAbort(stalled ? "stalled" : "aborted");
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        stalled = true;
        controller.abort(`stalled: 超过 ${stallMs}ms 未完成`);
      }, stallMs);
      timer.unref?.();

      let settled: Settled;
      try {
        settled = await Promise.race<Settled>([
          (async (): Promise<Settled> => {
            try {
              const value = await task({ signal: controller.signal, jobId });
              return { status: "done", value };
            } catch (e) {
              return { status: "error", error: errorText(e) };
            }
          })(),
          aborted.then((status): Settled => ({ status })),
        ]);
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
      }

      if (settled.status === "done") {
        const receipt = settled.value && typeof settled.value === "object" ? settled.value : undefined;
        if (this.ledger) {
          await this.safeWrite(() =>
            this.ledger!.transition(roomId, jobId, { status: "done", ...(receipt ? { receipt } : {}) }),
          );
        }
        return { ok: true, jobId };
      }
      if (settled.status === "stalled") {
        if (this.ledger) {
          await this.safeWrite(() =>
            this.ledger!.transition(roomId, jobId, { status: "failed", lastError: `stalled: 超过 ${stallMs}ms 未完成` }),
          );
        }
        return { ok: false, reason: "stalled", jobId };
      }
      if (settled.status === "aborted") {
        if (this.ledger) {
          await this.safeWrite(() =>
            this.ledger!.transition(roomId, jobId, { status: "failed", lastError: "aborted" }),
          );
        }
        return { ok: false, reason: "error", error: "aborted", jobId };
      }
      if (settled.status === "error") {
        const message = settled.error;
        if (this.ledger) {
          await this.safeWrite(() =>
            this.ledger!.transition(roomId, jobId, { status: "failed", lastError: message }),
          );
        }
        return { ok: false, reason: "error", error: message, jobId };
      }
      return { ok: false, reason: "error", error: "unknown", jobId };
    } finally {
      this.release(roomId, entry);
    }
  }

  async waitForIdle(roomId: string, timeoutMs: number): Promise<boolean> {
    const entry = this.active.get(roomId);
    if (!entry) return true;
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = (idle: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        entry.waiters.delete(finish);
        resolve(idle);
      };
      timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      entry.waiters.add(finish);
    });
  }

  /** 关停时中止全部在途工作；已结束的条目已从 active 移除，自然跳过 */
  async abortAll(reason = "aborted"): Promise<void> {
    const entries = [...this.active.entries()];
    await Promise.all(
      entries.map(async ([roomId, entry]) => {
        try {
          entry.controller.abort(reason);
          if (this.ledger) {
            await this.safeWrite(() =>
              this.ledger!.transition(roomId, entry.jobId, { status: "failed", lastError: reason }),
            );
          }
        } catch (e) {
          console.warn("[background] abortAll 失败：", e instanceof Error ? e.message : e);
        }
      }),
    );
  }
}
