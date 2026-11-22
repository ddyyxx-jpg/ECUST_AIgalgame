/**
 * 大地图/室内地图「自动进出」的纯判定（PR #148 复审 P1-1/P1-2）。
 *
 * 为什么单拎出来：这两段逻辑原本埋在 rAF/interval 的 probe 闭包里，只有对着真 DOM
 * 才能跑——而 bug 恰恰是「busy 与触发条件没联动」，靠人走查很难覆盖。抽成纯函数后，
 * 「回合 streaming 时不 travel / 不退出」「回合结束后重新计时」都能在 node 环境断言。
 */

/** 入口 dwell 状态：id 为空表示没在任何一个入口上计时 */
export interface DwellState {
  id: string;
  since: number;
  fired: boolean;
}

export interface EntryDwellInput {
  /** 回合 streaming 中（此时禁止自动进入室内，避免绕过回合串行） */
  busy: boolean;
  /** 是否已武装：离开过入口范围才重新武装，防止原地反复进出 */
  armed: boolean;
  dwell: DwellState;
  /** 当前离得最近的可进入口；不在任何入口范围时为 null */
  bestEntryId: string | null;
  now: number;
  dwellMs: number;
}

export interface EntryDwellStep {
  dwell: DwellState;
  armed: boolean;
  /** 0..1，进度环用 */
  pct: number;
  /** 本次探测是否要进室内（真进一次后 armed 变 false，不会重复触发） */
  fire: boolean;
}

const EMPTY_DWELL: DwellState = { id: "", since: 0, fired: false };

/** 大地图：靠近入口满 dwellMs 自动进室内；busy 期间一律不累计、不触发 */
export function stepEntryDwell(input: EntryDwellInput): EntryDwellStep {
  const { busy, armed, dwell, bestEntryId, now, dwellMs } = input;
  if (busy) {
    // 回合没结束就站在入口：清零计时，回合结束后重新数满再进（P1-1）
    return { dwell: EMPTY_DWELL, armed: bestEntryId === null ? true : armed, pct: 0, fire: false };
  }
  if (!bestEntryId) {
    // 离开所有入口范围：重新武装，下次靠近才会触发
    return { dwell: EMPTY_DWELL, armed: true, pct: 0, fire: false };
  }
  if (!armed) {
    // 在范围内但还没武装：只有真离开过才恢复
    return { dwell: { id: bestEntryId, since: 0, fired: false }, armed: false, pct: 0, fire: false };
  }
  if (dwell.id !== bestEntryId) {
    return { dwell: { id: bestEntryId, since: now, fired: false }, armed: true, pct: 0, fire: false };
  }
  const pct = Math.min(1, (now - dwell.since) / dwellMs);
  if (!dwell.fired && pct >= 1) {
    return { dwell: { ...dwell, fired: true }, armed: false, pct: 1, fire: true };
  }
  return { dwell, armed: true, pct, fire: false };
}

export interface AutoTravelInput {
  busy: boolean;
  sceneId: string | null;
  /** 玩家当前所在场景（同一场景不 travel） */
  playerLocId: string | undefined;
  /** 已经为哪个场景发过自动 travel（null/"" = 未发过；失败时上层会清空它） */
  enteredId: string | null;
}

/** 大地图：走到 built 点位旁自动静默 travel；busy 期间不发请求（P1-1） */
export function shouldAutoTravel(input: AutoTravelInput): boolean {
  const { busy, sceneId, playerLocId, enteredId } = input;
  if (busy || !sceneId) return false;
  if (sceneId === playerLocId) return false;
  return enteredId !== sceneId;
}

export interface ExitDwellInput {
  busy: boolean;
  /** 是否站在出口半径内 */
  near: boolean;
  armed: boolean;
  since: number;
  fired: boolean;
  now: number;
  dwellMs: number;
}

export interface ExitDwellStep {
  since: number;
  fired: boolean;
  armed: boolean;
  pct: number;
  fire: boolean;
}

/** 室内：站在出口满 dwellMs 自动回大地图；busy 期间不退出（P1-2） */
export function stepExitDwell(input: ExitDwellInput): ExitDwellStep {
  const { busy, near, armed, since, fired, now, dwellMs } = input;
  if (busy) {
    // 回合没结束就站在出口：清零计时，回合结束后重新数满再退（P1-2）
    return { since: 0, fired: false, armed: near ? armed : true, pct: 0, fire: false };
  }
  if (!near) {
    return { since: 0, fired: false, armed: true, pct: 0, fire: false };
  }
  if (!armed) {
    return { since: 0, fired: false, armed: false, pct: 0, fire: false };
  }
  if (!since) return { since: now, fired: false, armed: true, pct: 0, fire: false };
  const pct = Math.min(1, (now - since) / dwellMs);
  if (!fired && pct >= 1) {
    return { since, fired: true, armed: false, pct: 1, fire: true };
  }
  return { since, fired, armed: true, pct, fire: false };
}
