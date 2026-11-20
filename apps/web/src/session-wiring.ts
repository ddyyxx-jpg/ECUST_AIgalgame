/**
 * 前台恢复接线（PR-3；PR #126 审查 P1-1 从 App.tsx 的 useEffect 里抽出）。
 *
 * 为什么单独成模块：真正容易出错的不是纯函数决策，而是接线本身——事件注册/注销、
 * visibilitychange 与 focus 成对触发的防重入、离开时长的记账、失败提示。这些逻辑
 * 留在 React useEffect 里时 node 测试碰不到（项目不引 jsdom）。现在 DOM 与 React
 * 侧全部依赖注入，用 fake 事件源就能在 node 里跑完整链路：
 * 真实监听 → decideSessionSync → enterRoom / onNotice。
 *
 * 与 App 的分工：本模块只回答「这次要不要重进房、失败后还能不能重试」；画面状态
 * 的保留（成功后 reset/切换、失败时不动旧画面与草稿）在 enterRoom 内部完成。
 */
import { decideSessionSync } from "./session-signal.ts";
import type { SessionSyncDecision, SessionSyncTrigger } from "./session-signal.ts";

/** 事件挂载点：可见性挂 document，focus/online 挂 window */
export type ResyncEventTarget = "document" | "window";
export type ResyncEventType = "visibilitychange" | "focus" | "online";

export interface SessionResyncDeps {
  /** 当前时刻；测试注入假时钟 */
  now: () => number;
  /** 注册事件监听并返回取消函数（App 用 document/window；测试用 fake emitter） */
  on: (target: ResyncEventTarget, type: ResyncEventType, handler: () => void) => () => void;
  isVisible: () => boolean;
  isOnline: () => boolean;
  screen: () => "title" | "game";
  roomId: () => string;
  busy: () => boolean;
  /** 重走一次「权威状态 + 历史 + 事件回放」；失败 reject（App 保证失败时不 reset） */
  enterRoom: (roomId: string) => Promise<void>;
  /** 恢复失败提示（复用 eventsNotice 降级提示位）；失败同样计入一次同步 */
  onNotice: (error: unknown) => void;
  minAwayMs?: number;
  minIntervalMs?: number;
}

export interface SessionResync {
  /**
   * 本地信号入口。返回本次决策（便于 App/测试定位被拒原因）；防重入期间返回 null。
   * 挂到 DOM 的监听由 createSessionResync 内部注册，App 只负责注入真实 DOM。
   */
  handle: (trigger: SessionSyncTrigger) => SessionSyncDecision | null;
  /** 注销全部监听；幂等，在途 enterRoom 的后续回调也不再触发 onNotice */
  dispose: () => void;
}

export function createSessionResync(deps: SessionResyncDeps): SessionResync {
  // 页面可能在后台挂载（还没有 hidden 事件）：直接把当前时刻当作隐藏起点，
  // 否则第一次回前台会因没有起点被算成「刚离开」（awayMs=0）而错过恢复。
  let hiddenSince: number | null = deps.isVisible() ? null : deps.now();
  /** 上次真正发起重进房的时刻；0 = 还没同步过 */
  let lastSyncAt = 0;
  let resyncing = false;
  let disposed = false;
  const offs: Array<() => void> = [];

  const attempt = (trigger: SessionSyncTrigger): SessionSyncDecision | null => {
    if (disposed || resyncing) return null;
    const now = deps.now();
    const awayMs = hiddenSince === null ? 0 : now - hiddenSince;
    const decision = decideSessionSync({
      trigger,
      visible: deps.isVisible(),
      online: deps.isOnline(),
      screen: deps.screen(),
      roomId: deps.roomId(),
      busy: deps.busy(),
      awayMs,
      sinceLastSyncMs: now - lastSyncAt,
      minAwayMs: deps.minAwayMs,
      minIntervalMs: deps.minIntervalMs,
    });
    if (!decision.resync) return decision;

    // 只有真正发起重进房才清隐藏起点（PR #126 审查 P2）：如果像旧实现那样在 attempt
    // 之前就清，被 busy/节流挡掉的这次之后，成对触发的 focus 会拿到 awayMs=0，
    // 被 too-soon 永久挡死。失败时保留 lastSyncAt 节流、不再保留隐藏起点。
    hiddenSince = null;
    // 先记时刻再发请求：失败也按一次同步计，避免断网时 focus/online 反复重拉
    lastSyncAt = now;
    resyncing = true;
    const roomId = deps.roomId();
    void (async () => {
      try {
        await deps.enterRoom(roomId);
      } catch (error) {
        // 失败不抛：交给 App 的提示位；旧画面、草稿与可重试状态由 App 保留
        if (!disposed) deps.onNotice(error);
      } finally {
        resyncing = false;
      }
    })();
    return decision;
  };

  const onVisibility = () => {
    if (!deps.isVisible()) {
      hiddenSince = deps.now();
      return;
    }
    attempt("foreground");
  };

  offs.push(deps.on("document", "visibilitychange", onVisibility));
  offs.push(
    deps.on("window", "focus", () => {
      attempt("foreground");
    }),
  );
  offs.push(
    deps.on("window", "online", () => {
      attempt("online");
    }),
  );

  return {
    handle: (trigger) => attempt(trigger),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const off of offs.splice(0)) off();
    },
  };
}
