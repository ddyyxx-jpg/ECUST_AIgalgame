import { describe, expect, it } from "vitest";
import { hudStats } from "./hud-stats.ts";

describe("hudStats", () => {
  it("把行动点提到最前，并保留其余顺序", () => {
    const rows = [
      { label: "体力", value: 80 },
      { label: "金钱", value: 20 },
      { label: "行动点", value: 6, unit: "次" },
      { label: "名声", value: 3 },
    ];
    expect(hudStats(rows).map((r) => r.label)).toEqual(["行动点", "体力", "金钱", "名声"]);
  });

  it("按 registry key 优先识别行动点，不依赖中文 label", () => {
    const rows = [
      { label: "体力", value: 80 },
      { key: "action_points", label: "AP", value: 3, unit: "次" },
    ];
    expect(hudStats(rows)[0]).toMatchObject({ key: "action_points", label: "AP" });
  });

  it("没有行动点时原样截断", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ label: `a${i}`, value: i }));
    expect(hudStats(rows).map((r) => r.label)).toEqual(["a0", "a1", "a2", "a3", "a4"]);
  });
});
