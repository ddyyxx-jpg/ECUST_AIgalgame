/**
 * 每回合结束后的快捷行动建议（纯前端推导，不调模型、不改后端）。
 *
 * 建议只是**输入辅助**，不值得为它每回合多花一次模型调用；新增一条
 * "服务端 → 前端"的建议通道也要动契约版本（docs/03 是唯一名字来源）。
 * 这里只用服务端已经下发的 View/WorldState 推导：当前场景的去处 + 在场的人。
 * 出口只认 state.links 里两端都是活跃 loc 的 located_in（与 map 模块同一套邻接语义），
 * 在场者只认 kind==="npc" 且 status==="active" 的实体；没有真实数据来源就不写。
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
  const here = state.room.scene.locId;
  const present = state.room.scene.presentIds;
  const actors = present.flatMap((id) => {
    const entity = state.entities[id];
    if (!entity || entity.kind !== "npc" || entity.status !== "active") return [];
    return [{ actorId: id, name: entity.name, present: true }];
  });
  // located_in 双向邻接，且只连"活跃 loc ↔ 活跃 loc"：NPC 自己的 located_in 不是出口。
  const seen = new Set<string>();
  const exits: NonNullable<Pos>["exits"] = [];
  for (const link of state.links) {
    if (link.kind !== "located_in") continue;
    const from = state.entities[link.from];
    const to = state.entities[link.to];
    const neighbor = from?.id === here && to?.kind === "loc" && to.status === "active"
      ? to
      : to?.id === here && from?.kind === "loc" && from.status === "active"
        ? from
        : undefined;
    if (!neighbor || seen.has(neighbor.id)) continue;
    seen.add(neighbor.id);
    exits.push({ locId: neighbor.id, name: neighbor.name });
  }
  return {
    locId: here,
    name: state.entities[here]?.name ?? here,
    actors,
    exits,
  };
}

/**
 * 选候选用的位置：travel 后 view.position 可能还是 actors/exits 皆空的旧快照
 * （App.enterScene 只改 locId/name），此时有 state 投影就用 state 的，避免候选整块消失。
 */
export function candidatePosition(pos: Pos | undefined, state: WorldState | null, selfId: string): Pos | undefined {
  // 位置也会过期：enterScene 只改 locId/name，旧 pos 的 actors/exits 仍是上一个地点的。
  // 只要 pos 和权威 state 不在同一场景，就以 state 投影为准（PR #149 复审 P2-2）。
  if (state && pos && pos.locId !== state.room.scene.locId) return positionFromState(state, selfId) ?? pos;
  if (pos?.actors.length || pos?.exits.length) return pos;
  return positionFromState(state, selfId) ?? pos;
}

/**
 * 候选池：只放「能和谁说句话」（自己除外，不在场的人不算）。
 *
 * 场景移动一律不進候选：走哪个门、什么时候走由玩家自己在地图/场景里点，
 * 候选按钮只做“输入辅助”，不替玩家做移动决定（试玩反馈：候选人里出现「去操场」，
 * 一点就把人搬走，和手动地图传送抢控制权）。
 */
function buildPool(pos: Pos | undefined, selfId: string): Suggestion[] {
  if (!pos) return [];
  const out: Suggestion[] = [];
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
