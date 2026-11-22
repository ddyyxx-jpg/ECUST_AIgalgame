/**
 * 每回合结束后的快捷行动建议（纯前端推导，不调模型、不改后端）。
 *
 * 为什么不用模型生成：建议只是**输入辅助**，不该为了它每回合多花一次调用；
 * 而新增一条"服务端 → 前端"的建议通道要动契约版本（docs/03 是唯一名字来源）。
 * 这里只用服务端已经下发的 View 推导：当前场景的去处 + 在场的人。
 *
 * 不重复的保证：不是"尽量避开上一轮"，而是**结构性不重叠**——
 * 每轮只从候选池里取一半（n = ⌊池子/2⌋，封顶 max），并按轮次步进 n 个位置。
 * 因为 2n ≤ 池子大小，相邻两轮选中的下标区间必然不相交，
 * 所以在同一地点连续待着也不会出现「上一轮刚给过、这一轮又来」的选项。
 * 池子只有 2 个时就退化成每轮 1 个、交替出现；只有 1 个时无法再拆（场景太单调）。
 */
import type { ViewPatch } from "../../../packages/shared/src/contract/types.ts";

type Pos = ViewPatch["position"];

/** 候选池：当前场景能去的地方 + 能说话的人（自己除外，不在场的人不算） */
function buildPool(pos: Pos | undefined, selfId: string): string[] {
  if (!pos) return [];
  const out: string[] = [];
  for (const e of pos.exits) out.push(`去${e.name}`);
  for (const a of pos.actors) {
    if (a.present && a.actorId !== selfId && a.name.length > 0) out.push(`和${a.name}说话`);
  }
  return out;
}

/**
 * @param pos    服务端下发的当前位置（没连上时可能为 undefined）
 * @param round  已经进行到第几回合（≥1）；决定从池子的哪一段开始取
 * @param selfId 玩家自己的 actorId（由服务端签发），用来把自己从"能说话的人"里排掉
 * @param max    本轮最多给几条建议
 */
export function turnSuggestions(pos: Pos | undefined, round: number, selfId: string, max = 3): string[] {
  const all = buildPool(pos, selfId);

  // 一个能推进世界的候选都没有（空旷场景）：宁可不给，也别拿「环顾四周」凑数——
  // 这类动作不改任何世界状态，模型只能把同一间屋子重写一遍，读起来就是原地打转。
  if (all.length === 0) return [];

  const n = Math.min(max, Math.max(1, Math.floor(all.length / 2)));
  const start = (((round * n) % all.length) + all.length) % all.length;

  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(all[(start + i) % all.length]!);
  return out;
}
