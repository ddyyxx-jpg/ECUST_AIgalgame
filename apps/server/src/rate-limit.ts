/**
 * 进程内限流器（收敛稿 B1）：固定窗口计数 + 容量上限/定期清理。
 * 组合策略（账号渐进延迟 + 全局上限 + 邀请尝试限制 + IP 粗筛）由调用方按不同 key 复用本类。
 * 不长期占住连接：渐进延迟由调用方 capped sleep 实现，这里只计数。
 */
export interface RateDecision {
  allowed: boolean;
  count: number;
  retryAfterMs: number;
}

export class RateLimiter {
  private readonly map = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly capacity = 10_000,
  ) {}

  /** 记一次尝试；超过 max 则拒绝。成功路径可调 reset 清零。 */
  hit(key: string): RateDecision {
    const now = Date.now();
    this.evictIfNeeded(now);
    const current = this.map.get(key);
    if (!current || current.resetAt <= now) {
      this.map.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, count: 1, retryAfterMs: 0 };
    }
    current.count += 1;
    if (current.count > this.max) {
      return { allowed: false, count: current.count, retryAfterMs: current.resetAt - now };
    }
    return { allowed: true, count: current.count, retryAfterMs: 0 };
  }

  /** 只读当前计数（用于渐进延迟），不增加计数 */
  count(key: string): number {
    const current = this.map.get(key);
    if (!current || current.resetAt <= Date.now()) return 0;
    return current.count;
  }

  reset(key: string): void {
    this.map.delete(key);
  }

  private evictIfNeeded(now: number): void {
    if (this.map.size < this.capacity) return;
    for (const [key, value] of this.map) {
      if (value.resetAt <= now) this.map.delete(key);
    }
    // 仍超容量：按插入序丢最旧（Map 迭代序即插入序），防止内存无限增长
    while (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

/** 账号级渐进延迟：失败越多等越久，封顶 2s（不长期占住连接） */
export function progressiveDelayMs(failureCount: number): number {
  return Math.min(Math.max(0, failureCount - 1) * 300, 2000);
}

export function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}