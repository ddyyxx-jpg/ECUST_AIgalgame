import { describe, expect, it } from "vitest";
import { ROOM_LOAD_DEADLINE_MS, TimeoutError, createDeadline, throwIfTimedOut } from "./timeout.ts";
import { isTimeoutError } from "./timeout-error.ts";

describe("进房整体 deadline", () => {
  it("默认 8s 常量可审阅", () => {
    expect(ROOM_LOAD_DEADLINE_MS).toBe(8_000);
  });

  it("超时中止 signal、抛 TimeoutError 且可被分类；clear 后父信号作废", async () => {
    const parent = new AbortController();
    const d = createDeadline(5, parent.signal);
    const aborted = await new Promise<unknown>((resolve) => {
      d.signal.addEventListener("abort", () => resolve(d.signal.reason), { once: true });
    });
    expect(aborted).toBeInstanceOf(TimeoutError);
    expect(isTimeoutError(aborted)).toBe(true);
    expect(() => throwIfTimedOut(d.signal)).toThrow(TimeoutError);
    d.clear();
    parent.abort();
    expect(d.signal.aborted).toBe(true);
  });

  it("父信号先作废：signal.reason 不是 TimeoutError，不误报超时", () => {
    const parent = new AbortController();
    const d = createDeadline(100, parent.signal);
    parent.abort(new DOMException("aborted", "AbortError"));
    expect(d.signal.aborted).toBe(true);
    expect(isTimeoutError(d.signal.reason)).toBe(false);
    expect(() => throwIfTimedOut(d.signal)).not.toThrow();
    d.clear();
  });

  it("clear 后定时器不再触发", async () => {
    const d = createDeadline(5);
    d.clear();
    await new Promise((r) => setTimeout(r, 15));
    expect(d.signal.aborted).toBe(false);
  });
});
