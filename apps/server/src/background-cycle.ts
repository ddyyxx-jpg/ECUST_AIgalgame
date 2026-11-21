/**
 * 每房间单飞的后台工作循环：prepare → inflight → done/failed，带看门狗与 idle 等待。
 *
 * 单飞锁的边界（issue #140）：一次 run() 的返回（含 stalled/aborted）只结束"本次结果"，
 * 不代表任务体停了。任务体现在接 AbortSignal 并做协作式检查点；但即使任务体不响应 abort
 * （例如 LLM 连接永久挂起），stall 看门狗也会**强制接管**：abort 旧任务并把锁交给同房间新的
 * run。并发由 generation 令牌保护：旧 run 的任务体 settle 时不得清掉新 run 的锁、不得覆盖
 * 新 run 的终态/遥测。跨重启的遗留状态由 JobLedger.reconcile 处理。
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
 * 后台调度运行期遥测（PR #125 复审 P3 可观测性）：进程内累计、随任务运行增长。
 * 终态投影写失败只 warn 不重试，因此必须留下计数与固定日志关键字，否则排障时看不到。
 */
export interface BackgroundTelemetry {
  /** 终态投影（done/failed）写失败次数；固定日志关键字 `[bg] terminal persist failed` */
  readonly terminalPersistFailures: number;
  /** 看门狗触发次数（含任务恰好已完成、因而未 abort 的触发） */
  readonly watchdogFires: number;
  /** 强制接管次数：stall 后旧任务体未 settle 就允许同房间新 run 拿到锁 */
  readonly takeovers: number;
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
  /** 单调递增的世代令牌：只有 active.get(roomId) === entry 的当前世代才能写锁/终态/通知 waiters */
  generation: number;
  waiters: Set<(idle: boolean) => void>;
  /** run() 已返回并写完终态后 resolve；abortAll 只等它，不等任务体 settle */
  runFinished: Promise<void>;
  markRunFinished: () => void;
}

type Settled =
  | { status: "done"; value: Record<string, unknown> | void }
  | { status: "error"; error: string }
  | { status: "stalled" | "aborted" };

/**
 * 终态投影写入的"只写一次"闸门（PR #125 复审 P3）：
 * - `writing` 表示已有一次写入在进行，并发收尾者必须直接跳过，不能提前把 `written` 置真冒充"已写完"；
 * - `written` 只在写入真正结束（含失败）后置位；写失败不再重试——投影写失败只 warn，重试反而可能
 *   让迟到的 done 覆盖已写的 failed，产生结果与落盘错位。
 */
interface TerminalGate {
  writing: boolean;
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
  private terminalPersistFailures = 0;
  private watchdogFires = 0;
  private takeovers = 0;
  private generationCounter = 0;

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

  /** 运行期遥测快照（bootstrap 通过 App.backgroundTelemetry 暴露给运维/测试） */
  get telemetry(): BackgroundTelemetry {
    return {
      terminalPersistFailures: this.terminalPersistFailures,
      watchdogFires: this.watchdogFires,
      takeovers: this.takeovers,
    };
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
    if (gate.writing || gate.written) return;
    gate.writing = true;
    try {
      if (!this.ledger) return;
      await this.ledger.transition(roomId, jobId, patch);
    } catch (e) {
      // 终态写失败只 warn、不重试（重试可能让迟到的 done 覆盖已写的 failed）；但必须可观测：
      // 固定关键字 + 进程内计数，bootstrap 经 App.backgroundTelemetry 暴露。
      this.terminalPersistFailures += 1;
      console.warn(`[bg] terminal persist failed room=${roomId} job=${jobId} status=${patch.status}:`, errorText(e));
    } finally {
      gate.writing = false;
      gate.written = true;
    }
  }

  /**
   * 任务体 settle 后的收尾：仅当代际令牌仍是当前 run 时才释放锁、唤醒 waitForIdle。
   * 被 stall 接管的旧 run settle 时 active 已换成新 entry，这里直接跳过——不会丢新锁。
   */
  private release(roomId: string, entry: Entry): void {
    if (this.active.get(roomId) !== entry) return;
    this.active.delete(roomId);
    for (const w of [...entry.waiters]) w(true);
    entry.waiters.clear();
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
      generation: ++this.generationCounter,
      waiters: new Set(),
      runFinished,
      markRunFinished,
    };
    this.active.set(roomId, entry);
    const stallMs = Math.max(1, opts.stallMs ?? this.defaultStallMs);
    const gate: TerminalGate = { writing: false, written: false };

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
      let taskSettled = false;
      let resolveAbort!: (status: "stalled" | "aborted") => void;
      const aborted = new Promise<"stalled" | "aborted">((resolve) => {
        resolveAbort = resolve;
      });
      // 任务体一旦 settle，本次 run 的结果就以任务为准（done/error）：abort/stall 只能在任务
      // 未 settle 时赢。否则慢终态写入期间看门狗触发会出现「run 报 stalled、任务其实已完成、
      // 最终落盘 done」的结果与投影错位（PR #125 复审 P3）。
      const onAbort = () => {
        if (!taskSettled) resolveAbort(stalled ? "stalled" : "aborted");
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        this.watchdogFires += 1;
        if (taskSettled) return;
        stalled = true;
        // 强制接管：旧任务体即使不响应协作式 abort，也必须把锁让给同房间的下一次 run。
        // 代际令牌保证旧 run 的迟到 settle 不能清掉新锁或覆盖新 run 的终态/遥测。
        if (this.active.get(roomId) === entry) {
          this.active.delete(roomId);
          this.takeovers += 1;
          for (const w of [...entry.waiters]) w(false); // 等"当前 generation"的 waitForIdle 不等旧 run
          entry.waiters.clear();
        }
        controller.abort(`stalled: 超过 ${stallMs}ms 未完成`);
      }, stallMs);
      timer.unref?.();

      const taskResult = (async (): Promise<Settled> => {
        try {
          const value = await task({ signal: controller.signal, jobId });
          return { status: "done", value };
        } catch (e) {
          return { status: "error", error: errorText(e) };
        } finally {
          taskSettled = true;
        }
      })();

      // 任务体 settle 后的补收尾。stalled/aborted 时 run 已先行返回，这里写终态（gate 保证
      // 只写一次）+ 仅在仍是当前 generation 时释放锁。被接管的旧 run 不碰新锁与新状态。
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

      // abortAll 可能发生在监听器注册之前：信号已 abort 时补一次分发（任务已 settle 则不算）
      if (!taskSettled && controller.signal.aborted) resolveAbort(stalled ? "stalled" : "aborted");

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
      // aborted：shutdown 触发时任务体可能还在跑，锁由 finished 在真正 settle 后释放
      // （关停语义不变：abortAll 不等任务体 settle）。
      await this.writeTerminal(roomId, jobId, gate, { status: "failed", lastError: ABORTED_ERROR });
      return { ok: false, reason: "error", error: ABORTED_ERROR, jobId };
    } finally {
      entry.markRunFinished();
    }
  }

  /**
   * 等当前 generation 空闲：锁被 stall 接管后，老的 waitForIdle 等不到旧任务体 settle——
   * 看门狗会让这些等待者以 false 立即返回（需重新检查/重试），新 run 的等待者挂在新 entry 上。
   */
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
   * 注意：abort ≠ 接管——shutdown 不释放锁，进程即将退出，由重启后的 reconcile 收拾遗留。
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
