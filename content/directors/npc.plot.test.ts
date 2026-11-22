/**
 * npc.plot 导演契约回归（PR #123 打回项 P0-D / P1-G / P2）。
 *
 * 只用真实 DialogueHost.step() 跑核心链路；断言 Proposal 的 op / 结构 / ownerId /
 * salience / 秘密通道与调用次数，不断言任何 LLM 生成的文案。
 */
import { describe, expect, it } from "vitest";
import { DialogueHost } from "@galgame/engine";
import { MockLlm } from "@galgame/llm";
import { makeCtx, makeRoom } from "@galgame/testkit";
import npcPlot, {
  actorPairs,
  activePlots,
  conspiracyProposals,
  discoveryProposals,
  pairLeaks,
} from "./npc.plot.ts";

const SECRET = "周野偷改了成绩";
const ACTORS = ["npc_lin", "npc_zhou"] as const;
const THREE = ["npc_lin", "npc_zhou", "npc_ma"];
const LEAKS = ["线索甲", "线索乙", "线索丙"];

function draft(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    goal: "试探口风别声张",
    actors: [...ACTORS],
    leakPoints: ["天台门没锁", "少了一张卷子"],
    forbidReveal: SECRET,
    ...overrides,
  });
}

function pairLines(actorIds: readonly string[]): string {
  return JSON.stringify({ lines: actorIds.map((actorId) => ({ actorId, text: "一句压低声音的短谈" })) });
}

async function openPlotSession(llm: MockLlm, participants: readonly string[] = ACTORS) {
  const host = new DialogueHost(() => makeCtx({ llm }), [npcPlot]);
  const session = await host.open({
    roomId: "room_test",
    participants: [...participants],
    directorId: "npc.plot",
    seed: {},
  });
  return { host, session };
}

