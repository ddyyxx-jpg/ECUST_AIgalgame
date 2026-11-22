/**
 * study 模块验收（#97）：正常 / 越界 / 抛错被隔离 + 宿主自动发现与触发分发。
 * 只断言 Proposal 结构与错误码，不断言文案（AGENTS.md 铁律 7）。
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ModuleHost } from "../../../packages/engine/src/modules.ts";
import { OP_NAMES } from "../../../packages/shared/src/contract/types.ts";
import { makeCtx, SELF_ID } from "../../../packages/testkit/src/index.ts";
import studyModule from "./module.ts";

const MODULES_DIR = path.join(process.cwd(), "content/modules");

describe("study 模块最小骨架", () => {
  it("正常：intent / tool / night trigger 都只产合法 entity.create Proposal", async () => {
    const ctx = makeCtx({ input: "我要自习", actorId: SELF_ID });
    const viaIntent = await studyModule.intent?.(ctx);
    expect(viaIntent?.ok).toBe(true);
    expect(viaIntent?.proposals).toHaveLength(1);
    expect(viaIntent?.proposals[0]?.op).toBe("entity.create");
    expect(viaIntent?.proposals[0]?.args).toMatchObject({ kind: "item", tags: ["study"], canon: false });
    expect(OP_NAMES).toContain(viaIntent?.proposals[0]?.op);

    const host = new ModuleHost({ dir: MODULES_DIR });
    await host.load();
    const viaTool = await host.callTool("study.quiz", { count: 2 }, ctx);
    expect(viaTool.ok).toBe(true);
    expect(viaTool.proposals).toHaveLength(1);
    expect(OP_NAMES).toContain(viaTool.proposals[0]?.op ?? "");

    expect(await studyModule.tick?.(ctx, "morning")).toEqual([]);
    const night = await studyModule.tick?.(ctx, "night");
    expect(night?.[0]?.op).toBe("entity.create");
  });

  it("越界：count 不在 1..5 → E_OUT_OF_RANGE，零 Proposal", async () => {
    const ctx = makeCtx({ input: "刷题", actorId: SELF_ID });
    const host = new ModuleHost({ dir: MODULES_DIR });
    await host.load();
    for (const count of [0, -1, 6, 1.5, "3"]) {
      const out = await host.callTool("study.quiz", { count }, ctx);
      expect(out.ok, `count=${String(count)}`).toBe(false);
      expect(out.error?.code, `count=${String(count)}`).toBe("E_OUT_OF_RANGE");
      expect(out.proposals).toEqual([]);
    }
  });

  it("抛错被隔离：宿主把模块异常收敛为 E_MODULE_FAULT，后续调用仍正常", async () => {
    const ctx = makeCtx({ input: "自习", actorId: SELF_ID });
    const host = new ModuleHost({ dir: MODULES_DIR });
    await host.load();
    expect(host.get("study")?.loaded).toBe(true);
    expect(host.get("study")?.fault).toBeUndefined();

    const thrown = await host.callTool("study.quiz", null, ctx);
    expect(thrown.ok).toBe(false);
    expect(thrown.error?.code).toBe("E_MODULE_FAULT");
    expect(thrown.proposals).toEqual([]);

    const recovered = await host.callTool("study.quiz", { count: 1 }, ctx);
    expect(recovered.ok).toBe(true);
    expect(recovered.proposals[0]?.op).toBe("entity.create");
  });
});
