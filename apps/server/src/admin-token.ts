/**
 * 管理员令牌校验（docs/03 §5.2.9）：
 *   - 常量时间比较：先 sha256 定长再 timingSafeEqual，避免 `===` 短路泄露前缀；
 *   - 失败限流：同一来源 IP 在窗口内连续失败超限后返回 429，挡住离线爆破。
 * 与 map.drafts.ts 的既有写法同口径；所有 admin-token 入口共用同一个实例。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { RateLimiter } from "./rate-limit.ts";

/** 空 token 一律不匹配（未配置 token ≠ 任意空头可通过） */
export function tokenEquals(given: string, expected: string): boolean {
  if (!given || !expected) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export interface TokenVerdict {
  ok: boolean;
  /** 失败次数超限：调用方应返回 429，而不是继续把请求当成"未授权" */
  blocked?: boolean;
  retryAfterMs?: number;
}

export class AdminTokenGate {
  private readonly failures: RateLimiter;

  constructor(
    private readonly expected: string,
    private readonly maxFailures = 10,
    windowMs = 60_000,
  ) {
    this.failures = new RateLimiter(maxFailures, windowMs);
  }

  /** token 为请求头原值；ip 用于失败计数（反向代理下需 GALGAME_TRUST_PROXY=1 才准） */
  check(token: string, ip: string): TokenVerdict {
    const key = ip || "unknown";
    // 已达上限：连"这次猜对没有"都不告诉调用方，直接 429
    if (this.failures.count(key) >= this.maxFailures) {
      const decision = this.failures.hit(key);
      return { ok: false, blocked: true, retryAfterMs: decision.retryAfterMs };
    }
    if (token && tokenEquals(token, this.expected)) {
      this.failures.reset(key);
      return { ok: true };
    }
    const decision = this.failures.hit(key);
    return { ok: false, blocked: !decision.allowed, retryAfterMs: decision.retryAfterMs };
  }
}