describe("npc.plot 导演（真实链路 + 结构化断言）", () => {
  it("P0-D：首步即产出 plot.upsert + 每名参与者一条 memory.write", async () => {
    const llm = new MockLlm({ responses: [draft(), pairLines(ACTORS)] });
    const { host, session } = await openPlotSession(llm);
    const step = await host.step(session.id);

    expect(step.turn).toBe(1);
    expect(step.done).toBe(true);
    expect(step.proposals.map((p) => p.op)).toEqual(["plot.upsert", "memory.write", "memory.write"]);
    expect(step.utterances).toHaveLength(2);
    expect(llm.calls).toBe(2);

    const plotProposal = step.proposals[0];
    expect(plotProposal?.args.actors).toEqual([...ACTORS]);
    expect(plotProposal?.args.leakPoints).toHaveLength(2);
    expect(plotProposal?.args.forbidReveal).toBe(SECRET);

    const writes = step.proposals.filter((p) => p.op === "memory.write");
    expect(writes.map((p) => p.args.ownerId).sort()).toEqual([...ACTORS].sort());
    for (const w of writes) {
      expect(w.args.salience).toBe(5); // P2：不得超过 zod max(5)
      expect(w.args.visibility).toBe("private");
      expect(w.args.about).toHaveLength(1);
      expect(String(w.args.content)).not.toContain(SECRET); // 秘密只进 forbidReveal 通道
    }
  });

  it("P1-G：同一事实按 ownerId 不同叙述（只有一个线索也不复用正文）", () => {
    const plot = { goal: "g", actors: [...ACTORS], leakPoints: ["唯一线索"], forbidReveal: SECRET };
    const writes = conspiracyProposals(plot).filter((p) => p.op === "memory.write");
    expect(writes).toHaveLength(2);
    expect(writes.map((w) => w.args.ownerId)).toEqual([...ACTORS]);

    const contents = writes.map((w) => String(w.args.content));
    expect(new Set(contents).size).toBe(contents.length);
    expect(contents.every((c) => !c.includes(SECRET))).toBe(true);
  });

  it("真实链路多轮：仅首轮落 Proposal；每对摘要只带本对线索且不含秘密", async () => {
    const llm = new MockLlm({
      responses: [
        JSON.stringify({ goal: "g", actors: THREE, leakPoints: LEAKS, forbidReveal: SECRET }),
        pairLines([THREE[0], THREE[1]]),
        pairLines([THREE[0], THREE[2]]),
        pairLines([THREE[1], THREE[2]]),
      ],
    });
    const { host, session } = await openPlotSession(llm, THREE);

    const first = await host.step(session.id);
    expect(first.proposals.filter((p) => p.op === "plot.upsert")).toHaveLength(1);
    expect(first.proposals.filter((p) => p.op === "memory.write")).toHaveLength(THREE.length);
    expect(first.done).toBe(false);

    const second = await host.step(session.id);
    expect(second.proposals).toEqual([]);
    expect(second.utterances.length).toBeGreaterThan(0);
    expect(second.done).toBe(false);

    const third = await host.step(session.id);
    expect(third.proposals).toEqual([]);
    expect(third.done).toBe(true);
    expect(llm.calls).toBe(1 + actorPairs(THREE).length);

    const pairs = actorPairs(THREE);
    [first, second, third].forEach((step, i) => {
      const allowed = new Set(pairs[i]);
      for (const u of step.utterances) expect(allowed.has(u.actorId)).toBe(true);
    });

    const pairPrompts = llm.requests.slice(1).map((r) => r.messages.find((m) => m.role === "user")?.content ?? "");
    expect(pairPrompts).toHaveLength(3);
    pairPrompts.forEach((text, i) => {
      expect(text).toContain(LEAKS[i]);
      expect(text).not.toContain(SECRET);
      for (const other of LEAKS.filter((_, j) => j !== i)) expect(text).not.toContain(other);
    });
  });

  it("LLM 格式错误：安静降级为空结果，不抛异常也不产 Proposal", async () => {
    const llm = new MockLlm({ responses: ["not-json"] });
    const { host, session } = await openPlotSession(llm);
    const step = await host.step(session.id);
    expect(step.turn).toBe(1);
    expect(step.proposals).toEqual([]);
    expect(step.utterances).toEqual([]);
    // 草案失败时保持会话到下一轮收束（既不重试也不写状态）
    const closing = await host.step(session.id);
    expect(closing.proposals).toEqual([]);
    expect(closing.done).toBe(true);
    expect(llm.calls).toBe(1);
  });

  it("discoveryProposals：按 leakPoints 出 evidence；态度键未接线时不出 attr.delta", () => {
    const plot = { goal: "g", actors: [...ACTORS], leakPoints: ["线索一", "线索二"], forbidReveal: SECRET };
    const unwired = discoveryProposals(makeCtx(), plot, "observe");
    expect(unwired.ok).toBe(true);
    const writes = unwired.proposals.filter((p) => p.op === "memory.write");
    expect(writes).toHaveLength(2);
    for (const w of writes) {
      expect(w.args.ownerId).toBe("plr_self");
      expect(String(w.args.content)).not.toContain(SECRET);
    }
    expect(unwired.proposals.some((p) => p.op === "attr.delta")).toBe(false);
    expect(unwired.ui?.lists?.[0]?.items).toHaveLength(2);

    // 接线后按 moduleState 键生效，不硬编码属性名（I2）；这里仅验证 gated 行为。
    const state = makeRoom();
    state.moduleState["npc.plot.attitudeAttr"] = "guard";
    const wired = discoveryProposals(makeCtx({ state }), plot, "ask");
    expect(wired.proposals.filter((p) => p.op === "attr.delta")).toHaveLength(2);
    for (const d of wired.proposals.filter((p) => p.op === "attr.delta")) {
      expect(d.args).toMatchObject({ key: "guard", delta: 8 });
    }
  });

  it("activePlots：只返回 active 且带 leakPoints 的密谋", () => {
    const state = makeRoom();
    state.plots = [
      { id: "p1", goal: "g1", actors: [...ACTORS], leakPoints: ["l1"], status: "active" },
      { id: "p2", goal: "g2", actors: [...ACTORS], leakPoints: ["l2"], status: "resolved" },
      { id: "p3", goal: "g3", actors: [...ACTORS], status: "active" },
    ];
    const plots = activePlots(makeCtx({ state }));
    expect(plots).toHaveLength(1);
    expect(plots[0]?.leakPoints).toEqual(["l1"]);
  });

  it("actorPairs / pairLeaks：配对上限与线索分片", () => {
    expect(actorPairs(["a", "b"])).toEqual([["a", "b"]]);
    expect(actorPairs(["a", "b", "c", "d"])).toHaveLength(3);
    expect(pairLeaks(["甲", "乙", "丙", "丁"], 0)).toEqual(["甲", "丁"]);
    expect(pairLeaks(["甲", "乙", "丙", "丁"], 1)).toEqual(["乙"]);
    expect(pairLeaks(["甲"], 2)).toEqual([]);
  });
});
