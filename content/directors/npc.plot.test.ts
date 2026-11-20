/**
 * npc.plot 导演契约（issue #96 / PR #123 P0-D、P1-G）：
 * - 首轮真的产 plot.upsert + 每人一条私忆（turn 由宿主推进，导演不再 +1）；
 * - 每条私忆正文不同，秘密原文只进 forbidReveal；
 * - 用真 DialogueHost 跑，轮次/收尾交给引擎骨架。
 */
import { describe, expect, it } from "vitest";
import { DialogueHost } from "@galgame/engine";
import { makeCtx } from "@galgame/testkit";
import { MockLlm } from "@galgame/llm";
import type { Proposal } from "../../packages/shared/src/contract/types.ts";
import npcPlot from "./npc.plot.ts";

const DRAFT = {
  goal: "让玩家在值班表上签字",
  actors: ["npc_lin", "npc_ma", "npc_qi"],
  leverage: "林月知道马骁缺勤",
  risk: 30,
  tone: "试探",
  leakPoints: ["值班表被撕过一角"],
  forbidReveal: "钥匙藏在花坛下面",
};
const PAIR_1 = { lines: [{ actorId: "npc_lin", text: "今晚别走正门。" }, { actorId: "npc_ma", text: "我知道是谁。" }] };
const PAIR_2 = { lines: [{ actorId: "npc_lin", text: "别让齐老师看见。" }, { actorId: "npc_qi", text: "我什么都没听见。" }] };
const PAIR_3 = { lines: [{ actorId: "npc_ma", text: "值班表是你撕的？" }, { actorId: "npc_qi", text: "小声点。" }] };

function makeHost(llm: MockLlm): DialogueHost {
  return new DialogueHost(() => makeCtx({ llm }), [npcPlot]);
}

describe("npc.plot 导演", () => {
  it("首轮产出密谋与多视角私忆；turn 从 1 开始（P0-D）", async () => {
    const llm = new MockLlm({ responses: [DRAFT, PAIR_1, PAIR_2, PAIR_3].map((x) => JSON.stringify(x)) });
    const host = makeHost(llm);
    const session = await host.open({
      roomId: "room_plot",
      participants: ["npc_lin", "npc_ma", "npc_qi"],
      directorId: "npc.plot",
      seed: {},
    });

    const first = await host.step(session.id);
    expect(first.turn).toBe(1);
    expect(first.done).toBe(false);

    const ops = first.proposals.map((p: Proposal) => p.op);
    expect(ops.filter((op) => op === "plot.upsert")).toHaveLength(1);
    expect(ops.filter((op) => op === "memory.write")).toHaveLength(3);
    // 三视角私忆正文互不相同（P1-G：原先只有前缀不同）
    const memories = first.proposals.filter((p: Proposal) => p.op === "memory.write").map((p) => JSON.stringify(p.args));
    expect(new Set(memories).size).toBe(3);
    // 秘密原文只能出现在 forbidReveal 通道，不进台词
    for (const u of first.utterances) expect(u.text).not.toContain(DRAFT.forbidReveal);
    expect(first.utterances).toHaveLength(2);

    // 后续轮按配对继续，最后一对收尾
    const second = await host.step(session.id);
    expect(second.turn).toBe(2);
    expect(second.proposals).toEqual([]);
    const third = await host.step(session.id);
    expect(third.turn).toBe(3);
    expect(third.done).toBe(true);
  });

  it("LLM 返回坏 JSON 时安静降级，不抛异常", async () => {
    const host = makeHost(new MockLlm({ responses: ["not-json"] }));
    const session = await host.open({
      roomId: "room_plot",
      participants: ["npc_lin", "npc_ma"],
      directorId: "npc.plot",
      seed: {},
    });
    const step = await host.step(session.id);
    expect(step.turn).toBe(1);
    expect(step.proposals).toEqual([]);
    expect(step.utterances).toEqual([]);
  });
});
