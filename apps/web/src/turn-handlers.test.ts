import { describe, expect, it } from "vitest";
import { makeTurnHandlers } from "./turn-handlers.ts";
import type { TurnHandlerDeps } from "./turn-handlers.ts";
import { Typewriter } from "./typewriter.ts";
import type { WorldState } from "../../../packages/shared/src/contract/types.ts";

function setup(current: boolean) {
  const written: string[] = [];
  const tw = new Typewriter(
    () => 1,
    () => written.push("line"),
    () => undefined,
  );
  const deps: TurnHandlerDeps = {
    current: () => current,
    tw,
    lastFacts: { current: "" },
    setState: () => written.push("state"),
    setView: () => written.push("view"),
    setErr: (v) => written.push(`err:${typeof v === "function" ? "" : v}`),
    setErrRetryable: () => written.push("retryable"),
    setUnconfirmed: (v) => written.push(`unconfirmed:${typeof v === "function" ? "" : v?.clientTurnId ?? "null"}`),
    expireSession: () => written.push("expired"),
  };
  return { deps, written, tw };
}

describe("makeTurnHandlers（版本隔离 + 结局分流）", () => {
  it("旧版本的流事件一律不写画面", () => {
    const { deps, written } = setup(false);
    const h = makeTurnHandlers(deps);
    h.onDelta?.("narrative", "旧房间的字");
    h.onFacts?.(["旧事实"]);
    h.onPatch?.({} as WorldState, []);
    h.onUi?.({});
    h.onError?.("E_LLM_FORMAT", "m");
    h.onUnconfirmed?.("ct_old");
    expect(written).toEqual([]);
  });

  it("当前版本：facts 去重、错误分流、未确认带 clientTurnId", () => {
    const { deps, written } = setup(true);
    const h = makeTurnHandlers(deps);
    h.onFacts?.(["a"]);
    h.onFacts?.(["a"]); // 与上一回合完全相同：跳过
    expect(deps.lastFacts.current).toBe("a");
    h.onUnconfirmed?.("ct1");
    expect(written).toContain("unconfirmed:ct1");
    expect(written.filter((w) => w.startsWith("err:"))).toHaveLength(1);
  });

  it("E_UNAUTHORIZED 走会话失效，不显示普通错误", () => {
    const { deps, written } = setup(true);
    makeTurnHandlers(deps).onError?.("E_UNAUTHORIZED", "未登录");
    expect(written).toEqual(["expired"]);
  });
});