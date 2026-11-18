/**
 * 管理员令牌校验（复审 P1）：常量时间比较 + 失败限流。
 * 比较走 sha256 摘要 + timingSafeEqual（长度差异不提前返回）；这里验证判定行为与限流窗口。
 */
import { describe, expect, it } from "vitest";
import { AdminTokenGate, tokenEquals } from "./admin-token.ts";

const TOKEN = "test-token-0123456789abcdef";

describe("tokenEquals", () => {
  it("完全相等才放行；近似值/前缀/大小写/空值一律拒绝", () => {
    expect(tokenEquals(TOKEN, TOKEN)).toBe(true);
    expect(tokenEquals(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenEquals(TOKEN.slice(0, -1) + "0", TOKEN)).toBe(false);
    expect(tokenEquals(TOKEN.toUpperCase(), TOKEN)).toBe(false);
    expect(tokenEquals("", TOKEN)).toBe(false);
    expect(tokenEquals(TOKEN, "")).toBe(false);
  });
});

describe("AdminTokenGate 失败限流", () => {
  it("连续失败到阈值后锁定：窗口内正确令牌也 429；窗口过后恢复", async () => {
    const gate = new AdminTokenGate(TOKEN, 2, 60);
    expect(gate.check("bad-1", "1.1.1.1").ok).toBe(false);
    expect(gate.check("bad-2", "1.1.1.1").ok).toBe(false);
    const blocked = gate.check(TOKEN, "1.1.1.1");
    expect(blocked.ok).toBe(false);
    expect(blocked.blocked).toBe(true);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(gate.check(TOKEN, "1.1.1.1").ok).toBe(true);
  });

  it("成功一次清零该 IP 的失败计数；不同 IP 互不影响", () => {
    const gate = new AdminTokenGate(TOKEN, 3, 60_000);
    gate.check("bad-1", "ip-a");
    gate.check("bad-2", "ip-a");
    expect(gate.check(TOKEN, "ip-a").ok).toBe(true);
    expect(gate.check("bad-3", "ip-a").blocked).not.toBe(true);
    expect(gate.check("bad-1", "ip-b").blocked).not.toBe(true);
  });
});
