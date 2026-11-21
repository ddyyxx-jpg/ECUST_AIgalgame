import { describe, expect, it, vi } from "vitest";
import { loadRoomThenReset } from "./room-enter.ts";

/** 记录「谁先被调用」的顺序数组：reset 出现在 fetch 之前即失败 */
interface Calls {
  order: string[];
  fetchState: ReturnType<typeof vi.fn>;
  fetchHistory: ReturnType<typeof vi.fn>;
  capture: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
}

function makeCalls(overrides: {
  state?: () => Promise<{ room: string }>;
  history?: () => Promise<{ lines: string[] }>;
  current?: () => boolean;
} = {}): Calls {
  const order: string[] = [];
  const fetchState = vi.fn(async () => {
    order.push("fetchState");
    return (overrides.state ?? (async () => ({ room: "room_1" })))();
  });
  const fetchHistory = vi.fn(async () => {
    order.push("fetchHistory");
    return (overrides.history ?? (async () => ({ lines: ["l1"] })))();
  });
  const capture = vi.fn((state: { room: string }, history: { lines: string[] }) => {
    order.push("capture");
    return { room: state.room, lines: history.lines };
  });
  const reset = vi.fn(() => {
    order.push("reset");
  });
  const restore = vi.fn((_captured: { room: string; lines: string[] }) => {
    order.push("restore");
  });
  return {
    order,
    fetchState,
    fetchHistory,
    capture,
    reset,
    restore,
  };
}

function run(calls: Calls, current: () => boolean = () => true) {
  return loadRoomThenReset({
    fetchState: calls.fetchState,
    fetchHistory: calls.fetchHistory,
    isCurrent: current,
    capture: calls.capture,
    reset: calls.reset,
    restore: calls.restore,
  });
}

describe("loadRoomThenReset（进房顺序：先拉数据、成功后才 reset）", () => {
  it("fetchState 失败：不调用 reset/restore，错误向上抛（旧画面保留）", async () => {
    const calls = makeCalls({
      state: async () => {
        throw new Error("state 拉取失败");
      },
    });
    await expect(run(calls)).rejects.toThrow("state 拉取失败");
    expect(calls.order).toEqual(["fetchState"]);
    expect(calls.reset).not.toHaveBeenCalled();
    expect(calls.restore).not.toHaveBeenCalled();
  });

  it("fetchHistory 失败：不调用 capture/reset/restore（resumed 失败不清屏）", async () => {
    const calls = makeCalls({
      history: async () => {
        throw new Error("history 拉取失败");
      },
    });
    await expect(run(calls)).rejects.toThrow("history 拉取失败");
    expect(calls.order).toEqual(["fetchState", "fetchHistory"]);
    expect(calls.capture).not.toHaveBeenCalled();
    expect(calls.reset).not.toHaveBeenCalled();
    expect(calls.restore).not.toHaveBeenCalled();
  });

  it("两次拉取都成功后：顺序是 fetchState → fetchHistory → capture → reset → restore", async () => {
    const calls = makeCalls();
    const captured = await run(calls);
    expect(calls.order).toEqual(["fetchState", "fetchHistory", "capture", "reset", "restore"]);
    expect(calls.reset).toHaveBeenCalledTimes(1);
    expect(captured).toEqual({ room: "room_1", lines: ["l1"] });
  });

  it("fetchState 之后请求作废（切房/登出）：不拉历史、不 reset，返回 null", async () => {
    const calls = makeCalls();
    let current = true;
    const promise = run(calls, () => current);
    current = false;
    await expect(promise).resolves.toBeNull();
    expect(calls.order).toEqual(["fetchState"]);
    expect(calls.fetchHistory).not.toHaveBeenCalled();
    expect(calls.reset).not.toHaveBeenCalled();
  });

  it("fetchHistory 之后请求作废：不 capture/reset/restore，返回 null", async () => {
    const calls = makeCalls();
    let current = true;
    let resolveHistory!: (value: { lines: string[] }) => void;
    const historyGate = new Promise<{ lines: string[] }>((resolve) => {
      resolveHistory = resolve;
    });
    calls.fetchHistory.mockImplementation(async () => {
      calls.order.push("fetchHistory");
      return historyGate;
    });
    const promise = run(calls, () => current);
    // 等 fetchState 的微任务链走完，此时 helper 已进入 fetchHistory 且被挂起
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.order).toEqual(["fetchState", "fetchHistory"]);
    current = false;
    resolveHistory({ lines: ["l1"] });
    await expect(promise).resolves.toBeNull();
    expect(calls.capture).not.toHaveBeenCalled();
    expect(calls.reset).not.toHaveBeenCalled();
    expect(calls.restore).not.toHaveBeenCalled();
  });
});
