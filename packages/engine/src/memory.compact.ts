/**
 * 情节记忆的容量回收（#42）。
 *
 * `compact`（运行时低频触发）与 `recomputeArchived`（重启后按事件日志确定性重算）
 * 必须用同一规则，否则重启后的配额状态会和运行时不一致；独立成小文件避免 memory.ts 继续膨胀。
 */
import type { ActorId, MemoryRecord } from "../../shared/src/index.ts";
import { isWorkingMemory } from "./memory.gate.ts";

/** 压缩阈值：必须低于闸门的 sessionCap=30，否则 compact 永远触发不了（旧值 60 > 30 是死锁） */
export const COMPACT_AFTER = 20;

function plotRecords(records: readonly MemoryRecord[], ownerId: ActorId): MemoryRecord[] {
  return records.filter(
    (m) => m.ownerId === ownerId && !m.archived && m.status !== "tombstoned" && !isWorkingMemory(m),
  );
}

/**
 * 重启重算：archived 标记不在事件日志里（compact 是投影侧维护），首次同步时按同一确定性规则
 * 反复归档，直到每 owner 的情节记忆低于 COMPACT_AFTER；否则配额会被"已归档但忘了"的记忆冻结。
 */
export function recomputeArchived(records: readonly MemoryRecord[]): void {
  const byOwner = new Map<ActorId, MemoryRecord[]>();
  for (const m of records) {
    if (m.tier === "permanent" || m.status === "tombstoned" || isWorkingMemory(m)) continue;
    const list = byOwner.get(m.ownerId) ?? [];
    list.push(m);
    byOwner.set(m.ownerId, list);
  }
  for (const list of byOwner.values()) {
    let live = list;
    while (live.length > COMPACT_AFTER) {
      live.sort((a, b) => a.salience - b.salience || a.createdAt - b.createdAt);
      for (const m of live.slice(0, Math.floor(live.length / 3))) m.archived = true;
      live = list.filter((m) => !m.archived);
    }
  }
}

/** compact：只压缩情节记忆；工作记忆由"每 owner 只留最新 1 条"的滚动替换管理，不归档 */
export function compactRecords(
  records: readonly MemoryRecord[],
  ownerId: ActorId,
): { impressions: number; archived: number } {
  const mine = plotRecords(records, ownerId);
  if (mine.length <= COMPACT_AFTER) return { impressions: 0, archived: 0 };
  mine.sort((a, b) => a.salience - b.salience || a.createdAt - b.createdAt);
  const take = Math.floor(mine.length / 3);
  for (const m of mine.slice(0, take)) m.archived = true;
  return { impressions: mine.length, archived: take };
}
