import { describe, expect, it } from "vitest";
import { bubbleLines } from "./map-bubbles.ts";
import type { MapChatter, MapNpc } from "./api.ts";

const npc = (id: string): MapNpc => ({ id, name: id, x: 1, y: 2 } as unknown as MapNpc);
const line = (speakerId: string, text: string): MapChatter => ({ speakerId, speaker: speakerId, text, locId: "loc_a" } as unknown as MapChatter);

describe("bubbleLines", () => {
  it("丢掉不在当前地图的说话人", () => {
    const got = bubbleLines({ chatter: [line("npc_a", "在"), line("npc_x", "不在")], npcs: [npc("npc_a")] });
    expect(got.map((b) => b.line.text)).toEqual(["在"]);
  });
  it("最多保留 max 条（默认 3）", () => {
    const chatter = [1, 2, 3, 4].map((i) => line("npc_a", String(i)));
    expect(bubbleLines({ chatter, npcs: [npc("npc_a")] }).map((b) => b.line.text)).toEqual(["2", "3", "4"]);
    expect(bubbleLines({ chatter, npcs: [npc("npc_a")] }, 2).map((b) => b.line.text)).toEqual(["3", "4"]);
  });
  it("没有 chatter 时返回空数组", () => {
    expect(bubbleLines({ npcs: [npc("npc_a")] })).toEqual([]);
  });
});
