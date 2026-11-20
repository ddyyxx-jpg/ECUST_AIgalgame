/**
 * 每房间单飞的后台工作循环：prepare → inflight → done/failed，带看门狗与 idle 等待。
 *
 * 单飞锁的边界（PR #125 P1-1）：一次 run() 的返回（含 stalled/aborted）只结束"本次结果"，
 * 不代表任务体停了。任务体（canonize.retireRoom / gossip.step）只收 roomId、不接 signal，
 * abort 之后仍会继续跑；锁必须保留到任务体真正 settle 才释放，否则超时后同房再 run 会与
 * 旧任务并发推进同一房间。跨重启的遗留状态由 JobLedger.reconcile 处理。
 */
import { randomBytes } from "node:crypto";
import type { JobLedger, JobRecord } from "./job-ledger.ts";

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

/**
 * 关停中止的统一文案：run 的 abort 分支写这一条，abortAll 自己不再写投影，
 * 因此"inflight → failed"只发生一次，lastError 也只有一个来源。
 */
export const ABORTED_ERROR = "aborted: shutdown 中止在途任务";

interface Entry {
  kind: string;
  jobId: string;
  startedAt: number;
  controller: AbortController;
  waiters: Set<(idle: boolean) => void>;
  /** run() 已返回并写完终态后 resolve；abortAll 只等它，不等任务体 settle */
  runFinished: Promise<void>;
  markRunFinished: () => void;
}

type Settled =
  | { status: "done"; value: Record<string, unknown> | void }
  | { status: "error"; error: string }
  | { status: "stalled" | "aborted" };

/** 终态投影写入的"只写一次"闸门：stall/abort 先收尾，任务体后 settle 时不再覆盖 */
interface TerminalGate {
  written: boolean;
}

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
      console.warn("[background] ledger 写入失败：", errorText(e));
    }
  }

  /**
   * 终态只写一次：谁先收尾（run 的 stall/abort 分支，或任务体 settle 后的 finished）谁写，
   * 后来者直接跳过。旧实现在 abortAll 里也写一条 failed，与 run 重复，见 PR #125 P2。
   */
  private async writeTerminal(
    roomId: string,
    jobId: string,
    gate: TerminalGate,
    patch: Partial<Pick<JobRecord, "status" | "receipt" | "lastError" | "attempts">>,
  ): Promise<void> {
    if (gate.written) return;
    gate.written = true;
    if (!this.ledger) return;
    await this.safeWrite(() => this.ledger!.transition(roomId, jobId, patch));
  }

  /** 任务体真正 settle 后才调用：释放单飞锁并唤醒 waitForIdle */
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
    let markRunFinished!: () => void;
    const runFinished = new Promise<void>((resolve) => {
      markRunFinished = resolve;
    });
    const entry: Entry = {
      kind: opts.kind,
      jobId,
      startedAt,
      controller,
      waiters: new Set(),
      runFinished,
      markRunFinished,
    };
    this.active.set(roomId, entry);
    const stallMs = Math.max(1, opts.stallMs ?? this.defaultStallMs);
    const gate: TerminalGate = { written: false };

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

      const taskResult = (async (): Promise<Settled> => {
        try {
          const value = await task({ signal: controller.signal, jobId });
          return { status: "done", value };
        } catch (e) {
          return { status: "error", error: errorText(e) };
        }
      })();

      // 锁只在任务体真正 settle 后释放：stalled/aborted 时 run 已先行返回，这里补收尾。
      const finished = taskResult.then(async (result) => {
        if (result.status === "done") {
          const receipt = result.value && typeof result.value === "object" ? result.value : undefined;
          await this.writeTerminal(roomId, jobId, gate, { status: "done", ...(receipt ? { receipt } : {}) });
        } else if (result.status === "error") {
          await this.writeTerminal(roomId, jobId, gate, { status: "failed", lastError: result.error });
        }
        this.release(roomId, entry);
        return result;
      });

      // abortAll 可能发生在监听器注册之前：信号已 abort 时补一次分发
      if (controller.signal.aborted) resolveAbort(stalled ? "stalled" : "aborted");

      const settled = await Promise.race<Settled>([
        finished,
        aborted.then((status): Settled => ({ status })),
      ]);
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);

      if (settled.status === "done") return { ok: true, jobId };
      if (settled.status === "error") return { ok: false, reason: "error", error: settled.error, jobId };
      if (settled.status === "stalled") {
        await this.writeTerminal(roomId, jobId, gate, {
          status: "failed",
          lastError: `stalled: 超过 ${stallMs}ms 未完成`,
        });
        return { ok: false, reason: "stalled", jobId };
      }
      // aborted：任务体可能还在跑，锁由 finished 在真正 settle 后释放。
      await this.writeTerminal(roomId, jobId, gate, { status: "failed", lastError: ABORTED_ERROR });
      return { ok: false, reason: "error", error: ABORTED_ERROR, jobId };
    } finally {
      entry.markRunFinished();
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

  /**
   * 关停时中止全部在途 run：这里只 abort、不写投影——终态由各 run 的 abort 分支写一次
   * （旧实现 abortAll 再写一条 failed，与 run 重复）。返回时各 run 的终态已写完，
   * 但不等任务体 settle：关停不能被一个不响应 abort 的任务体无限拖住。
   */
  async abortAll(reason = "shutdown"): Promise<void> {
    const entries = [...this.active.values()];
    for (const entry of entries) entry.controller.abort(reason);
    await Promise.all(entries.map((entry) => entry.runFinished));
  }
}

/**
 * 关停序列的可测核心：先中止后台任务（各自写 failed 终态），再关闭 HTTP / 外部资源。
 * main.ts 的 SIGTERM/SIGINT 只是给这个函数接线（PR #125 P2：abortAll 必须有生产调用）。
 */
export async function shutdownBackground(
  background: BackgroundCycle,
  close: () => Promise<void>,
  reason = "shutdown",
): Promise<void> {
  await background.abortAll(reason);
  await close();
}
