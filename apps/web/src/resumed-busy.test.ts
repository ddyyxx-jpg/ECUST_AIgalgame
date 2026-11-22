import { describe, expect, it } from "vitest";
import { holdResumedBusy } from "./resumed-busy.ts";

describe("holdResumedBusy（resumed 重进房占位 busy）", () => {
  it("resumed：进入即占位，仍是当前调用时归还", () => {
    const busy: boolean[] = [];
    const hold = holdResumedBusy({ resumed: true, setBusy: (v) => busy.push(v), isCurrent: () => true });
    expect(busy).toEqual([true]);
    hold.release();
    expect(busy).toEqual([true, false]);
  });

  it("非 resumed（普通进房/换房）：不占位也不归还", () => {
    const busy: boolean[] = [];
    const hold = holdResumedBusy({ resumed: false, setBusy: (v) => busy.push(v), isCurrent: () => true });
    expect(busy).toEqual([]);
    hold.release();
    expect(busy).toEqual([]);
  });

  it("旧调用被新调用作废后失败：release 不放开新调用占的 busy", () => {
    const busy: boolean[] = [];
    let version = 1;
    const setBusy = (v: boolean) => busy.push(v);
    const oldCall = holdResumedBusy({ resumed: true, setBusy, isCurrent: () => version === 1 });
    version = 2; // 新一次 enterRoom(resumed) 让旧调用作废
    const newCall = holdResumedBusy({ resumed: true, setBusy, isCurrent: () => version === 2 });
    expect(busy).toEqual([true, true]);
    oldCall.release(); // 旧调用 finally：不许归还
    expect(busy).toEqual([true, true]);
    expect(busy.at(-1)).toBe(true); // 新调用仍在途，busy 必须保持占位
    newCall.release();
    expect(busy.at(-1)).toBe(false);
  });
});
