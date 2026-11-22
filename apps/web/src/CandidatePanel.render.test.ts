import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CandidatePanel from "./CandidatePanel.tsx";
import { buildCandidates } from "./candidates.ts";

describe("CandidatePanel 按来源 kind 分组上色（issue #139）", () => {
  it("kind 直通 class；中文文本不带前缀也按来源分组", () => {
    const candidates = buildCandidates([
      { text: "问室友监控的事", kind: "talk" },
      { text: "去实验楼 302 看看", kind: "move" },
      { text: "看看公告栏", kind: "action" },
      "旧字符串回退",
    ]);
    const html = renderToStaticMarkup(
      createElement(CandidatePanel, {
        candidates,
        disabled: false,
        ready: true,
        target: null,
        onPick: () => undefined,
      }),
    );
    expect(html).toContain("class=\"candidate-chip kind-talk\"");
    expect(html).toContain("class=\"candidate-chip kind-move\"");
    expect(html).toContain("class=\"candidate-chip kind-action\"");
    // 旧字符串回退与前一条 action 同组（结构断言，不断言文案）
    expect((html.match(/kind-action/g) ?? []).length).toBe(2);
  });
});
