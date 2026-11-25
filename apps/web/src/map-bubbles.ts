import type { MapChatter, MapNpc, MapView } from "./api.ts";

/** 气泡只贴在「当前地图里有坐标」的 NPC 头顶；找不到说话人就丢掉，最多留 max 条。 */
export function bubbleLines(
  map: Pick<MapView, "chatter" | "npcs">,
  max = 3,
): { line: MapChatter; npc: MapNpc }[] {
  const npcs = map.npcs ?? [];
  const out: { line: MapChatter; npc: MapNpc }[] = [];
  for (const line of map.chatter ?? []) {
    const npc = npcs.find((n) => n.id === line.speakerId);
    if (npc) out.push({ line, npc });
  }
  return out.slice(-max);
}
