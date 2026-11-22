import { describe, expect, it } from "vitest";
import { shouldAutoTravel, stepEntryDwell, stepExitDwell, type DwellState } from "./map-autoenter.ts";

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

describe("shouldAutoTravel · 靠近点位静默 travel（#151 P1-1）", () => {
  it("busy 期间不发 travel", () => {
    expect(shouldAutoTravel({ busy: true, sceneId: "loc_lib", playerLocId: "loc_canteen", enteredId: "" })).toBe(false);
  });

  it("只在换了场景且没发过时放行", () => {
    expect(shouldAutoTravel({ busy: false, sceneId: "loc_lib", playerLocId: "loc_canteen", enteredId: "" })).toBe(true);
    expect(shouldAutoTravel({ busy: false, sceneId: "loc_lib", playerLocId: "loc_lib", enteredId: "" })).toBe(false);
    expect(shouldAutoTravel({ busy: false, sceneId: "loc_lib", playerLocId: "loc_canteen", enteredId: "loc_lib" })).toBe(false);
    expect(shouldAutoTravel({ busy: false, sceneId: null, playerLocId: "loc_canteen", enteredId: "" })).toBe(false);
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
