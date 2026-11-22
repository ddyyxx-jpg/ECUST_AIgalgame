import { describe, expect, it } from "vitest";
import { TimeoutError } from "./timeout.ts";
import { isTimeoutError } from "./timeout-error.ts";

describe("isTimeoutError（装载 deadline 超时分类）", () => {
  it("只对 deadline 自己抛的 TimeoutError 为真", () => {
    expect(isTimeoutError(new TimeoutError())).toBe(true);
    expect(isTimeoutError(new Error("connection reset"))).toBe(false);
    expect(isTimeoutError(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(isTimeoutError("x")).toBe(false);
  });
});
