/**
 * BackgroundCycle 的类型与常量（从 background-cycle.ts 拆出，§6 文件 ≤300 行）。
 * 语义说明见 background-cycle.ts 头注与 docs/09 §9。
 */
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

export interface Entry {
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

export type Settled =
  | { status: "done"; value: Record<string, unknown> | void }
  | { status: "error"; error: string }
  | { status: "stalled" | "aborted" };

/**
 * 终态投影写入的"只写一次"闸门（PR #125 复审 P3）：
 * - `writing` 表示已有一次写入在进行，并发收尾者必须直接跳过，不能提前把 `written` 置真冒充"已写完"；
 * - `written` 只在写入真正结束（含失败）后置位；写失败不再重试——投影写失败只 warn，重试反而可能
 *   让迟到的 done 覆盖已写的 failed，产生结果与落盘错位。
 */
export interface TerminalGate {
  writing: boolean;
  written: boolean;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

