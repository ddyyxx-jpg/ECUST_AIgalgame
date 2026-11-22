import { describe, expect, it } from "vitest";
import { selectWorldInfo, type Lorebook } from "./lorebook.ts";

const book: Lorebook = {
  authorNote: "作者注",
  entries: [
    { id: "b", keys: ["食堂"], content: "食堂条目", order: 1, constant: false, enabled: true },
    { id: "a", keys: ["图书馆"], content: "图书馆条目", order: 5, constant: false, enabled: true },
    { id: "c", keys: ["雨"], content: "常驻条目", order: 9, constant: true, enabled: true },
    { id: "d", keys: ["宿舍"], content: "被禁用", order: 99, constant: false, enabled: false },
  ],
};

describe("selectWorldInfo", () => {
  it("constant 必带，关键词命中才带，order 降序且稳定", () => {
    expect(selectWorldInfo(book, "我去图书馆自习")).toEqual(["常驻条目", "图书馆条目"]);
    expect(selectWorldInfo(book, "去食堂吃饭")).toEqual(["常驻条目", "食堂条目"]);
  });

  it("禁用条目不出现；limit 截断；空上下文只留 constant", () => {
    expect(selectWorldInfo(book, "回宿舍")).toEqual(["常驻条目"]);
    expect(selectWorldInfo(book, "", 1)).toEqual(["常驻条目"]);
  });
});
