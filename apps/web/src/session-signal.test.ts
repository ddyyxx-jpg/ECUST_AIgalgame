import { describe, expect, it } from "vitest";
import { DEFAULT_MIN_AWAY_MS, DEFAULT_MIN_INTERVAL_MS, decideSessionSync } from "./session-signal.ts";
import type { SessionSyncInput } from "./session-signal.ts";

/** 一组合法的「正常前台恢复」输入，各用例只覆盖自己关心的字段 */
function base(over: Partial<SessionSyncInput> = {}): SessionSyncInput {
  return {
    trigger: "foreground",
    visible: true,
    online: true,
    screen: "game",
    roomId: "room_1",
    busy: false,
    awayMs: 60_000,
    sinceLastSyncMs: 120_000,
    ...over,
  };
}

describe("decideSessionSync（前台恢复决策）", () => {
  it("正常前台恢复：离开够久且距上次同步够久 → 重进房", () => {
    expect(decideSessionSync(base())).toEqual({ resync: true, reason: "ok" });
  });

  it("快速切回：离开不足 5s 不重拉，避免 alt-tab 抖动", () => {
    expect(decideSessionSync(base({ awayMs: 1_000 }))).toEqual({ resync: false, reason: "too-soon" });
  });

  it("页面不可见 / 断网：本地信号都不成立，不重拉", () => {
    expect(decideSessionSync(base({ visible: false }))).toEqual({ resync: false, reason: "hidden" });
    expect(decideSessionSync(base({ online: false }))).toEqual({ resync: false, reason: "offline" });
  });

  it("标题页 / 没有房间：没有可重拉的对象", () => {
    expect(decideSessionSync(base({ screen: "title" }))).toEqual({ resync: false, reason: "not-playing" });
    expect(decideSessionSync(base({ roomId: "" }))).toEqual({ resync: false, reason: "no-room" });
  });

  it("回合进行中（busy）不插队重进房", () => {
    expect(decideSessionSync(base({ busy: true }))).toEqual({ resync: false, reason: "busy" });
  });

  it("输入草稿不再是门槛（PR #126 P2）：重进房会保留草稿，决策不读输入状态", () => {
    // 旧实现把 composing 当硬条件，导致带草稿的玩家永远等不到恢复；现在草稿由 App
    // 在 reset 前捕获、成功后恢复。这里显式塞一个旧字段，确认它不参与判定。
    const withDraft = { ...base(), composing: true } as SessionSyncInput;
    expect(decideSessionSync(withDraft)).toEqual({ resync: true, reason: "ok" });
  });

  it("节流：距上次同步不足 30s 不重复全量拉取", () => {
    expect(decideSessionSync(base({ sinceLastSyncMs: 5_000 }))).toEqual({ resync: false, reason: "throttled" });
  });

  it("online 触发绕过离开时长，但仍受 30s 节流", () => {
    expect(decideSessionSync(base({ trigger: "online", awayMs: 0 }))).toEqual({ resync: true, reason: "ok" });
    expect(decideSessionSync(base({ trigger: "online", awayMs: 0, sinceLastSyncMs: 1_000 }))).toEqual({
      resync: false,
      reason: "throttled",
    });
  });

  it("优先级：更靠前的硬条件先于离开时长与节流生效", () => {
    expect(decideSessionSync(base({ visible: false, online: false, busy: true })).reason).toBe("hidden");
    expect(decideSessionSync(base({ busy: true, sinceLastSyncMs: 1_000 })).reason).toBe("busy");
  });

  it("阈值可覆盖（测试与以后调参用）", () => {
    expect(decideSessionSync(base({ awayMs: 1_000, minAwayMs: 0 })).resync).toBe(true);
    expect(decideSessionSync(base({ awayMs: 1_000 })).resync).toBe(false);
    expect(decideSessionSync(base({ sinceLastSyncMs: 20_000, minIntervalMs: 10_000 })).resync).toBe(true);
    expect(decideSessionSync(base({ sinceLastSyncMs: 20_000 })).resync).toBe(false);
  });

  it("默认常量：离开 5s、同步间隔 30s", () => {
    expect(DEFAULT_MIN_AWAY_MS).toBe(5_000);
    expect(DEFAULT_MIN_INTERVAL_MS).toBe(30_000);
    // 默认值确实被使用：差 1ms 卡在阈值上
    expect(decideSessionSync(base({ awayMs: 4_999 })).reason).toBe("too-soon");
    expect(decideSessionSync(base({ awayMs: 5_000 })).reason).toBe("ok");
    expect(decideSessionSync(base({ sinceLastSyncMs: 29_999 })).reason).toBe("throttled");
    expect(decideSessionSync(base({ sinceLastSyncMs: 30_000 })).reason).toBe("ok");
  });
});
