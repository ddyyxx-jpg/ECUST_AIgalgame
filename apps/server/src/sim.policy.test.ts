import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSimPolicy } from "./sim.policy.ts";

async function contentWith(policy: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "galgame-sim-policy-"));
  await mkdir(path.join(dir, "sim"), { recursive: true });
  await writeFile(path.join(dir, "sim", "policy.json"), JSON.stringify(policy));
  return dir;
}

describe("loadSimPolicy", () => {
  it("读取行动点与时钟配置", async () => {
    const dir = await contentWith({
      schemaVersion: 1,
      actionPoints: { enabled: true, attr: "action_points", perTurn: 1, max: 6 },
      clock: { enabled: true, intervalMs: 30000, ticksPerBeat: 2, maxTick: 20 },
      talkLeaseTicks: 5,
    });
    const policy = await loadSimPolicy(dir);
    expect(policy).toMatchObject({
      actionAttr: "action_points",
      actionCostPerTurn: 1,
      actionMax: 6,
      talkLeaseTicks: 5,
      clock: { enabled: true, intervalMs: 30000, ticksPerBeat: 2, maxTick: 20 },
    });
  });

  it("读取 NPC 自由活动决策；只配 decision 时也返回策略（时钟未开则不跑）", async () => {
    const dir = await contentWith({
      decision: { enabled: true, maxPerBeat: 1, intervalTicks: 4, hourlyCalls: 6, maxOptions: 3 },
    });
    const policy = await loadSimPolicy(dir);
    expect(policy).toMatchObject({
      actionCostPerTurn: 0,
      decision: { enabled: true, maxPerBeat: 1, intervalTicks: 4, hourlyCalls: 6, maxOptions: 3 },
    });
    expect(policy?.clock).toBeUndefined();
  });

  it("只配 clock 时也能启动自动时钟（行动点代价为 0）", async () => {
    const dir = await contentWith({ clock: { enabled: true, intervalMs: 60000, ticksPerBeat: 1, maxTick: 24 } });
    const policy = await loadSimPolicy(dir);
    expect(policy).toMatchObject({
      actionCostPerTurn: 0,
      actionMax: 0,
      refillOnPhaseAdvance: false,
      talkLeaseTicks: 12,
      clock: { enabled: true },
    });
  });

  it("缺文件/坏 JSON/行动点关闭都返回 undefined", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "galgame-sim-empty-"));
    expect(await loadSimPolicy(empty)).toBeUndefined();
    const bad = await contentWith({ actionPoints: { enabled: true, attr: "", perTurn: 99, max: -1 } });
    expect(await loadSimPolicy(bad)).toBeUndefined();
    const off = await contentWith({ actionPoints: { enabled: false, attr: "action_points", perTurn: 1, max: 6 } });
    expect(await loadSimPolicy(off)).toBeUndefined();
  });
});
