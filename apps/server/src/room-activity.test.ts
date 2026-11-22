import { describe, expect, it } from "vitest";
import { RoomActivity } from "./room-activity.ts";

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
