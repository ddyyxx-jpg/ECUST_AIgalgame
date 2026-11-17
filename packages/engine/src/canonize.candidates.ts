/**
 * 世界层候选的聚合与纯函数闸门（从 canonize.ts 拆出，保持单文件可读、便于单独测试）。
 * 这里**只读**记忆/世界状态，不产事件；写世界层永远走 CanonizeJob 的 Arbiter 路径。
 */
import type { Id, MemoryRecord, Plot, RoomId, WorldState } from "../../shared/src/index.ts";
import { contentHashOf } from "./memory.gate.ts";

export interface PermanentCandidate {
  worldId: Id;
  content: string;
  tags: string[];
  about: Id[];
  aboutUserIds?: Id[];
  sourceRefs: Id[];
  status: "current" | "historical";
}

export const SOURCE_REF = /^(evt_|canon_|fact_|lore_|mem_)/;

/** 隐私扫描：禁语来自活跃 plot；私密记忆原文也不许"换个说法"进世界层 */
export function privacyHit(content: string, state: WorldState, secrets: string[]): string | null {
  for (const plot of state.plots as Plot[]) {
    if (plot.status !== "active" || !plot.forbidReveal) continue;
    if (content.includes(plot.forbidReveal)) return `plot:${plot.id}`;
  }
  for (const s of secrets) {
    if (s.length >= 6 && content.includes(s.slice(0, Math.min(20, s.length)))) return "secret_memory";
  }
  return null;
}

/** 从房间记忆里聚合候选：同一条"事"至少被 minWitness 个不同 owner 记住，才算公共知识 */
export function candidatesFromMemories(
  roomId: RoomId,
  records: MemoryRecord[],
  worldId: Id,
): PermanentCandidate[] {
  const groups = new Map<string, MemoryRecord[]>();
  for (const r of records) {
    if (r.visibility !== "public") continue;
    if (r.status !== "current") continue;
    if (r.tier !== "long" && r.tier !== "permanent") continue;
    const key = contentHashOf(r.content);
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const out: PermanentCandidate[] = [];
  for (const [hash, list] of groups) {
    const owners = new Set(list.map((r) => r.ownerId));
    if (owners.size === 0) continue;
    const first = list[0]!;
    out.push({
      worldId,
      content: first.content,
      tags: [...new Set(list.flatMap((r) => r.tags))].slice(0, 8),
      about: [...new Set(list.flatMap((r) => r.about))].slice(0, 8),
      aboutUserIds: [...new Set(list.flatMap((r) => r.aboutUserIds ?? []))].slice(0, 8),
      sourceRefs: [...new Set(list.map((r) => r.id))].slice(0, 8),
      status: "current",
    });
    void hash;
  }
  return out;
}

/** 见证者数：同一内容被几个不同 owner 记住（owner 身份就是"谁亲眼见过"） */
export function witnessCount(records: MemoryRecord[], candidate: PermanentCandidate): number {
  const hash = contentHashOf(candidate.content);
  // 只数"公开且当前有效"的记忆：私忆/已撤回不算见证者（审阅 P1）
  return new Set(
    records
      .filter((r) => r.visibility === "public" && r.status === "current" && contentHashOf(r.content) === hash)
      .map((r) => r.ownerId),
  ).size;
}

