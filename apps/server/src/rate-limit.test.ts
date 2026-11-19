/**
 * 进程内限流器（收敛稿 B1 / PR #19 建议5/6）：固定窗口、容量驱逐、渐进延迟。
 * 断言计数/布尔/延迟数值，不断言文案。
 */
import { describe, expect, it } from "vitest";
import { RateLimiter, progressiveDelayMs, sleep } from "./rate-limit.ts";

describe("RateLimiter", () => {
  it("窗口内允许到 max，超出拒绝并给 retryAfterMs", () => {
    const l = new RateLimiter(2, 60_000);
    expect(l.hit("k")).toMatchObject({ allowed: true, count: 1 });
    expect(l.hit("k")).toMatchObject({ allowed: true, count: 2 });
    const denied = l.hit("k");
    expect(denied.allowed).toBe(false);
    expect(denied.count).toBe(3);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it("count 只读不增；reset 清零", () => {
    const l = new RateLimiter(5, 60_000);
    l.hit("k");
    l.hit("k");
    expect(l.count("k")).toBe(2);
    expect(l.count("k")).toBe(2);
    l.reset("k");
    expect(l.count("k")).toBe(0);
    expect(l.hit("k").count).toBe(1);
  });

  it("窗口过期后重新计数", async () => {
    const l = new RateLimiter(1, 20);
    expect(l.hit("k").count).toBe(1);
    expect(l.hit("k").allowed).toBe(false);
    await sleep(30);
    expect(l.hit("k")).toMatchObject({ allowed: true, count: 1 });
  });

  it("容量上限：超容量按插入序驱逐最旧 key（防内存无限增长）", () => {
    const l = new RateLimiter(100, 60_000, 3);
    l.hit("a");
    l.hit("b");
    l.hit("c");
    l.hit("d"); // 触发驱逐，最旧 a 被丢
    expect(l.count("a")).toBe(0);
    expect(l.count("d")).toBe(1);
  });

  it("不同 key 互不影响", () => {
    const l = new RateLimiter(1, 60_000);
    expect(l.hit("a").allowed).toBe(true);
    expect(l.hit("b").allowed).toBe(true);
    expect(l.hit("a").allowed).toBe(false);
  });
});

describe("progressiveDelayMs", () => {
  it("随失败次数递增并封顶 2s", () => {
    expect(progressiveDelayMs(0)).toBe(0);
    expect(progressiveDelayMs(1)).toBe(0);
    expect(progressiveDelayMs(2)).toBe(300);
    expect(progressiveDelayMs(3)).toBe(600);
    expect(progressiveDelayMs(100)).toBe(2000);
  });
});