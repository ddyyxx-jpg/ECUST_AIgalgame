/**
 * 回合失败的可读文案与「重试」判定（issue #21-3 web 侧）。
 *
 * 是否可重试以服务端 `turn.error` / `turn.rejected` 事件里的 `retryable` 为准
 * （`docs/03` §2.3 事件定义）；事件没带该字段时（老服务端 / 传输层兜底）再回退到
 * 契约里的可重试错误集合 `RETRYABLE`，避免前端自己维护一份错误码名单。
 * 传输层（fetch 抛错、HTTP 5xx）不自动重试，也不假装可重试。
 */
import { RETRYABLE } from "../../../packages/shared/src/contract/errors.ts";

/** 常见失败的人话解释；未收录的保持「code: message」原样，不吞掉细节 */
const FRIENDLY: Record<string, string> = {
  E_LLM_FORMAT: "模型这一回合的输出格式不对（不影响存档），可以重试。",
  E_LLM_TIMEOUT: "模型响应超时，可以重试。",
  E_RATE_LIMITED: "请求太频繁了，稍等一下再重试。",
  E_UPSTREAM: "模型服务暂时不可用，可以重试。",
  E_STORE_FAULT: "服务端写状态失败，可以重试（同一回合不会重复扣费）。",
  E_TURN_BUSY: "上一回合还没结束，稍等你再试。",
};

export function explainTurnError(code: string, message?: string, retryable?: boolean): string {
  const detail = (message ?? "").trim();
  if (code === "E_STORE_FAULT" && retryable !== true) {
    if (retryable === false) return "请先核对房间存档结果。";
    return detail || "暂时无法读取或写入存档。";
  }
  const hint = FRIENDLY[code];
  if (hint) return hint;
  return detail ? `${code}: ${detail}` : code || "回合失败";
}

/**
 * 服务端给了 `retryable` 就完全信它（引擎最知道这次失败的阶段）；
 * 只有拿不到标记时，才用契约里的可重试集合兜底。
 */
export function isRetryableTurnError(code: string, retryable?: boolean): boolean {
  if (typeof retryable === "boolean") return retryable;
  if (!code) return false;
  return code === "E_UPSTREAM" || (RETRYABLE as readonly string[]).includes(code);
}

/**
 * 位置变化时是否作废旧的重试（issue #21 P2）。
 *
 * `App` 在 `view.position.locId` 变化时用它清掉 `lastTurn`：旧目标可能已经不
 * 在玩家身边，重发就等于隔空聊天。只有"确实从一个场景换到了另一个场景"才算，
 * 首次拿到位置（prev 为空）不算移动。
 */
export function shouldDropRetryOnMove(prevLocId: string, nextLocId: string): boolean {
  return Boolean(prevLocId) && Boolean(nextLocId) && prevLocId !== nextLocId;
}

/**
 * v2「重试」提交参数（PR #149 P2-7）：blocked 的 auto 回合没有玩家输入，
 * 但必须带上 auto 标记才能走真正的自主轮，否则空输入会被 dispatch 的守卫直接吃掉。
 */
export interface RetrySubmission {
  text: string;
  auto: boolean;
}

export function retrySubmission(last: { text: string; auto?: boolean } | null): RetrySubmission | null {
  if (!last) return null;
  return { text: last.text, auto: last.auto === true };
}
