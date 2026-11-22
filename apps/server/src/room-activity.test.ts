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
