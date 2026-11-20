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
 *
 * 输入草稿不是门槛（PR #126 审查 P2）：重进房会在 reset 前捕获、成功后恢复草稿，
 * 不需要「输入中不打断」的保护；旧实现反而让带草稿的玩家永远等不到恢复。
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
  | "too-soon"
  | "throttled";

export interface SessionSyncDecision {
  resync: boolean;
  reason: SessionSyncReason;
}

/**
 * 离开至少 5s 才重拉：低于此值视为 alt-tab 抖动（visibilitychange 与 focus 常成对触发），
 * 一次全量拉取不便宜，快速切标签不值得。online 触发不受这个下限限制。
 */
export const DEFAULT_MIN_AWAY_MS = 5000;
/**
 * 两次重进房的最小间隔 30s：SSE 正常时按 30s 一次全量对齐已足够，也避免多个信号
 * （visible/focus/online）叠加成请求风暴。失败同样计入一次同步（见 session-wiring），
 * 否则断网时 focus/online 会反复触发全量拉取。
 */
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
  if (input.trigger === "foreground" && input.awayMs < minAwayMs) return { resync: false, reason: "too-soon" };
  if (input.sinceLastSyncMs < minIntervalMs) return { resync: false, reason: "throttled" };
  return { resync: true, reason: "ok" };
}
