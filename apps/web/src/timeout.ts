/**
 * 整体 deadline + AbortSignal 的组合工具。
 *
 * 单纯给每个 fetch 加超时不够：多次串行请求累加起来仍然可能永久挂住一屏 busy，
 * 所以一次进房/重进房共享一个 8s 的 deadline，超时时同时中止底层 fetch。
 * 超时原因写在 signal.reason（TimeoutError）上，让 UI 能区分「超时」和「切房/登出 abort」。
 */
export class TimeoutError extends Error {
  constructor(message = "装载超时") {
    super(message);
    this.name = "TimeoutError";
  }
}

/** 真实 deadline（含测试）默认 8s：单次请求 4s + 串行重试余量；常量带注释便于审阅 */
export const ROOM_LOAD_DEADLINE_MS = 8_000;

export interface Deadline {
  signal: AbortSignal;
  /** 清理定时器：无论成功/失败/被作废都要在 finally 调用 */
  clear: () => void;
  /** 主动作废（如 dispose/切房），让在途 fetch 立刻停下 */
  abort: () => void;
}

export function createDeadline(
  ms: number = ROOM_LOAD_DEADLINE_MS,
  parent?: AbortSignal,
): Deadline {
  const controller = new AbortController();
  const abortParent = () => controller.abort(parent?.reason);
  const timer = setTimeout(() => controller.abort(new TimeoutError()), ms);
  if (parent?.aborted) abortParent();
  else parent?.addEventListener("abort", abortParent, { once: true });
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortParent);
    },
    // 用 AbortError（不是 TimeoutError）作废：UI 可区分「主动切房/注销」与「装载超时」。
    abort: () => controller.abort(new DOMException("aborted", "AbortError")),
  };
}

export function throwIfTimedOut(signal: AbortSignal): void {
  if (signal.aborted && signal.reason instanceof TimeoutError) throw signal.reason;
}

/**
 * 两个来源任一 abort 都让下游 fetch 停下：切房/登出用 scope 的 signal，
 * 前台恢复的 deadline 用注入的 signal；不依赖运行时是否实现 AbortSignal.any。
 */
export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return new AbortController().signal;
  if (present.length === 1) return present[0]!;
  const c = new AbortController();
  for (const source of present) {
    if (source.aborted) c.abort(source.reason);
    else source.addEventListener("abort", () => c.abort(source.reason), { once: true });
  }
  return c.signal;
}
