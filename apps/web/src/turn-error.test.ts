import { describe, expect, it } from "vitest";
import { explainTurnError, isRetryableTurnError, retrySubmission, shouldDropRetryOnMove } from "./turn-error.ts";

describe("isRetryableTurnError（重试判定）", () => {
  it("服务端 retryable=true/false 优先于错误码集合", () => {
    expect(isRetryableTurnError("E_LLM_FORMAT", true)).toBe(true);
    expect(isRetryableTurnError("E_FORBIDDEN", true)).toBe(true);
    expect(isRetryableTurnError("E_LLM_TIMEOUT", false)).toBe(false);
    expect(isRetryableTurnError("E_STORE_FAULT", false)).toBe(false);
  });

  it("没有 retryable 标记时回退到契约的可重试集合", () => {
    expect(isRetryableTurnError("E_LLM_FORMAT")).toBe(true);
    expect(isRetryableTurnError("E_LLM_TIMEOUT")).toBe(true);
    expect(isRetryableTurnError("E_RATE_LIMITED")).toBe(true);
    // 服务端兜底会发这个码（docs/03 里没有它，但属于"换个 provider 再试"）
    expect(isRetryableTurnError("E_UPSTREAM")).toBe(true);
  });

  it("不可重试的业务错误不显示重试按钮", () => {
    expect(isRetryableTurnError("E_FORBIDDEN")).toBe(false);
    expect(isRetryableTurnError("E_NOT_IN_ROOM")).toBe(false);
    expect(isRetryableTurnError("HTTP_500")).toBe(false);
    expect(isRetryableTurnError("")).toBe(false);
  });
});

describe("explainTurnError（可读文案）", () => {
  it("常见 LLM 错误给固定的人话提示，不暴露原始 JSON", () => {
    expect(explainTurnError("E_LLM_FORMAT", '{"raw":bad}')).toContain("重试");
    expect(explainTurnError("E_LLM_FORMAT", '{"raw":bad}')).not.toContain("{");
    expect(explainTurnError("E_LLM_TIMEOUT", "")).toContain("超时");
  });

  it("未收录的错误码保留 code + message，便于排查", () => {
    expect(explainTurnError("E_PRECONDITION", "余额不足")).toBe("E_PRECONDITION: 余额不足");
    expect(explainTurnError("E_PRECONDITION", "")).toBe("E_PRECONDITION");
  });

  it("完全空的输入也给可读兜底", () => {
    expect(explainTurnError("", "")).toBe("回合失败");
  });
});

describe("retrySubmission（v2 blocked 后重试的提交参数，P2-7）", () => {
  it("普通回合：保留原输入，auto=false", () => {
    expect(retrySubmission({ text: "再问一次" })).toEqual({ text: "再问一次", auto: false });
  });

  it("auto 回合被 blocked：即使输入为空也带 auto=true，守卫不会被空文本吃掉", () => {
    expect(retrySubmission({ text: "", auto: true })).toEqual({ text: "", auto: true });
  });

  it("没有上一回合时不构造提交", () => {
    expect(retrySubmission(null)).toBeNull();
  });
});

describe("shouldDropRetryOnMove（换场景作废旧重试）", () => {
  it("确实从一个场景换到另一个场景：作废", () => {
    expect(shouldDropRetryOnMove("loc_lib", "loc_dorm")).toBe(true);
  });

  it("同场景 / 首次拿到位置 / 位置暂时为空：不误伤", () => {
    expect(shouldDropRetryOnMove("loc_lib", "loc_lib")).toBe(false);
    expect(shouldDropRetryOnMove("", "loc_lib")).toBe(false);
    expect(shouldDropRetryOnMove("loc_lib", "")).toBe(false);
  });
});
