import { describe, expect, it } from "vitest";
import { RoomActivity, RoomBusyError } from "./room-activity.ts";

describe("RoomActivity", () => {
  it("进入/释放成对计数，释放幂等", () => {
    const activity = new RoomActivity();
    const leave = activity.enter("room_a");
    expect(activity.isBusy("room_a")).toBe(true);
    expect(activity.isBusy("room_b")).toBe(false);
    leave();
    leave();
    expect(activity.isBusy("room_a")).toBe(false);
  });

  it("tryAcquire 在忙时返回 null，空闲时与 enter 等价", () => {
    const activity = new RoomActivity();
    const first = activity.tryAcquire("room_a");
    expect(first).not.toBeNull();
    expect(activity.tryAcquire("room_a")).toBeNull();
    first?.();
    const second = activity.tryAcquire("room_a");
    expect(second).not.toBeNull();
    second?.();
  });

  it("acquire 会等当前活动结束再进入", async () => {
    const activity = new RoomActivity();
    const leave = activity.enter("room_a");
    let acquired = false;
    const pending = activity.acquire("room_a").then((release) => {
      acquired = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(acquired).toBe(false);
    leave();
    const release = await pending;
    expect(acquired).toBe(true);
    expect(activity.isBusy("room_a")).toBe(true);
    release();
    expect(activity.isBusy("room_a")).toBe(false);
  });

  it("acquire 超时会抛 RoomBusyError，且不会偷偷进入", async () => {
    const activity = new RoomActivity();
    const leave = activity.enter("room_a");
    await expect(activity.acquire("room_a", 10)).rejects.toBeInstanceOf(RoomBusyError);
    expect(activity.isBusy("room_a")).toBe(true);
    leave();
  });

  it("acquire 可以被 AbortSignal 取消", async () => {
    const activity = new RoomActivity();
    const leave = activity.enter("room_a");
    const ac = new AbortController();
    const pending = activity.acquire("room_a", 30_000, ac.signal);
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(RoomBusyError);
    leave();
  });

  it("释放时唤醒等待者（不是 5ms 轮询），多人排队时只有一个拿到", async () => {
    const activity = new RoomActivity();
    const leave = activity.enter("room_a");
    let firstOrder = 0;
    const a = activity.acquire("room_a").then((r) => { firstOrder += 1; return r; });
    const b = activity.acquire("room_a").then((r) => { firstOrder += 1; return r; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(firstOrder).toBe(0);
    leave();
    const ra = await a;
    // 同一个 tick 里两个等待者都被唤醒，但只有一个能真正进入；另一个继续等。
    expect(activity.isBusy("room_a")).toBe(true);
    ra();
    const rb = await b;
    rb();
    expect(activity.isBusy("room_a")).toBe(false);
  });

  it("等待者超时后不残留在队列里（房间随后释放也不重复唤醒）", async () => {
    const activity = new RoomActivity();
    const leave = activity.enter("room_a");
    await expect(activity.acquire("room_a", 5)).rejects.toBeInstanceOf(RoomBusyError);
    const release = activity.tryAcquire("room_a");
    expect(release).toBeNull();
    leave();
    const ok = activity.tryAcquire("room_a");
    expect(ok).not.toBeNull();
    ok?.();
  });

  it("并发进入时最后一个释放才清空", () => {
    const activity = new RoomActivity();
    const first = activity.enter("room_a");
    const second = activity.enter("room_a");
    first();
    expect(activity.isBusy("room_a")).toBe(true);
    second();
    expect(activity.isBusy("room_a")).toBe(false);
  });
});
