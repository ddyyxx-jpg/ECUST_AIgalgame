/**
 * 「谁报了名字才认识谁」判定：看说话人标签之后的台词内容，而不是标签本身。
 */
import { describe, expect, it } from "vitest";
import type { Entity } from "../../../packages/shared/src/contract/types.ts";
import { namesIntroducedIn } from "./name-unlock.ts";

function npc(name: string, known = false): Entity {
  return {
    id: `npc_${name}`,
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

describe("namesIntroducedIn", () => {
  it("台词开头自报姓名 → 解锁", () => {
    const text = '林静：“林静。双木林，安静的静。”她顿了顿。';
    expect(namesIntroducedIn(text, [npc("林静"), npc("白晓通")]).map((e) => e.name)).toEqual(["林静"]);
  });

  it("台词里说「我白晓通」 → 解锁", () => {
    expect(namesIntroducedIn("白晓通：哟，新面孔。我白晓通，高二三班。", [npc("白晓通")]).map((e) => e.name)).toEqual(["白晓通"]);
  });

  it("只是打招呼 → 不解锁（标签带名字不算自我介绍）", () => {
    const text = "林静：你好——小声一点，这边有人自习。\n白晓通：早上好啊。";
    expect(namesIntroducedIn(text, [npc("林静"), npc("白晓通")])).toHaveLength(0);
  });

  it("旁白提到名字 → 不解锁", () => {
    expect(namesIntroducedIn("不远处的白晓通也从笔记本上抬起头。", [npc("白晓通")])).toHaveLength(0);
  });

  it("已认识的人不重复解锁", () => {
    expect(namesIntroducedIn("林静：林静，安静的静。", [npc("林静", true)])).toHaveLength(0);
  });

  it("只说'我是/我叫'却没报名 → 不解锁（审阅 P1-5 反例）", () => {
    expect(namesIntroducedIn("林静：我是图书馆的老师，有事可以问我。", [npc("林静")])).toHaveLength(0);
    expect(namesIntroducedIn("林静：我叫你一声同学吧。", [npc("林静")])).toHaveLength(0);
  });

  it("只报姓不报名 → 不解锁", () => {
    expect(namesIntroducedIn("白晓通：我姓白，你应该猜到了。", [npc("白晓通")])).toHaveLength(0);
  });

  it("英文冒号也认", () => {
    expect(namesIntroducedIn("林静: 林静，安静的静。", [npc("林静")])).toHaveLength(1);
  });
});
