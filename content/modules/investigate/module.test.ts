/**
 * investigate 模块契约测试：只断言 Proposal 的 op / 结构，不断言文案。
 * 覆盖：正常调查（证据 + 态度/幂等标记）、无密谋、非法 kind 回退、工具分发、重启语义。
 */
import { describe, expect, it } from "vitest";
import { makeCtx, makeRoom } from "@galgame/testkit";
import type { Plot } from "../../../packages/shared/src/contract/types.ts";
import investigate from "./module.ts";
import { discoveryProposals } from "../../directors/npc.plot.ts";
import configJson from "./data/config.json" with { type: "json" };

const SECRET = "不可直说的真相";
const ATTITUDE_KEY = "guard"; // 测试里显式传入的键，代码本身不硬编码（I2）
const ACTOR_ID = "plr_self";
const MARKER_ID = configJson.markerIdTemplate.replace("{plot}", "plot_test").replace("{actor}", ACTOR_ID);

function plotState(): ReturnType<typeof makeRoom> {
  const state = makeRoom();
  state.plots = [
    {
      id: "plot_test",
      goal: "g",
      actors: ["npc_lin", "npc_zhou"],
      leakPoints: ["线索一", "线索二"],
      forbidReveal: SECRET,
      status: "active",
    } satisfies Plot,
  ];
  return state;
}

/** 模拟真实 turn 提交后的状态投影：entity.create/update 落进 WorldState（引擎 projection.ts:128-132）。 */
function applyMarker(state: ReturnType<typeof makeRoom>, out: { proposals: { op: string; args: Record<string, unknown> }[] }) {
  for (const p of out.proposals) {
    if (p.op === "entity.create" && p.args.id === MARKER_ID) {
      state.entities[MARKER_ID] = {
        id: MARKER_ID, kind: "fact", name: "已调查标记", attrs: {},
        tags: p.args.tags as string[], origin: "system", canon: false, status: "active", createdAt: 0, updatedAt: 0,
      };
    }
    if (p.op === "entity.update" && p.args.entityId === MARKER_ID && state.entities[MARKER_ID]) {
      state.entities[MARKER_ID]!.tags = p.args.tags as string[];
    }
  }
}

