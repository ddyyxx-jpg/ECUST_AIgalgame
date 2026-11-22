/** PR #123 P2：/history 与 /events 共用同一个 limit 边界，NaN/小数/负数夹到 [1,max]。 */
import { describe, expect, it } from "vitest";
import { clampLimit } from "./limit.ts";

describe("clampLimit", () => {
  it("正常值原样返回；小数向下取整；超过 max 夹到 max", () => {
    expect(clampLimit("10", 200)).toBe(10);
    expect(clampLimit(10, 200)).toBe(10);
    expect(clampLimit("3.9", 200)).toBe(3);
    expect(clampLimit(3.9, 200)).toBe(3);
    expect(clampLimit("9999", 200)).toBe(200);
  });

  it("NaN / Infinity / 空值 → fallback；负数 / 0 夹到下限 1，不产生 NaN 响应", () => {
    expect(clampLimit("abc", 200)).toBe(200);
    expect(clampLimit(Number.NaN, 200)).toBe(200);
    expect(clampLimit(Number.POSITIVE_INFINITY, 200)).toBe(200);
    expect(clampLimit("-5", 200)).toBe(1);
    expect(clampLimit("0", 200)).toBe(1);
    expect(clampLimit("   ", 200)).toBe(200);
    expect(clampLimit(undefined, 200)).toBe(200);
    expect(clampLimit(null, 200, 50)).toBe(50);
    expect(clampLimit("", 200, 50)).toBe(50);
  });

  it("fallback 本身越界时也夹到 [1,max]（/events 默认 50，config max 更小的情况）", () => {
    expect(clampLimit(undefined, 5, 50)).toBe(5);
    expect(clampLimit(undefined, 200, -1)).toBe(1);
    expect(clampLimit("2", 5, 50)).toBe(2);
  });
});
