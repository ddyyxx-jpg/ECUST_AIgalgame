import { describe, expect, it } from "vitest";
import { decideTravel, nextPending, stepEntryDwell, stepExitDwell, travelIntent, type DwellState } from "./map-autoenter.ts";

const NONE: DwellState = { id: "", since: 0, fired: false };
const DWELL_MS = 1500;

describe("stepEntryDwell · 大地图靠近入口自动进室内（#151 P1-1）", () => {
  it("回合 streaming（busy）时即使站满时长也不触发", () => {
    const step = stepEntryDwell({
      busy: true,
      armed: true,
      dwell: { id: "loc_library", since: 0, fired: false },
      bestEntryId: "loc_library",
      now: DWELL_MS * 3,
      dwellMs: DWELL_MS,
    });
    expect(step.fire).toBe(false);
    expect(step.pct).toBe(0);
    expect(step.dwell.since).toBe(0);
  });

  it("busy 结束后仍站在入口：重新计时，满时长触发一次", () => {
    // busy 期间计时被清零，但武装状态保留
    const during = stepEntryDwell({ busy: true, armed: true, dwell: NONE, bestEntryId: "loc_library", now: 10_000, dwellMs: DWELL_MS });
    expect(during.armed).toBe(true);
    const start = stepEntryDwell({ busy: false, armed: during.armed, dwell: during.dwell, bestEntryId: "loc_library", now: 11_000, dwellMs: DWELL_MS });
    expect(start.fire).toBe(false);
    expect(start.dwell.since).toBe(11_000);
    const half = stepEntryDwell({ busy: false, armed: start.armed, dwell: start.dwell, bestEntryId: "loc_library", now: 11_600, dwellMs: DWELL_MS });
    expect(half.fire).toBe(false);
    expect(half.pct).toBeCloseTo(0.4, 5);
    const done = stepEntryDwell({ busy: false, armed: half.armed, dwell: half.dwell, bestEntryId: "loc_library", now: 12_600, dwellMs: DWELL_MS });
    expect(done.fire).toBe(true);
    expect(done.armed).toBe(false);
    // 已触发过：原地不动不会再进第二次
    const again = stepEntryDwell({ busy: false, armed: done.armed, dwell: done.dwell, bestEntryId: "loc_library", now: 13_000, dwellMs: DWELL_MS });
    expect(again.fire).toBe(false);
  });

  it("离开范围后重新武装，下次靠近才会再触发", () => {
    const left = stepEntryDwell({ busy: false, armed: false, dwell: { id: "loc_library", since: 0, fired: true }, bestEntryId: null, now: 20_000, dwellMs: DWELL_MS });
    expect(left.armed).toBe(true);
    expect(left.dwell).toEqual(NONE);
    const back = stepEntryDwell({ busy: false, armed: left.armed, dwell: left.dwell, bestEntryId: "loc_library", now: 20_100, dwellMs: DWELL_MS });
    expect(back.dwell.since).toBe(20_100);
  });

  it("busy 时不在任何入口：仍然重新武装（回合结束后靠近可直接计时）", () => {
    const step = stepEntryDwell({ busy: true, armed: false, dwell: NONE, bestEntryId: null, now: 1, dwellMs: DWELL_MS });
    expect(step.armed).toBe(true);
  });
});

describe("travelIntent · 靠近点位静默 travel（#151 P1-1）", () => {
  it("只在换了场景且没发过时放行", () => {
    expect(travelIntent({ sceneId: "loc_lib", playerLocId: "loc_canteen", enteredId: "" })).toBe(true);
    expect(travelIntent({ sceneId: "loc_lib", playerLocId: "loc_lib", enteredId: "" })).toBe(false);
    expect(travelIntent({ sceneId: "loc_lib", playerLocId: "loc_canteen", enteredId: "loc_lib" })).toBe(false);
    expect(travelIntent({ sceneId: null, playerLocId: "loc_canteen", enteredId: "" })).toBe(false);
  });
});

