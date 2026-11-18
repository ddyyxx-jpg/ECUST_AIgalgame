import { describe, expect, it } from "vitest";
import { muttersByNpcId } from "./api-gallery.ts";
import type { GalleryNpc } from "./api-gallery.ts";

function galleryNpc(id: string, met: boolean, mutter?: string): GalleryNpc {
  return {
    id,
    name: id,
    met,
    present: true,
    stats: [],
    ...(mutter !== undefined ? { mutter } : {}),
  };
}

describe("muttersByNpcId（地图气泡只读已认识的 NPC）", () => {
  it("只有 met=true 且带 mutter 的 NPC 进气泡表", () => {
    expect(
      muttersByNpcId([
        galleryNpc("npc_a", true, "今天也没人来借书……"),
        galleryNpc("npc_b", false, "这事得压下来。"),
        galleryNpc("npc_c", true),
      ]),
    ).toEqual({ npc_a: "今天也没人来借书……" });
  });

  it("空图鉴 / 没有 mutter：返回空表（不出气泡，保持降级）", () => {
    expect(muttersByNpcId([])).toEqual({});
    expect(muttersByNpcId([galleryNpc("npc_a", false), galleryNpc("npc_b", true)])).toEqual({});
  });
});