describe("investigate 模块（Proposal 结构断言）", () => {
  it("intent：按 active plot 的 leakPoints 产出 evidence 记忆 + 态度 attr.delta", async () => {
    const ctx = makeCtx({ state: plotState(), input: "调查" });
    const out = await investigate.intent?.(ctx);
    expect(out?.ok).toBe(true);
    expect(out?.proposals.filter((p) => p.op === "memory.write")).toHaveLength(2);
    const deltas = out?.proposals.filter((p) => p.op === "attr.delta") ?? [];
    expect(deltas).toHaveLength(2);
    expect(deltas.every((p) => p.args.key === ATTITUDE_KEY)).toBe(true);
    // P2-1：delta 必须来自 config.json，而不是导演里的硬编码默认值。
    expect(deltas.every((p) => p.args.delta === configJson.delta)).toBe(true);
    for (const w of out?.proposals.filter((p) => p.op === "memory.write") ?? []) {
      expect(String(w.args.content)).not.toContain(SECRET);
      expect(w.args.ownerId).toBe("plr_self");
    }
    expect(out?.ui?.lists?.[0]?.items).toHaveLength(2);
  });

  it("kind 词表来自 config.json：命中 search/ask 词分别产出对应 tag；未命中回退 observe", async () => {
    const searchWord = configJson.kindPatterns.search[0];
    const askWord = configJson.kindPatterns.ask[0];
    const s = await investigate.intent?.(makeCtx({ state: plotState(), input: `我${searchWord}一下` }));
    expect(s?.proposals.filter((p) => p.op === "memory.write").every((p) => (p.args.tags as string[]).includes("search"))).toBe(true);
    const a = await investigate.intent?.(makeCtx({ state: plotState(), input: `我${askWord}他` }));
    expect(a?.proposals.filter((p) => p.op === "memory.write").every((p) => (p.args.tags as string[]).includes("ask"))).toBe(true);
    const o = await investigate.intent?.(makeCtx({ state: plotState(), input: "随便看看" }));
    expect(o?.proposals.filter((p) => p.op === "memory.write").every((p) => (p.args.tags as string[]).includes("observe"))).toBe(true);
  });

  it("无 active plot：ok:true + 空 Proposal", async () => {
    const out = await investigate.intent?.(makeCtx({ input: "调查" }));
    expect(out?.ok).toBe(true);
    expect(out?.proposals).toEqual([]);
  });

  it("tool：非法 kind 回退为 observe；未知工具返回 E_TOOL_UNKNOWN", async () => {
    const ctx = makeCtx({ state: plotState(), input: "" });
    const ok = await investigate.tool?.(TOOL_NAME, { kind: "nonsense" }, ctx);
    expect(ok?.ok).toBe(true);
    expect(ok?.proposals.some((p) => p.op === "memory.write")).toBe(true);

    const unknown = await investigate.tool?.("investigate.unknown", {}, ctx);
    expect(unknown?.ok).toBe(false);
    expect(unknown?.error?.code).toBe("E_TOOL_UNKNOWN");
  });

  // ------------------------------------------------------------ PR #147 P2-4 / P1-3
  it("连续两次调查同一 plot：证据/态度不重复，第二次 ok:true + 已查过 fact", async () => {
    const state = plotState();
    const first = await investigate.intent?.(makeCtx({ state, input: "调查线索" }));
    expect(first?.proposals.filter((p) => p.op === "memory.write")).toHaveLength(2);
    applyMarker(state, first!);

    const second = await investigate.intent?.(makeCtx({ state, input: "调查线索" }));
    expect(second?.ok).toBe(true);
    expect(second?.proposals.filter((p) => p.op === "memory.write")).toHaveLength(0);
    expect(second?.proposals.filter((p) => p.op === "attr.delta")).toHaveLength(0);
    // 断言 fact 的结构（存在且非空），不断言具体文案。
    expect(second?.facts?.length).toBeGreaterThan(0);
  });

  it("查完全部 leakPoints：产出 plot.upsert(status=leaked) 且带全字段", async () => {
    const state = plotState();
    const out = await investigate.intent?.(makeCtx({ state, input: "调查线索" }));
    const upserts = out?.proposals.filter((p) => p.op === "plot.upsert") ?? [];
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.args).toMatchObject({
      id: "plot_test",
      goal: "g",
      actors: ["npc_lin", "npc_zhou"],
      leakPoints: ["线索一", "线索二"],
      forbidReveal: SECRET,
      status: "leaked",
    });
  });

  it("只查一部分 leakPoints：不产出 plot.upsert", () => {
    const plot = { id: "plot_partial", goal: "g", actors: ["npc_lin", "npc_zhou"], leakPoints: ["线索一", "线索二"], forbidReveal: SECRET };
    const out = discoveryProposals(makeCtx(), plot, "observe", { leakIndices: [0] });
    expect(out.proposals.some((p) => p.op === "plot.upsert")).toBe(false);
    expect(out.proposals.filter((p) => p.op === "memory.write")).toHaveLength(1);
    expect(out.allInvestigated).toBe(false);
  });

  it("重启语义：新建 ctx 再查仍幂等（标记存 WorldState 而非进程内 Map）", async () => {
    const state = plotState();
    const first = await investigate.intent?.(makeCtx({ state, input: "调查线索" }));
    applyMarker(state, first!);
    // 全新 ctx + 深拷贝世界状态（等价于新进程读到同一份存档）
    const restarted = await investigate.intent?.(makeCtx({ state: structuredClone(state), input: "调查线索" }));
    expect(restarted?.ok).toBe(true);
    expect(restarted?.proposals.filter((p) => p.op === "memory.write")).toHaveLength(0);
    expect(restarted?.proposals.filter((p) => p.op === "attr.delta")).toHaveLength(0);
    expect(restarted?.facts?.length).toBeGreaterThan(0);
  });
});

const TOOL_NAME = "investigate.probe";
