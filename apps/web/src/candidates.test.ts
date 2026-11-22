import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CANDIDATES,
  buildCandidates,
  normalizeSuggestion,
} from "./candidates.ts";
import type { SuggestionInput } from "./candidates.ts";

describe("normalizeSuggestion（来源侧 kind 直通；旧字符串回退）", () => {
  it("带 kind 的建议项原样保留，不解析中文文本", () => {
    expect(normalizeSuggestion({ text: "问室友监控的事", kind: "talk" })).toEqual({
      text: "问室友监控的事",
      kind: "talk",
    });
    // 同一句文本可带不同来源 kind：证明分组不来自前缀
    expect(normalizeSuggestion({ text: "去找校刊编辑部打听", kind: "talk" }).kind).toBe("talk");
    expect(normalizeSuggestion({ text: "去找校刊编辑部打听", kind: "move" }).kind).toBe("move");
  });

  it("旧字符串回退到 action，不做中文前缀正则", () => {
    expect(normalizeSuggestion("去图书馆")).toEqual({ text: "去图书馆", kind: "action" });
    expect(normalizeSuggestion("和艾琳说话")).toEqual({ text: "和艾琳说话", kind: "action" });
  });
});

describe("buildCandidates（过滤 / 去重 / 截断 / 编号 / 分组）", () => {
  it("空数组 → 空数组", () => {
    expect(buildCandidates([])).toEqual([]);
  });

  it("过滤空串与纯空白", () => {
    const out = buildCandidates([
      { text: "", kind: "move" },
      { text: "   ", kind: "move" },
      { text: "去图书馆", kind: "move" },
    ]);
    expect(out.map((c) => c.text)).toEqual(["去图书馆"]);
  });

  it("去重保序（保留第一次出现，按 trim 后文本）", () => {
    const input: SuggestionInput[] = [
      { text: "去图书馆", kind: "move" },
      { text: "和艾琳说话", kind: "talk" },
      "  去图书馆 ",
      { text: "和艾琳说话", kind: "action" },
    ];
    const out = buildCandidates(input);
    expect(out.map((c) => c.text)).toEqual(["去图书馆", "和艾琳说话"]);
    expect(out.map((c) => c.kind)).toEqual(["move", "talk"]);
  });

  it("trim 掉文本两侧空白", () => {
    expect(buildCandidates([{ text: "  去图书馆  ", kind: "move" }])[0]?.text).toBe("去图书馆");
  });

  it("默认最多 6 条", () => {
    const many: SuggestionInput[] = ["A", "B", "C", "D", "E", "F", "G"].map((x) => ({
      text: `去${x}`,
      kind: "move",
    }));
    expect(DEFAULT_MAX_CANDIDATES).toBe(6);
    expect(buildCandidates(many)).toHaveLength(6);
  });

  it("max 截断且不改顺序", () => {
    const out = buildCandidates([
      { text: "去A", kind: "move" },
      { text: "和B说话", kind: "talk" },
      { text: "看看C", kind: "action" },
    ], { max: 2 });
    expect(out.map((c) => c.text)).toEqual(["去A", "和B说话"]);
  });

  it("max < 1 视为 1", () => {
    const input: SuggestionInput[] = [{ text: "去A", kind: "move" }, { text: "去B", kind: "move" }];
    expect(buildCandidates(input, { max: 0 })).toHaveLength(1);
    expect(buildCandidates(input, { max: -3 })).toHaveLength(1);
  });

  it("hint 从 1 开始连续，且与下标一致", () => {
    const out = buildCandidates([
      { text: "去A", kind: "move" },
      { text: "和B说话", kind: "talk" },
      { text: "看看C", kind: "action" },
    ]);
    expect(out.map((c) => c.hint)).toEqual(["1", "2", "3"]);
    out.forEach((c, i) => expect(c.hint).toBe(String(i + 1)));
  });

  it("id 稳定、不重复，且带来源 kind 前缀", () => {
    const input: SuggestionInput[] = [
      { text: "去图书馆", kind: "move" },
      { text: "问室友监控的事", kind: "talk" },
      { text: "去看看公告栏", kind: "action" },
    ];
    const a = buildCandidates(input);
    const b = buildCandidates(input);
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(new Set(a.map((c) => c.id)).size).toBe(a.length);
    expect(a.map((c) => c.id)).toEqual([
      "move:去图书馆",
      "talk:问室友监控的事",
      "action:去看看公告栏",
    ]);
  });

  it("两个 issue #139 误分级样例按来源 kind 正确分组", () => {
    const out = buildCandidates([
      { text: "问室友监控的事", kind: "talk" },
      { text: "去找校刊编辑部打听", kind: "talk" },
    ]);
    expect(out.map((c) => c.kind)).toEqual(["talk", "talk"]);
  });

  it("中文文本无前缀时，kind 仍完全由来源给出", () => {
    const out = buildCandidates([
      { text: "公告栏上的名字", kind: "action" },
      { text: "室友那台电脑", kind: "talk" },
    ]);
    expect(out.map((c) => c.kind)).toEqual(["action", "talk"]);
  });
});