describe("stepExitDwell · 室内站出口自动离开（#151 P1-2）", () => {
  it("回合 streaming 中站满 1.5s 也不退出", () => {
    const start = stepExitDwell({ busy: false, near: true, armed: true, since: 0, fired: false, now: 1_000, dwellMs: DWELL_MS });
    expect(start.since).toBe(1_000);
    const busyNow = stepExitDwell({ busy: true, near: true, armed: start.armed, since: start.since, fired: start.fired, now: 5_000, dwellMs: DWELL_MS });
    expect(busyNow.fire).toBe(false);
    expect(busyNow.since).toBe(0);
    expect(busyNow.armed).toBe(true);
  });

  it("回合结束后重新计时，满时长退出一次", () => {
    const start = stepExitDwell({ busy: false, near: true, armed: true, since: 0, fired: false, now: 6_000, dwellMs: DWELL_MS });
    expect(start.since).toBe(6_000);
    const done = stepExitDwell({ busy: false, near: true, armed: start.armed, since: start.since, fired: start.fired, now: 7_600, dwellMs: DWELL_MS });
    expect(done.fire).toBe(true);
    expect(done.armed).toBe(false);
    const again = stepExitDwell({ busy: false, near: true, armed: done.armed, since: done.since, fired: done.fired, now: 9_000, dwellMs: DWELL_MS });
    expect(again.fire).toBe(false);
  });

  it("离开出口范围后重新武装", () => {
    const left = stepExitDwell({ busy: false, near: false, armed: false, since: 1_000, fired: true, now: 2_000, dwellMs: DWELL_MS });
    expect(left.armed).toBe(true);
    expect(left.since).toBe(0);
    expect(left.fired).toBe(false);
  });
});

describe("decideTravel · 被 busy 挡下的点位在回合结束后补发（PR #152 复审 P3-2）", () => {
  const base = { sceneId: "loc_lib", playerLocId: "loc_canteen", enteredId: "" };

  it("刚进范围且不忙 → go", () => {
    expect(decideTravel({ ...base, busy: false, enteredRange: true, pendingId: "" })).toBe("go");
  });

  it("busy 时进范围 → defer（不发请求，但要记住点位）", () => {
    expect(decideTravel({ ...base, busy: true, enteredRange: true, pendingId: "" })).toBe("defer");
  });

  it("回合结束后原地不动（enteredRange=false）也能补发一次", () => {
    expect(decideTravel({ ...base, busy: false, enteredRange: false, pendingId: "loc_lib" })).toBe("go");
    // 补发后 pending 被清空，再站多久都不会重发
    expect(decideTravel({ ...base, busy: false, enteredRange: false, pendingId: "" })).toBe("skip");
  });

  it("不是被挡下的点位 → 不因 pending 其它点位而发", () => {
    expect(decideTravel({ ...base, busy: false, enteredRange: false, pendingId: "loc_lab" })).toBe("skip");
  });

  it("同场景 / 已发过 / 传送到别处 → skip（即使 busy）", () => {
    expect(decideTravel({ ...base, playerLocId: "loc_lib", busy: false, enteredRange: true, pendingId: "" })).toBe("skip");
    expect(decideTravel({ ...base, enteredId: "loc_lib", busy: true, enteredRange: true, pendingId: "" })).toBe("skip");
    expect(decideTravel({ ...base, sceneId: null, busy: false, enteredRange: true, pendingId: "" })).toBe("skip");
  });

  it("busy 只影响决定，不影响 travelIntent 本身", () => {
    expect(travelIntent(base)).toBe(true);
    expect(decideTravel({ ...base, busy: true, enteredRange: true, pendingId: "" })).toBe("defer");
    expect(decideTravel({ ...base, busy: false, enteredRange: true, pendingId: "" })).toBe("go");
  });
});

describe("nextPending · 待补点位的落账（PR #152 复审：skip 清 pending 也要可测）", () => {
  it("defer 记住本拍点位", () => {
    expect(nextPending("", "loc_lib", "defer")).toBe("loc_lib");
  });

  it("go 清空（传完不需要再补）", () => {
    expect(nextPending("loc_lib", "loc_lib", "go")).toBe("");
  });

  it("skip 且待补的就是本拍点位 → 清（手动 travel 到过 A 后不再回弹）", () => {
    expect(nextPending("loc_lib", "loc_lib", "skip")).toBe("");
  });

  it("skip 但待补的是别的点位 → 保留（只看当前点位）", () => {
    expect(nextPending("loc_lab", "loc_lib", "skip")).toBe("loc_lab");
  });
});
