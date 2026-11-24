/**
 * 「谁报了名字才认识谁」判定：看说话人标签之后的台词内容，而不是标签本身。
 */
import { describe, expect, it } from "vitest";
import type { Delivery, ConversationEvent } from "../../../packages/shared/src/contract/v2.ts";
import type { Entity, WorldState } from "../../../packages/shared/src/contract/types.ts";
import {
  askedNameTargetId,
  introducedPresentIds,
  isAskOtherNameInput,
  mentionedNpcIds,
  namesIntroducedIn,
  viewerSpeech,
} from "./name-unlock.ts";

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

  it("只说'我是/我叫'却没报名、也没报姓 → 不解锁（审阅 P1-5 反例）", () => {
    expect(namesIntroducedIn("林静：我是图书馆的老师，有事可以问我。", [npc("林静")])).toHaveLength(0);
    expect(namesIntroducedIn("林静：我叫你一声同学吧。", [npc("林静")])).toHaveLength(0);
  });

  it("报姓且与 NPC 姓氏一致 → 解锁（本人自述）", () => {
    expect(namesIntroducedIn("严守一：我姓严，这栋楼的年级值班老师。", [npc("严守一")])).toHaveLength(1);
    expect(namesIntroducedIn("严守一：姓严，叫我严老师就行。", [npc("严守一")])).toHaveLength(1);
  });

  it("第三人称泛谈'姓林的都很轴' → 不解锁（review #63-2）", () => {
    expect(namesIntroducedIn("林静：姓林的都很轴，别惹他们。", [npc("林静")])).toHaveLength(0);
    expect(namesIntroducedIn("林静：姓林的人很多，你猜哪个是我。", [npc("林静")])).toHaveLength(0);
  });

  it("报的姓与 NPC 不符 → 不解锁", () => {
    expect(namesIntroducedIn("白晓通：我姓王，你应该猜到了。", [npc("白晓通")])).toHaveLength(0);
  });

  it("英文冒号也认", () => {
    expect(namesIntroducedIn("林静: 林静，安静的静。", [npc("林静")])).toHaveLength(1);
  });
});

/** 最小世界状态：只给解锁判定需要的字段，presentIds 决定"在场"。 */
function world(entities: Entity[], presentIds: string[] = entities.map((e) => e.id)): WorldState {
  return {
    schemaVersion: 3,
    room: {
      id: "room_1",
      mode: "solo",
      worldId: "world_1",
      members: [],
      scene: { locId: "loc_1", presentIds },
      createdAt: 0,
      lastActiveAt: 0,
    },
    entities: Object.fromEntries(entities.map((e) => [e.id, e])),
    links: [],
    clock: { day: 1, phase: "morning", tick: 0 },
    plots: [],
    moduleState: {},
  };
}

function utterance(d: Omit<Delivery, "utteranceId" | "mode">): ConversationEvent {
  return { type: "conversation.utterance", delivery: { utteranceId: "u1", mode: "addressed", ...d } };
}

describe("askedNameTargetId（问名字直解，v1/v2 共用）", () => {
  it("目标是在场 NPC 且玩家在问名字 → 解锁该 NPC", () => {
    expect(askedNameTargetId(world([npc("林静")]), "npc_林静", "你叫什么名字？")).toBe("npc_林静");
  });

  it("目标不在场 / 没在问名字 / 没有目标 → 不解锁", () => {
    expect(askedNameTargetId(world([npc("林静")], []), "npc_林静", "你叫什么名字？")).toBeNull();
    expect(askedNameTargetId(world([npc("林静")]), "npc_林静", "你好呀")).toBeNull();
    expect(askedNameTargetId(world([npc("林静")]), undefined, "你叫什么名字？")).toBeNull();
  });
});

describe("introducedPresentIds（自报姓名，v1/v2 共用）", () => {
  it("在场且自报姓名 → 返回 id；不在场不返回", () => {
    const entities = [npc("林静"), npc("白晓通")];
    expect(introducedPresentIds(world(entities, ["npc_林静"]), "林静：林静，安静的静。\n白晓通：白晓通，住三号楼。")).toEqual([
      "npc_林静",
    ]);
  });

  it("空文本 → 空数组", () => {
    expect(introducedPresentIds(world([npc("林静")]), "   ")).toEqual([]);
  });
});

describe("viewerSpeech（只还原玩家实际收到的 delivery）", () => {
  it("to 是玩家且 channels 含 content → 还原成「真名：台词」", () => {
    const state = world([npc("林静")]);
    const speech = viewerSpeech(state, "plr_1", [
      utterance({ to: "plr_1", speaker: "npc_林静", channels: ["content"], content: "林静，安静的静。" }),
    ]);
    expect(speech).toBe("林静：林静，安静的静。");
  });

  it("耳语给别的 NPC（to 不是玩家）→ 不计入（玩家没听见）", () => {
    const state = world([npc("林静"), npc("白晓通")]);
    expect(
      viewerSpeech(state, "plr_1", [
        utterance({ to: "npc_白晓通", speaker: "npc_林静", channels: ["content"], content: "我是林静" }),
      ]),
    ).toBe("");
  });

  it("玩家自己的交付不算解锁来源；channels 不含 content 时不拿正文判定", () => {
    const state = world([npc("林静")]);
    expect(
      viewerSpeech(state, "plr_1", [
        utterance({ to: "plr_1", speaker: "plr_1", channels: ["content"], content: "林静，安静。" }),
        utterance({ to: "plr_1", speaker: "npc_林静", channels: ["action"], content: "林静，安静的静。", action: "凑近耳语" }),
      ]),
    ).toBe("林静：凑近耳语");
  });
});

describe("第三人称问名（试玩反馈：问「另外一个叫什么」却永远学不到名字）", () => {
  it("玩家问另一个人 → 台词里说出的名字解锁（不必在场、不必自报）", () => {
    const entities = [npc("白晓通"), npc("林静")];
    const state = world(entities, []);
    const speech = "金满堂：另一个在三楼过刊那边的，叫白晓通。林静在流通台盖章呢。";
    expect(mentionedNpcIds(state, speech)).toEqual(["npc_白晓通", "npc_林静"]);
  });

  it("「名字：台词」的说话人标签不算提到", () => {
    const state = world([npc("白晓通")], []);
    expect(mentionedNpcIds(state, "白晓通：早上好啊。")).toEqual([]);
  });

  it("已认识的人不重复解锁", () => {
    const state = world([npc("白晓通", true)], []);
    expect(mentionedNpcIds(state, "叫白晓通。")).toEqual([]);
  });

  it("识别「另外一个人」的问法，普通闲聊不触发", () => {
    expect(isAskOtherNameInput("额另外一个叫什么？")).toBe(true);
    expect(isAskOtherNameInput("旁边那位是谁")).toBe(true);
    expect(isAskOtherNameInput("你叫什么名字")).toBe(true);
    expect(isAskOtherNameInput("今天天气不错")).toBe(false);
    expect(isAskOtherNameInput("去图书馆")).toBe(false);
  });
});
