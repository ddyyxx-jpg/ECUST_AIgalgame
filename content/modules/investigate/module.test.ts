/**
 * investigate 模块契约测试：只断言 Proposal 的 op / 结构，不断言文案。
 * 覆盖：正常调查（证据 + 态度）、无密谋、非法 kind 回退、工具分发与错误码。
 */
import { describe, expect, it } from "vitest";
import { makeCtx, makeRoom } from "@galgame/testkit";
import type { Plot } from "../../../packages/shared/src/contract/types.ts";
import investigate from "./module.ts";

const SECRET = "不可直说的真相";
const ATTITUDE_KEY = "guard"; // 测试里显式传入的键，代码本身不硬编码（I2）

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

describe("investigate 模块（Proposal 结构断言）", () => {
  it("intent：按 active plot 的 leakPoints 产出 evidence 记忆 + 态度 attr.delta", async () => {
    const ctx = makeCtx({ state: plotState(), input: "调查" });
    const out = await investigate.intent?.(ctx);
    expect(out?.ok).toBe(true);
    expect(out?.proposals.filter((p) => p.op === "memory.write")).toHaveLength(2);
    const deltas = out?.proposals.filter((p) => p.op === "attr.delta") ?? [];
    expect(deltas).toHaveLength(2);
    expect(deltas.every((p) => p.args.key === ATTITUDE_KEY)).toBe(true);
    for (const w of out?.proposals.filter((p) => p.op === "memory.write") ?? []) {
      expect(String(w.args.content)).not.toContain(SECRET);
      expect(w.args.ownerId).toBe("plr_self");
    }
    expect(out?.ui?.lists?.[0]?.items).toHaveLength(2);
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
});

const TOOL_NAME = "investigate.probe";
