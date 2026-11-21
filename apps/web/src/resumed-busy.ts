/**
 * resumed 重进房期间的 busy 占位。
 *
 * 为什么需要「归还权」（PR #126 三轮复审 P3）：两次重进房重叠时，旧调用的 finally
 * 会无条件 setBusy(false)，把新调用刚占住的 busy 提前放开，玩家就能在拉取窗口里发回合。
 * 只有仍然是最新一次调用（isCurrent）才有权归还；普通进房/换房不占位，避免整屏 loading。
 */
export interface ResumedBusyHold {
  /** 是否真的占位（普通进房/换房为 false） */
  readonly resumed: boolean;
  /** 在 finally 调用：只有最新调用才放开 */
  release(): void;
}

export function holdResumedBusy(opts: {
  resumed: boolean;
  setBusy: (busy: boolean) => void;
  isCurrent: () => boolean;
}): ResumedBusyHold {
  const { resumed, setBusy, isCurrent } = opts;
  if (resumed) setBusy(true);
  return {
    resumed,
    release: () => {
      // 旧调用已被新调用作废：不归还，否则新调用的占位窗口会提前结束。
      if (resumed && isCurrent()) setBusy(false);
    },
  };
}
