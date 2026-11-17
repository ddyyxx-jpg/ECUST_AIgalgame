/**
 * 回合里的记忆侧：读（召回注入）与写（草稿 → Proposal）都从这里走。
 * Turn 只负责时序（读 → 问模型 → 闸门 → 裁决 → ingest），不关心记忆怎么打分。
 *
 * 关键取舍：**记忆读失败不能毁掉回合**。召回是"让 NPC 记得你"的增强项，
 * 读不到就当作第一次见面继续（并在 facts 里说明），而不是让玩家卡在这里。
 */
import type {
  ActorId,
  Id,
  MemoryHit,
  MemoryProfile,
  MemoryRecord,
  Phase,
  Proposal,
  RoomId,
  TurnRequest,
  WorldState,
} from "../../shared/src/index.ts";
import type { EventSourcedMemory } from "./memory.ts";
import { estimateTokens, worldRoomId } from "./memory.ts";
import type { MemoryDraft } from "../../shared/src/index.ts";
import { memoryDraftArgs } from "./memory.gate.ts";

/** 注入硬顶（docs/07 §3）：S1.5 + S7 + S8 合计不超过 1100 token */
export const INJECT_BUDGET = 1100;
const PERMANENT_BUDGET = 200;
const LONG_BUDGET = 700;
const SHORT_BUDGET = 200;

const PHASE_LABEL: Record<Phase, string> = {
  morning: "早上",
  noon: "中午",
  afternoon: "下午",
  evening: "傍晚",
  night: "夜里",
};

export interface MemoryContext {
  available: boolean;
  userId?: Id;
  worldId: Id;
  worldRoom: RoomId;
  /** 记忆持有者：当前对谈的 NPC；没有明确对谈对象时是玩家自己 */
  ownerId: ActorId;
  /** 当前对谈的 NPC（没有则 undefined） */
  npcId?: ActorId;
  permanent: MemoryHit[];
  long: MemoryHit[];
  short: MemoryHit[];
  profile: MemoryProfile | null;
  /** 该 owner 已有条数（配额给闸门用） */
  ownedCount: number;
  /** 去重用：该 owner 最近的记录 */
  recent: MemoryRecord[];
}

/**
 * 记忆持有者：场景里恰好一个 NPC → 它；否则玩家自己。
 * 这条规则刻意简单：多 NPC 场景下"谁记得"由导演层决定（P4 接对话），
 * 回合层不要猜。
 */
export function selectOwner(state: WorldState, actorId: ActorId): { ownerId: ActorId; npcId?: ActorId } {
  const others = state.room.scene.presentIds.filter((id) => id !== actorId);
  const npcs = others.filter((id) => state.entities[id]?.kind === "npc");
  if (npcs.length === 1) {
    const npcId = npcs[0]!;
    return { ownerId: npcId, npcId };
  }
  return { ownerId: actorId };
}

function takeWithin(hits: MemoryHit[], budget: number): MemoryHit[] {
  const out: MemoryHit[] = [];
  let used = 0;
  for (const h of hits) {
    const cost = estimateTokens(h.record.content) + 8;
    if (used + cost > budget) break;
    used += cost;
    out.push(h);
  }
  return out;
}

