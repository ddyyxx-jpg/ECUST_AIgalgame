/**
 * 进房数据装载顺序（PR #126 复审 P1-1 残留）：
 * 先两次拉取、每次 await 后校验请求仍有效，**全部成功之后**才允许捕获/清空/恢复 UI。
 *
 * 抽成独立 helper 是为了让「reset 必须发生在 fetch 之后」成为可被测试直接钉住的契约：
 * 谁把 reset 挪回 fetch 之前，调用顺序测试立刻会红——而不是只能靠人眼盯 App.tsx。
 */
export interface LoadRoomThenResetDeps<TState, THistory, TCaptured> {
  fetchState: () => Promise<TState>;
  fetchHistory: () => Promise<THistory>;
  /** 每个 await 之后调用：切房/登出/新请求会让旧流程作废，作废时不得 reset */
  isCurrent: () => boolean;
  /** 数据齐了、reset 之前调用：捕获要跨重进房保留的本地 UI 状态（草稿/convMode 等） */
  capture: (state: TState, history: THistory) => TCaptured;
  /** 清空上一局 UI。只有 capture 之后才会被调用 */
  reset: () => void;
  /** reset 之后应用捕获值 */
  restore: (captured: TCaptured) => void;
}

/**
 * 先拉数据、成功后才 reset/恢复，返回捕获值。
 * 任一拉取失败时错误原样抛出且不 reset（调用方保留旧画面与可重试状态）；
 * 请求已作废时返回 null，同样不 reset。
 */
export async function loadRoomThenReset<TState, THistory, TCaptured>(
  deps: LoadRoomThenResetDeps<TState, THistory, TCaptured>,
): Promise<TCaptured | null> {
  const state = await deps.fetchState();
  if (!deps.isCurrent()) return null;
  const history = await deps.fetchHistory();
  if (!deps.isCurrent()) return null;
  const captured = deps.capture(state, history);
  deps.reset();
  deps.restore(captured);
  return captured;
}
