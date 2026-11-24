/**
 * 文本脱敏（认识口径）：未认识 NPC 的真名不得出现在下发文本里，且多个陌生人要能区分
 * （一位 / 另一位 / 第三位陌生的同学），否则一次对话里两个陌生人的台词会混成同一个人。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Entity, WorldState } from "../../../packages/shared/src/contract/types.ts";
import { UNKNOWN_NPC_NAME, maskNamesDeep, maskNamesInText, unmaskTargetPlaceholder, unknownPlaceholders } from "./view-names.ts";

function npc(id: string, name: string, known: boolean): Entity {
  return {
    id,
    kind: "npc",
    name,
    attrs: { knows_name: known },
    tags: [],
    origin: "seed",
    canon: true,
    status: "active",
    createdAt: 0,
    updatedAt: 0,
  };
}

function stateOf(...npcs: Entity[]): WorldState {
  return {
    schemaVersion: 2,
    room: { id: "r", mode: "solo", worldId: "w", members: [], scene: { locId: "loc", presentIds: [] }, createdAt: 0, lastActiveAt: 0 },
    entities: Object.fromEntries(npcs.map((n) => [n.id, n])),
    links: [],
    clock: { day: 1, phase: "morning", tick: 0 },
    plots: [],
    moduleState: {},
  } as WorldState;
}

describe("文本脱敏", () => {
  it("只收集未认识的名字，并按 id 排序给不同占位名", () => {
    const p = unknownPlaceholders(stateOf(npc("npc_a", "严守一", false), npc("npc_b", "周明远", false), npc("npc_c", "林静", true)));
    expect(p.get("严守一")).toBe("一位陌生的同学");
    expect(p.get("周明远")).toBe("另一位陌生的同学");
    expect(p.has("林静")).toBe(false);
  });

  it("有外貌描述时优先用外貌作占位名（A 方案），缺描述的才退回序号", () => {
    const appearance = new Map([
      ["npc_a", "穿白衬衫、袖口别着校徽的男生"],
    ]);
    const p = unknownPlaceholders(stateOf(npc("npc_a", "严守一", false), npc("npc_b", "周明远", false)), appearance);
    expect(p.get("严守一")).toBe("穿白衬衫、袖口别着校徽的男生");
    expect(p.get("周明远")).toBe("另一位陌生的同学"); // 没外观数据 → 退回序号
  });

  it("台词里的名字按占位名替换", () => {
    const p = unknownPlaceholders(stateOf(npc("npc_a", "严守一", false), npc("npc_b", "周明远", false)));
    expect(maskNamesInText("严守一：嗯？……你好。", p)).toBe("一位陌生的同学：嗯？……你好。");
    expect(maskNamesInText("周明远在旁边点头。", p)).toBe("另一位陌生的同学在旁边点头。");
  });

  it("「叫<真名>」改成判断句，不出现「叫<外貌>」这种病句（试玩反馈）", () => {
    const appearance = new Map([
      ["npc_a", "抱着一摞校刊、脖子上挂着相机的女生"],
      ["npc_b", "坐在借还台后、手边摞着一叠还书的女生"],
    ]);
    const p = unknownPlaceholders(stateOf(npc("npc_a", "白晓通", false), npc("npc_b", "林静", false)), appearance);
    const out = maskNamesInText("另一个在三楼过刊那边的，叫白晓通。林静在流通台盖章呢。", p);
    expect(out).toBe(
      "另一个在三楼过刊那边的，是抱着一摞校刊、脖子上挂着相机的女生。坐在借还台后、手边摞着一叠还书的女生在流通台盖章呢。",
    );
    expect(out).not.toContain("叫抱");
    // 第三人称介绍（"她叫X"）同样改成判断句
    expect(maskNamesInText("她叫林静，在流通台。", p)).toBe("她是坐在借还台后、手边摞着一叠还书的女生，在流通台。");
    // 「叫他X」这种称呼用法不在改写范围内，只做名字替换
    expect(maskNamesInText("大家都叫他白晓通。", p)).toContain("叫他抱着一摞校刊");
    // 已知名字的人不受影响
    const known = unknownPlaceholders(stateOf(npc("npc_a", "白晓通", true)));
    expect(maskNamesInText("叫白晓通。", known)).toBe("叫白晓通。");
  });

  it("递归脱敏事件结构，不改非字符串", () => {
    const p = unknownPlaceholders(stateOf(npc("npc_a", "严守一", false)));
    const masked = maskNamesDeep(
      { type: "turn.patch", patch: { lines: [{ kind: "npc", text: "严守一：你好" }], facts: ["【世界印象】严守一记住了你"], seq: 7 } },
      p,
    ) as { patch: { lines: { text: string }[]; facts: string[]; seq: number } };
    expect(masked.patch.lines[0]!.text).toBe(`${UNKNOWN_NPC_NAME}：你好`);
    expect(masked.patch.facts[0]).toContain(UNKNOWN_NPC_NAME);
    expect(masked.patch.seq).toBe(7);
  });

  it("前缀相同的名字按长度降序替换，不互相污染（审阅 P2-10）", () => {
    const p = unknownPlaceholders(stateOf(npc("npc_a", "白晓", false), npc("npc_b", "白晓通", false)));
    const out = maskNamesInText("白晓通和白晓都在", p);
    expect(out).not.toContain("白晓通");
    expect(out).not.toContain("白晓");
    // 短名字不会被长名字的替换结果破坏
    expect(out).toContain("另一位陌生的同学");
  });


  it("喂模型前把目标展示名换回真名，且不误伤其他陌生人", () => {
    const appearance = new Map([["npc_a", "拿着文件夹、站姿笔直的中年人"]]);
    const p = unknownPlaceholders(stateOf(npc("npc_a", "严守一", false), npc("npc_b", "周明远", false)), appearance);
    const placeholder = p.get("严守一");
    const input = "对拿着文件夹、站姿笔直的中年人说：你叫什么";
    expect(unmaskTargetPlaceholder(input, placeholder, "严守一")).toBe("对严守一说：你叫什么");
    // 顺带提到的另一个陌生人保持占位名，不会被当成目标实名化
    expect(unmaskTargetPlaceholder("对一位陌生的同学说：周明远在哪", placeholder, "严守一")).toBe(
      "对一位陌生的同学说：周明远在哪",
    );
    // 没给展示名时原样返回（已认识/无状态）
    expect(unmaskTargetPlaceholder(input, undefined, "严守一")).toBe(input);
  });

  it("没有未认识的人时原样返回", () => {
    const value = { a: "严守一：你好" };
    expect(maskNamesDeep(value, new Map())).toBe(value);
  });
  it("NPC appearance 两两不是前缀（否则 unmaskTargetPlaceholder 会误伤）", () => {
    const file = fileURLToPath(new URL("../../../content/scenarios/npcs.json", import.meta.url));
    const rows = JSON.parse(readFileSync(file, "utf-8")) as { id: string; appearance?: string }[];
    const looks = rows.map((r) => r.appearance?.trim()).filter((v): v is string => Boolean(v));
    for (const a of looks) {
      for (const b of looks) {
        if (a !== b && b.startsWith(a)) {
          throw new Error(`appearance 前缀冲突：${a} ⊂ ${b}；unmask 会误伤，需保证唯一且互不为前缀`);
        }
      }
    }
  });

});
