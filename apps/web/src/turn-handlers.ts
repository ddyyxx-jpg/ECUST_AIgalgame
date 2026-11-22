/**
 * 回合 SSE 的回调装配：所有写入前先核对请求版本（切房间/切账号后旧流不得污染新画面）。
 * 与 App 解耦成纯装配函数，便于单测与保持 App 函数体精简。
 */
import type { Dispatch, SetStateAction } from "react";
import type { ViewPatch, WorldState } from "../../../packages/shared/src/contract/types.ts";
import type { TurnStreamHandlers } from "./api.ts";
import type { Typewriter } from "./typewriter.ts";
import type { LineKind } from "./ui.ts";
import { explainTurnError, isRetryableTurnError } from "./turn-error.ts";

export interface TurnHandlerDeps {
  /** 本次回合所属的身份+房间版本是否仍是当前 */
  current: () => boolean;
  tw: Typewriter;
  lastFacts: { current: string };
  setState: Dispatch<SetStateAction<WorldState | null>>;
  setView: Dispatch<SetStateAction<ViewPatch>>;
  setErr: Dispatch<SetStateAction<string>>;
  setErrRetryable: Dispatch<SetStateAction<boolean>>;
  setUnconfirmed: Dispatch<SetStateAction<{ clientTurnId: string } | null>>;
  expireSession: () => void;
}

export function makeTurnHandlers(d: TurnHandlerDeps): TurnStreamHandlers {
  return {
    onDelta: (field, chunk) => {
      if (d.current() && field === "narrative") d.tw.feed(chunk);
    },
    // 模块的 facts 是玩家唯一能"看见世界动了"的地方；与上一回合完全相同就不重复刷屏
    onFacts: (facts) => {
      if (!d.current()) return;
      const rows = facts.filter((f) => f.trim().length > 0);
      if (rows.length === 0) return;
      const key = rows.join("\n");
      if (key === d.lastFacts.current) return;
      d.lastFacts.current = key;
      d.tw.enqueue(rows.map((f) => ({ kind: "fact" as LineKind, text: f })));
    },
    onPatch: (s) => {
      if (d.current()) d.setState(s);
    },
    onUi: (v) => {
      if (d.current()) d.setView((old) => ({ ...old, ...v }));
    },
    onError: (code, message, retryable) => {
      if (!d.current()) return;
      if (code === "E_UNAUTHORIZED") {
        d.expireSession();
        return;
      }
      d.setErr(explainTurnError(code, message, retryable));
      d.setErrRetryable(isRetryableTurnError(code, retryable));
    },
    onUnconfirmed: (id) => {
      if (!d.current()) return;
      d.setUnconfirmed({ clientTurnId: id });
      d.setErr("本回合结果未确认（连接中断）。重试会先向服务端核对，已提交的行动不会重复执行。");
      d.setErrRetryable(true);
    },
  };
}