/**
 * 前台恢复的「重进房」决策（PR-3，纯函数，不碰 DOM）。
 *
 * 为什么不用 plot.ping：服务端当前没有 plot.ping 的发射点（方案审查中已降级），
 * 前端不能靠一个不存在的心跳判断 SSE 是否还活着；客户端能可靠感知的只有
 * 「我回到了前台」「网络恢复了」这类本地信号。
 *
 * 为什么用「重进房」而不是增量补事件：enterRoom 已经负责「拉权威状态 + 历史 +
 * 事件回放」，复用它一次就能对齐全部投影；若在前端按 seq 自建事件归并，等于把
 * 服务端的归并逻辑复制一份，契约一演进就会出现两套真相。代价是一次全量拉取，
 * 用「离开够久 + 距上次同步够久」把触发频率压到可接受范围。
 */

/** 唤醒来源：前台可见性恢复 / 网络恢复 */
export type SessionSyncTrigger = "foreground" | "online";

export interface SessionSyncInput {
  trigger: SessionSyncTrigger;
  /** document.visibilityState === "visible" */
  visible: boolean;
  /** navigator.onLine */
  online: boolean;
  screen: "title" | "game";
  roomId: string;
  busy: boolean;
  /** 输入框有内容：重进房会清画面，不打断玩家正在打的字 */
  composing: boolean;
  /** 本次从隐藏到可见的时长；不是从隐藏恢复时传 0 */
  awayMs: number;
  /** 距上次成功进房/同步的时长；没同步过传一个很大的数即可 */
  sinceLastSyncMs: number;
  minAwayMs?: number;
  minIntervalMs?: number;
}

/** 不重拉的原因；ok 之外的名字直接对应规则，便于日志与测试定位 */
export type SessionSyncReason =
  | "ok"
  | "hidden"
  | "offline"
  | "not-playing"
  | "no-room"
  | "busy"
  | "composing"
  | "too-soon"
  | "throttled";

export interface SessionSyncDecision {
  resync: boolean;
  reason: SessionSyncReason;
}

/** 快速切标签（<5s）不重拉：避免 alt-tab 抖动带来一串全量请求 */
export const DEFAULT_MIN_AWAY_MS = 5000;
/** 两次同步的最小间隔：SSE 正常时的一次多余全量拉取也要受限 */
export const DEFAULT_MIN_INTERVAL_MS = 30000;

/**
 * 纯决策：顺序即优先级，任一条不满足就返回对应 reason（不抛错）。
 * online 触发绕过 awayMs（断网恢复时玩家可能一直开着页面），但仍受节流约束。
 */
export function decideSessionSync(input: SessionSyncInput): SessionSyncDecision {
  const minAwayMs = input.minAwayMs ?? DEFAULT_MIN_AWAY_MS;
  const minIntervalMs = input.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

  if (!input.visible) return { resync: false, reason: "hidden" };
  if (!input.online) return { resync: false, reason: "offline" };
  if (input.screen !== "game") return { resync: false, reason: "not-playing" };
  if (!input.roomId) return { resync: false, reason: "no-room" };
  if (input.busy) return { resync: false, reason: "busy" };
  if (input.composing) return { resync: false, reason: "composing" };
  if (input.trigger === "foreground" && input.awayMs < minAwayMs) return { resync: false, reason: "too-soon" };
  if (input.sinceLastSyncMs < minIntervalMs) return { resync: false, reason: "throttled" };
  return { resync: true, reason: "ok" };
}
