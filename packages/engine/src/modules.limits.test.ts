import { describe, expect, it, vi } from "vitest";
import type { ModuleInfo, ModuleManifest, Proposal } from "../../shared/src/index.ts";
import { limitProposals } from "./modules.ts";

function info(limits: ModuleManifest["limits"]): Pick<ModuleInfo, "id" | "manifest"> {
  return { id: "demo" as ModuleInfo["id"], manifest: { id: "demo", name: "demo", version: "0.0.0", apiVersion: 3, priority: 100, limits } };
}

const prop = (i: number, args: Proposal["args"] = {}): Proposal => ({ op: "attr.delta", args: { entityId: `e${i}`, key: "stamina", delta: 1, ...args }, reason: "t" });

describe("manifest.limits 兜底（docs/01 §3）", () => {
  it("proposalsPerTurn 超出时截断并 warn 含 E_OVER_LIMIT", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = limitProposals(info({ proposalsPerTurn: 2 }), [prop(1), prop(2), prop(3)]);
    expect(out).toHaveLength(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain("E_OVER_LIMIT");
    warn.mockRestore();
  });

  it("未超限时原样返回（不复制、不 warn）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = [prop(1)];
    expect(limitProposals(info({ proposalsPerTurn: 2 }), input)).toEqual(input);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("maxArrayItems 截数组 args（presentIds/tags），标量与未超限数组不动", () => {
    const out = limitProposals(info({ maxArrayItems: 2 }), [
      prop(1, { presentIds: ["a", "b", "c"], note: "x", tags: ["t1"] }),
    ]);
    expect(out[0]?.args.presentIds).toEqual(["a", "b"]);
    expect(out[0]?.args.tags).toEqual(["t1"]);
    expect(out[0]?.args.note).toBe("x");
  });

  it("limits 缺省时不设上限", () => {
    expect(limitProposals(info(undefined), [prop(1), prop(2), prop(3)])).toHaveLength(3);
  });
});
