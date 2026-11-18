import { describe, expect, it } from "vitest";
import { buildHistoryQuery } from "./api.ts";
import type { HistoryLine } from "./api.ts";
import { earlierCursor, historyToLines, missingTurnContent, restoreConversation } from "./history-lines.ts";
import type { Scenario } from "./scenarios.ts";

function line(seq: number, over: Partial<HistoryLine> = {}): HistoryLine {
  return {
    formatVersion: 1,
    roomId: "room_x",
    turnId: `t${seq}`,
    committedSeq: seq,
    actorId: "plr_x",
    input: `行动${seq}`,
    narrative: `叙事${seq}`,
    speakers: [],
    facts: [`事实${seq}`],
    createdAt: seq,
    ...over,
  };
}

describe("buildHistoryQuery（历史游标）", () => {
  it("无游标 = 默认 limit，服务端返回最近一段（tail）", () => {
    const q = new URLSearchParams(buildHistoryQuery());
    expect(q.get("limit")).toBe("200");
    expect(q.get("before")).toBeNull();
    expect(q.get("fromTurn")).toBeNull();
  });

  it("before 用 committedSeq 向更早翻页；fromTurn 向前翻页", () => {
    expect(new URLSearchParams(buildHistoryQuery({ before: 12, limit: 50 })).get("before")).toBe("12");
    expect(new URLSearchParams(buildHistoryQuery({ fromTurn: "t3" })).get("fromTurn")).toBe("t3");
    expect(new URLSearchParams(buildHistoryQuery({ before: 0 })).get("before")).toBe("0");
  });
});

describe("historyToLines / earlierCursor（恢复投影）", () => {
  it("每行历史 → player/narrative/fact 三行，空白文本跳过", () => {
    let id = 0;
    const lines = historyToLines([line(1), line(2, { input: "  ", facts: ["", "有效"] })], () => ++id);
    expect(lines.map((l) => l.kind)).toEqual(["player", "narrative", "fact", "narrative", "fact"]);
    expect(lines.map((l) => l.id)).toEqual([1, 2, 3, 4, 5]);
    expect(lines[4]?.text).toBe("有效");
  });

  it("加载更早的游标 = 段首 committedSeq；空段为 null", () => {
    expect(earlierCursor([line(4), line(5)])).toBe(4);
    expect(earlierCursor([])).toBeNull();
  });
});

describe("missingTurnContent（断流后补齐历史差集）", () => {
  it("已收到完整叙事和 facts → 不重复追加", () => {
    const l = line(1);
    expect(missingTurnContent(l, { narrative: l.narrative, facts: [...l.facts] })).toEqual({ narrative: "", facts: [] });
  });

  it("只收到叙事前缀和部分 facts → 只补剩余部分", () => {
    const l = line(1, { narrative: "前半段\n后半段", facts: ["a", "b", "c"] });
    expect(missingTurnContent(l, { narrative: "前半段", facts: ["a"] })).toEqual({ narrative: "\n后半段", facts: ["b", "c"] });
  });

  it("什么都没收到 → 全量补；收到的不是历史前缀 → 不冒险重复追加", () => {
    const l = line(1);
    expect(missingTurnContent(l, { narrative: "", facts: [] })).toEqual({ narrative: l.narrative, facts: l.facts });
    expect(missingTurnContent(l, { narrative: "别的文本", facts: [] })).toEqual({ narrative: "", facts: l.facts });
  });
});

describe("restoreConversation（进房首屏投影）", () => {
  const sc: Scenario = { id: "s1", name: "开局", role: "身份", tagline: "", opening: ["第一段"], hint: "" };

  it("有历史：直接铺对话行（系统提示 + 重放），不走打字机开场", () => {
    let id = 0;
    const r = restoreConversation([line(1)], sc, true, () => ++id);
    expect(r.opening).toEqual([]);
    expect(r.lines.map((l) => l.kind)).toEqual(["system", "player", "narrative", "fact"]);
  });

  it("无历史：退回序章开场；resumed 追加恢复提示；无剧本只留一行提示", () => {
    let id = 0;
    const next = () => ++id;
    expect(restoreConversation([], sc, false, next).opening.map((i) => i.kind)).toEqual(["system", "narrative"]);
    expect(restoreConversation([], sc, true, next).opening).toHaveLength(3);
    expect(restoreConversation([], null, false, next).opening).toHaveLength(1);
  });
});