/** 读侧：世界层永久记忆 + 该 owner 的长期/短期记忆，按 id 排序保证提示词逐字节稳定（缓存命中） */
export async function readMemoryContext(
  memory: EventSourcedMemory,
  state: WorldState,
  req: TurnRequest,
): Promise<MemoryContext> {
  const { ownerId, npcId } = selectOwner(state, req.actorId);
  const worldId = state.room.worldId;
  const worldRoom = worldRoomId(worldId);
  const userId = resolveUserId(state, req);
  const nowTurn = state.clock.day * 100 + state.clock.tick;
  const base = { worldId, worldRoom, ownerId, ownedCount: 0, recent: [] as MemoryRecord[] } as MemoryContext;
  if (npcId) base.npcId = npcId;
  if (userId) base.userId = userId;

  try {
    const permanent = await memory.recall({
      roomId: worldRoom,
      ownerId: "mem_world",
      tiers: ["permanent"],
      scope: "world",
      worldId,
      budgetTokens: PERMANENT_BUDGET,
      nowTurn,
      ...(userId ? { userId } : {}),
      ...(npcId ? { about: [npcId] } : {}),
    });
    const long = await memory.recall({
      roomId: req.roomId,
      ownerId,
      tiers: ["long"],
      budgetTokens: LONG_BUDGET,
      nowTurn,
      ...(userId ? { userId } : {}),
      about: [req.actorId],
    });
    const short = await memory.recall({
      roomId: req.roomId,
      ownerId,
      tiers: ["short"],
      budgetTokens: SHORT_BUDGET,
      nowTurn,
      ...(userId ? { userId } : {}),
      about: [req.actorId],
    });
    const owned = memory.all(req.roomId).filter((r) => r.ownerId === ownerId && r.status !== "tombstoned");
    const profile = userId ? await memory.profile(userId, ownerId, req.roomId) : null;

    const p = takeWithin(permanent, PERMANENT_BUDGET);
    const l = takeWithin(long, LONG_BUDGET);
    const s = takeWithin(short, SHORT_BUDGET);
    // 三段合计再压一次：极端情况下（forced 记忆不占自身预算）可能超过 1100
    let used = [...p, ...l, ...s].reduce((n, h) => n + estimateTokens(h.record.content) + 8, 0);
    const trimmedShort = [...s];
    while (used > INJECT_BUDGET && trimmedShort.length > 0) {
      const last = trimmedShort.pop();
      if (last) used -= estimateTokens(last.record.content) + 8;
    }
    return {
      ...base,
      available: true,
      permanent: p,
      long: l,
      short: trimmedShort,
      profile,
      ownedCount: owned.length,
      recent: [...owned].sort((a, b) => b.turn - a.turn || b.createdAt - a.createdAt).slice(0, 12),
    };
  } catch {
    return { ...base, available: false, permanent: [], long: [], short: [], profile: null };
  }
}

/** 首轮种子：NPC 第一次见到玩家时，总要"记得"这件事，否则第一句话就穿帮 */
export function seedDrafts(mem: MemoryContext, state: WorldState, req: TurnRequest): MemoryDraft[] {
  if (!mem.available || !mem.npcId) return [];
  if (mem.profile !== null || mem.permanent.length + mem.long.length + mem.short.length > 0) return [];
  const me = state.entities[req.actorId];
  const here = state.entities[state.room.scene.locId];
  const draft: MemoryDraft = {
    ownerId: mem.npcId,
    content: `第 ${state.clock.day} 天${PHASE_LABEL[state.clock.phase]}，我在${here?.name ?? "这里"}第一次见到${me?.name ?? "这个人"}。`,
    tags: ["初次见面", here?.name ?? "这里"],
    salience: 4,
    about: [req.actorId],
    visibility: "private",
    tier: "long",
  };
  if (mem.userId) draft.userId = mem.userId;
  return [draft];
}

/** 写侧：草稿 → 12 原语里的 memory.write（只提议，落库仍归 Arbiter） */
export function toMemoryProposals(drafts: readonly MemoryDraft[]): Proposal[] {
  return drafts.map((d) => ({
    op: "memory.write",
    args: memoryDraftArgs(d),
    reason: "记忆",
    by: "engine.memory",
  }));
}

/** 账号维度：请求显式给的优先；否则取房间成员上的绑定（P2 会把这条补齐） */
export function resolveUserId(state: WorldState, req: TurnRequest): Id | undefined {
  if (req.userId) return req.userId;
  const member = state.room.members.find((m) => m.actorId === req.actorId);
  return member?.userId;
}
