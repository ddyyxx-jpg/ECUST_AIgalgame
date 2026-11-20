import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_CANDIDATES, buildCandidates, classifySuggestion } from "./candidates.ts";

describe("classifySuggestion（按开头动词分级）", () => {
  it("去… → move", () => {
    expect(classifySuggestion("去图书馆")).toBe("move");
  });

  it("和/跟/找/与… → talk", () => {
    expect(classifySuggestion("和艾琳说话")).toBe("talk");
    expect(classifySuggestion("跟艾琳说话")).toBe("talk");
    expect(classifySuggestion("找艾琳说话")).toBe("talk");
    expect(classifySuggestion("与艾琳说话")).toBe("talk");
  });

  it("其余 → action", () => {
    expect(classifySuggestion("看看公告栏")).toBe("action");
    expect(classifySuggestion("等一下")).toBe("action");
  });

  it("先 trim 再判：前后空格不影响分级", () => {
    expect(classifySuggestion("  去图书馆  ")).toBe("move");
    expect(classifySuggestion("\t和艾琳说话\n")).toBe("talk");
  });
});

describe("buildCandidates（过滤 / 去重 / 截断 / 编号）", () => {
  it("空数组 → 空数组", () => {
    expect(buildCandidates([])).toEqual([]);
  });

  it("过滤空串与纯空白", () => {
    expect(buildCandidates(["", "   ", "去图书馆"]).map((c) => c.text)).toEqual(["去图书馆"]);
  });

  it("去重保序（保留第一次出现）", () => {
    const out = buildCandidates(["去图书馆", "和艾琳说话", "去图书馆", " 去图书馆 ", "和艾琳说话"]);
    expect(out.map((c) => c.text)).toEqual(["去图书馆", "和艾琳说话"]);
  });

  it("trim 掉文本两侧空白", () => {
    expect(buildCandidates(["  去图书馆  "])[0]?.text).toBe("去图书馆");
  });

  it("默认最多 6 条", () => {
    const many = ["去A", "去B", "去C", "去D", "去E", "去F", "去G"];
    expect(DEFAULT_MAX_CANDIDATES).toBe(6);
    expect(buildCandidates(many)).toHaveLength(6);
  });

  it("max 截断且不改顺序", () => {
    const out = buildCandidates(["去A", "去B", "去C"], { max: 2 });
    expect(out.map((c) => c.text)).toEqual(["去A", "去B"]);
  });

  it("max < 1 视为 1", () => {
    expect(buildCandidates(["去A", "去B"], { max: 0 })).toHaveLength(1);
    expect(buildCandidates(["去A", "去B"], { max: -3 })).toHaveLength(1);
  });

  it("hint 从 1 开始连续，且与下标一致", () => {
    const out = buildCandidates(["去A", "和B说话", "看看C"]);
    expect(out.map((c) => c.hint)).toEqual(["1", "2", "3"]);
    out.forEach((c, i) => expect(c.hint).toBe(String(i + 1)));
  });

  it("id 稳定、不重复，且带 kind 前缀", () => {
    const input = ["去图书馆", "和艾琳说话", "看看公告栏"];
    const a = buildCandidates(input);
    const b = buildCandidates(input);
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(new Set(a.map((c) => c.id)).size).toBe(a.length);
    expect(a[0]?.id).toBe("move:去图书馆");
    expect(a[1]?.id).toBe("talk:和艾琳说话");
    expect(a[2]?.id).toBe("action:看看公告栏");
  });

  it("kind 与 classifySuggestion 一致", () => {
    const out = buildCandidates(["去图书馆", "和艾琳说话", "看看公告栏"]);
    expect(out.map((c) => c.kind)).toEqual(["move", "talk", "action"]);
  });
});
