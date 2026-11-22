import { describe, expect, it, vi } from "vitest";
import type { ModuleContext, ModuleInfo, ModuleManifest, ModuleOutcome, Proposal } from "../../shared/src/index.ts";
import { limitProposals, ModuleHost } from "./modules.ts";

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

  function hostWith(manifest: ModuleManifest, outcome: ModuleOutcome): { host: ModuleHost; id: ModuleInfo["id"] } {
    const host = new ModuleHost({ dir: "/tmp/galgame-no-modules" });
    const id = manifest.id;
    const privateHost = host as unknown as { infos: Map<string, ModuleInfo>; impl: Map<string, { intent: () => ModuleOutcome; tool: () => ModuleOutcome }> };
    privateHost.infos.set(id, { id, manifest, loaded: true });
    privateHost.impl.set(id, { intent: () => outcome, tool: () => outcome });
    return { host, id };
  }

  function ctx(input: string): ModuleContext {
    return { input } as ModuleContext;
  }

  const fiveItem = () => prop(1, { presentIds: ["a", "b", "c", "d", "e"], note: "x" });

  it("intent 路径：提案数未超但数组超限时，dispatchIntent 返回裁剪后的数组", async () => {
    const manifest: ModuleManifest = {
      id: "demo" as ModuleInfo["id"], name: "demo", version: "0.0.0", apiVersion: 3, priority: 100,
      capabilities: { intents: ["demo.pick"], keywords: ["pick"] }, limits: { maxArrayItems: 2 },
    };
    const { host } = hostWith(manifest, { ok: true, proposals: [fiveItem()] });
    const out = await host.dispatchIntent(ctx("pick"));
    expect(out.ok).toBe(true);
    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0]?.args.presentIds).toEqual(["a", "b"]);
    expect(out.proposals[0]?.args.note).toBe("x");
  });

  it("tool 路径：提案数未超但数组超限时，callTool 返回裁剪后的数组", async () => {
    const manifest: ModuleManifest = {
      id: "demo" as ModuleInfo["id"], name: "demo", version: "0.0.0", apiVersion: 3, priority: 100,
      capabilities: { tools: ["demo.pick"] }, limits: { maxArrayItems: 2 },
    };
    const { host } = hostWith(manifest, { ok: true, proposals: [fiveItem()] });
    const out = await host.callTool("demo.pick", {}, ctx(""));
    expect(out.ok).toBe(true);
    expect(out.proposals[0]?.args.presentIds).toEqual(["a", "b"]);
  });

  it("tool 路径保留 error 语义；提案数超限时 warn 仍含 E_OVER_LIMIT", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manifest: ModuleManifest = {
      id: "demo" as ModuleInfo["id"], name: "demo", version: "0.0.0", apiVersion: 3, priority: 100,
      capabilities: { tools: ["demo.pick"] }, limits: { proposalsPerTurn: 1 },
    };
    const failed: ModuleOutcome = { ok: false, proposals: [], error: { code: "E_DENY", message: "no" } };
    const { host } = hostWith(manifest, failed);
    const toolOut = await host.callTool("demo.pick", {}, ctx(""));
    expect(toolOut.ok).toBe(false);
    expect(toolOut.error?.code).toBe("E_DENY");

    const over: ModuleOutcome = { ok: true, proposals: [prop(1), prop(2)] };
    const { host: overHost } = hostWith(manifest, over);
    await overHost.callTool("demo.pick", {}, ctx(""));
    expect(String(warn.mock.calls[0]?.[0])).toContain("E_OVER_LIMIT");
    warn.mockRestore();
  });
});
