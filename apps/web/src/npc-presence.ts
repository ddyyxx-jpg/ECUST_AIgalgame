/**
 * 「点这个 NPC 会发生什么」的纯函数（issue #21-1：场景隔离）。
 *
 * 2D 地图上画的是所有 NPC（`MapView.npcs` 带各自 `locId`），但对话只允许发生在
 * 玩家当前场景里。点不在场的人时不再直接开聊，而是给出「TA 不在这里 + 前往所在地」。
 * 判定逻辑单独成文件，便于用 vitest 直接测（不需要 jsdom/组件渲染）。
 */

export interface NpcLite {
  id: string;
  name: string;
  /** NPC 当前所在场景（`located_in` 指向的 loc id）；空串 = 数据缺失 */
  locId: string;
}

export interface SceneLite {
  id: string;
  name: string;
}

export type NpcTalkPlan =
  /** 就在当前场景：正常打开对话 */
  | { kind: "present"; npc: NpcLite }
  /** 在别的场景：提示 + 「前往 TA 所在地」 */
  | { kind: "elsewhere"; npc: NpcLite; locId: string; locName: string }
  /** 位置缺失/场景表里找不到：禁用前往，只说明原因 */
  | { kind: "unlocatable"; npc: NpcLite | null; name: string; reason: string };

export function planNpcTalk(
  npcs: readonly NpcLite[],
  scenes: readonly SceneLite[],
  npcId: string,
  fallbackName: string,
  currentLocId: string,
): NpcTalkPlan {
  const npc = npcs.find((n) => n.id === npcId) ?? null;
  if (!npc) {
    return { kind: "unlocatable", npc: null, name: fallbackName, reason: "档案里没有这个人" };
  }
  const name = npc.name || fallbackName;
  const locId = (npc.locId ?? "").trim();
  if (!locId) {
    return { kind: "unlocatable", npc, name, reason: "不知道 TA 现在在哪" };
  }
  // 先判"同场景"：哪怕这次 map 请求里没有场景模板，当前所在地就是玩家脚下
  if (currentLocId && locId === currentLocId) return { kind: "present", npc };

  const scene = scenes.find((s) => s.id === locId);
  if (!scene) {
    return { kind: "unlocatable", npc, name, reason: "TA 所在地没有对应的地图点位" };
  }
  return { kind: "elsewhere", npc, locId, locName: scene.name };
}
