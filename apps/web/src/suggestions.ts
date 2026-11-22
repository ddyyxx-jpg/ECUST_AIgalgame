/**
 * 每回合结束后的快捷行动建议（纯前端推导，不调模型、不改后端）。
 *
 * 建议只是**输入辅助**，不值得为它每回合多花一次模型调用；新增一条
 * "服务端 → 前端"的建议通道也要动契约版本（docs/03 是唯一名字来源）。
 * 这里只用服务端已经下发的 View 推导：当前场景的去处 + 在场的人。
 * kind 在生成时按来源写入：出口 → move，在场 NPC → talk；前端渲染层不再猜。
 *
 * 不重复的保证：不是"尽量避开上一轮"，而是**结构性不重叠**——
 * 每轮只从候选池里取一半（n = ⌊池子/2⌋，封顶 max），并按轮次步进 n 个位置。
 * 因为 2n ≤ 池子大小，相邻两轮选中的下标区间必然不相交，
 * 所以在同一地点连续待着也不会出现「上一轮刚给过、这一轮又来」的选项。
 * 池子只有 2 个时就退化成每轮 1 个、交替出现；只有 1 个时无法再拆（场景太单调）。
 */
import type { ViewPatch, WorldState } from "../../../packages/shared/src/contract/types.ts";
import type { Suggestion } from "./candidates.ts";

type Pos = ViewPatch["position"];

/**
 * v2 的 view.position 在默认路径里几乎为空（#139 审阅 P2-7），但会话事实里有可靠投影：
 * state.room.scene.presentIds 是在场实体，state.entities 里有展示名。
 * 这里把「服务端会话状态」投影成与 ViewPosition 同形的候选池来源，并且只用于推导建议；
 * 权威画面仍由服务端下发，不缓存、不伪造 view.position。
 */
export function positionFromState(state: WorldState | null, selfId: string): Pos | undefined {
  if (!state) return undefined;
  const present = state.room.scene.presentIds;
  return {
    locId: state.room.scene.locId,
    name: state.entities[state.room.scene.locId]?.name ?? state.room.scene.locId,
    actors: present.map((id) => ({
      actorId: id,
      name: state.entities[id]?.name ?? "",
      present: true,
    })),
    // v2 没有可靠的出口投影：宁可只给"和在场 NPC 说话"，也不编造不存在的去处。
    exits: [],
  };
}

/** 候选池：当前场景能去的地方 + 能说话的人（自己除外，不在场的人不算） */
function buildPool(pos: Pos | undefined, selfId: string): Suggestion[] {
  if (!pos) return [];
  const out: Suggestion[] = [];
  for (const e of pos.exits) out.push({ text: `去${e.name}`, kind: "move" });
  for (const a of pos.actors) {
    if (a.present && a.actorId !== selfId && a.name.length > 0) {
      out.push({ text: `和${a.name}说话`, kind: "talk" });
    }
  }
  return out;
}

/**
 * @param pos    服务端下发的当前位置（没连上时可能为 undefined）
 * @param round  已经进行到第几回合（≥1）；决定从池子的哪一段开始取
 * @param selfId 玩家自己的 actorId（由服务端签发），用来把自己从"能说话的人"里排掉
 * @param max    本轮最多给几条建议
 */
export function turnSuggestions(
  pos: Pos | undefined,
  round: number,
  selfId: string,
  max = 3,
): Suggestion[] {
  const all = buildPool(pos, selfId);

  // 一个能推进世界的候选都没有（空旷场景）：宁可不给，也别拿「环顾四周」凑数——
  // 这类动作不改任何世界状态，模型只能把同一间屋子重写一遍，读起来就是原地打转。
  if (all.length === 0) return [];

  const n = Math.min(max, Math.max(1, Math.floor(all.length / 2)));
  const start = (((round * n) % all.length) + all.length) % all.length;

  const out: Suggestion[] = [];
  for (let i = 0; i < n; i++) out.push(all[(start + i) % all.length]!);
  return out;
}
