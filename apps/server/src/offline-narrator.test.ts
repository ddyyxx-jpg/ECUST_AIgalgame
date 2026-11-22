/**
 * 离线叙述器的回归测试（审阅 M2）：提示词解析、场景别名的目标选取、
 * 观察类不重复场景描述、缺失场景的兜底、缺失数据文件不炸启动。
 */
import { describe, expect, it } from "vitest";
import { pickSceneByInput, loadSceneDescs, offlineNarrative, parsePromptContext, resolveSceneDesc } from "./offline-narrator.ts";

function messages(input: string, loc: string, day = 1, phase = "morning"): { role?: string; content?: string }[] {
  return [
    {
      role: "system",
      content: `你是校园文字冒险游戏的叙事者。\n当前地点：${loc}；第 ${day} 天 ${phase}。\n玩家：你。\n玩家输入：${input}`,
    },
    { role: "user", content: input },
  ];
}

const SCENES = new Map([
  ["loc_library", { name: "图书馆", desc: "旧馆三层，四层书架把光切成一条一条。流通台后面是过刊室。" }],
  ["loc_canteen", { name: "一食堂", desc: "队伍一直排到门口。价目表被人用笔改过。" }],
]);

describe("parsePromptContext", () => {
  it("从提示词里取回地点/天数/时段/玩家输入", () => {
    const ctx = parsePromptContext(messages("去食堂", "图书馆", 3, "evening"));
    expect(ctx).toEqual({ locName: "图书馆", day: 3, phase: "evening", input: "去食堂" });
  });

  it("提示词缺失时给安全默认值，不抛错", () => {
    const ctx = parsePromptContext([{ content: "hi" }]);
    expect(ctx).toEqual({ locName: "", day: 1, phase: "morning", input: "hi" });
  });
});

describe("offlineNarrative", () => {
  it("移动类输入用目标场景的描述（含别名匹配），不用出发地", () => {
    const text = offlineNarrative(messages("去食堂", "图书馆"), SCENES);
    expect(text).toContain("队伍一直排到门口"); // 目标"一食堂"的别名"食堂"
    expect(text).not.toContain("旧馆三层");
  });

  it("观察类输入不重复场景描述（facts 会带），只给开场与收束", () => {
    const text = offlineNarrative(messages("看看四周", "图书馆"), SCENES);
    expect(text).not.toContain("旧馆三层");
    expect(text.length).toBeGreaterThan(0);
  });

  it("场景缺失时退回通用白描，不抛错", () => {
    const text = offlineNarrative(messages("去操场", "图书馆"), new Map());
    expect(text.length).toBeGreaterThan(0);
  });

  it("交易类输入走交易收束句", () => {
    const text = offlineNarrative(messages("买面包", "一食堂"), SCENES);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("配置");
  });
});

describe("loadSceneDescs", () => {
  it("文件不存在返回空表，不抛错", async () => {
    const map = await loadSceneDescs("C:/nonexistent/world_map.json");
    expect(map.size).toBe(0);
  });
});

describe("resolveSceneDesc（#134 canon 名 → 地图点位 id 回退）", () => {
  const descs = new Map([
    ["loc_library", { name: "图文信息中心", desc: "图文信息中心的旧馆三层。" }],
  ]);
  const canon = new Map([["图书馆", "loc_library"]]);

  it("给 locId 直接命中", () => {
    expect(resolveSceneDesc(descs, canon, { locId: "loc_library" })).toContain("旧馆三层");
  });

  it("只给 canon 名（图书馆）也能经 id 解析命中，而不是按名字全 miss", () => {
    expect(resolveSceneDesc(descs, canon, { locName: "图书馆" })).toContain("旧馆三层");
  });

  it("名字与地图一致时仍走同名匹配", () => {
    expect(resolveSceneDesc(descs, canon, { locName: "图文信息中心" })).toContain("旧馆三层");
  });

  it("都查不到时返回空串，不抛错", () => {
    expect(resolveSceneDesc(descs, canon, { locName: "不存在的地方" })).toBe("");
  });
});

describe("审阅 P3：场景名匹配取最长别名", () => {
  const descs = new Map([
    ["loc_a", { name: "一食堂", desc: "A" }],
    ["loc_b", { name: "食堂二楼", desc: "B" }],
  ]);
  it("输入「食堂二楼」命中长名，不被「一食堂」的短别名截胡", () => {
    expect(pickSceneByInput(descs, "去食堂二楼吃饭")?.desc).toBe("B");
  });
  it("输入「一食堂」仍命中自己", () => {
    expect(pickSceneByInput(descs, "去一食堂")?.desc).toBe("A");
  });
});
