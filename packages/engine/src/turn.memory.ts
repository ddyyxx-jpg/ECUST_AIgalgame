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
  RoomId,
  TurnRequest,
  WorldState,
} from "../../shared/src/index.ts";
import type { EventSourcedMemory } from "./memory.ts";
import { estimateTokens, worldRoomId } from "./memory.ts";
import { isWorkingMemory } from "./memory.gate.ts";
import { resolveUserId } from "./turn.memory.drafts.ts";

/** 注入硬顶（docs/07 §3）：S1.5 + S7 + S8 合计不超过 1100 token */
export const INJECT_BUDGET = 1100;
const PERMANENT_BUDGET = 200;
const LONG_BUDGET = 700;
const SHORT_BUDGET = 200;


/** 单个在场 NPC 的记忆视角：多 NPC 场景按人分组注入（issue #20） */
export interface NpcMemory {
  npcId: ActorId;
  name: string;
  long: MemoryHit[];
  short: MemoryHit[];
  profile: MemoryProfile | null;
  /** 该 NPC 已有条数（配额给闸门用；**不含**工作记忆，PR #24 P2-1） */
  ownedCount: number;
  /** 去重用：该 NPC 最近的记录 */
  recent: MemoryRecord[];
  /** 该 NPC 现存的工作记忆（"最近对话"，写侧滚动替换用；最新在前） */
  working: MemoryRecord[];
}

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
  /**
   * 在场 NPC 各自的记忆（按 presentIds 顺序；0 个 NPC 时为空）。
   * 单 NPC 时内容与上面的 long/short/profile/recent 一致（保留旧字段是为了兼容调用方）。
   * 多 NPC 时上面三个字段不再代表某个 NPC，注入/写入都以这里为准。
   */
  npcs: NpcMemory[];
}

/** 场景里所有在场的 NPC（按 presentIds 顺序，保证提示词逐字节稳定） */
export function presentNpcIds(state: WorldState, actorId: ActorId): ActorId[] {
  return state.room.scene.presentIds.filter((id) => id !== actorId && state.entities[id]?.kind === "npc");
}

/**
 * 记忆持有者：场景里恰好一个 NPC → 它；否则玩家自己。
 * 多 NPC 场景的注入/写入按 presentNpcIds 分组（见 npcs），这条旧规则只用于兼容字段。
 */
export function selectOwner(state: WorldState, actorId: ActorId): { ownerId: ActorId; npcId?: ActorId } {
  const npcs = presentNpcIds(state, actorId);
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

function usedTokens(hits: readonly MemoryHit[]): number {
  return hits.reduce((n, h) => n + estimateTokens(h.record.content) + 8, 0);
}

/** 多 NPC 时把一份预算平均分给每个在场 NPC，余数给靠前的（顺序固定 → 提示词稳定） */
function splitBudget(total: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  const rest = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}

interface OwnerRead {
  long: MemoryHit[];
  short: MemoryHit[];
  profile: MemoryProfile | null;
  ownedCount: number;
  recent: MemoryRecord[];
  working: MemoryRecord[];
}

/** 读某个记忆所有者的长期/短期记忆（owner 视角的召回与配额事实） */
async function readOwner(
  memory: EventSourcedMemory,
  state: WorldState,
  req: TurnRequest,
  ownerId: ActorId,
  userId: Id | undefined,
  nowTurn: number,
  sceneTags: string[],
  longBudget: number,
  shortBudget: number,
): Promise<OwnerRead> {
  const long = await memory.recall({
    roomId: req.roomId,
    ownerId,
    tiers: ["long"],
    budgetTokens: longBudget,
    nowTurn,
    ...(userId ? { userId } : {}),
    ...(sceneTags.length > 0 ? { tags: sceneTags } : {}),
    about: [req.actorId],
  });
  const short = await memory.recall({
    roomId: req.roomId,
    ownerId,
    tiers: ["short"],
    budgetTokens: shortBudget,
    nowTurn,
    ...(userId ? { userId } : {}),
    ...(sceneTags.length > 0 ? { tags: sceneTags } : {}),
    about: [req.actorId],
  });
  const owned = memory.all(req.roomId).filter((r) => r.ownerId === ownerId && r.status !== "tombstoned");
  const profile = userId ? await memory.profile(userId, ownerId, req.roomId) : null;
  // 工作记忆是"最近对话"的滚动副本，不算情节记忆的 sessionCap（PR #24 P2-1）；
  // 已归档（compact 产出）的情节记忆也不再占配额（#42），否则长期房间会被"归档但仍计数"冻结。
  const plotOnly = owned.filter((r) => !isWorkingMemory(r) && !r.archived);
  const working = owned
    .filter((r) => isWorkingMemory(r) && !r.archived)
    .sort((a, b) => b.turn - a.turn || b.createdAt - a.createdAt);
  return {
    long: takeWithin(long, longBudget),
    short: takeWithin(short, shortBudget),
    profile,
    ownedCount: plotOnly.length,
    recent: [...owned].sort((a, b) => b.turn - a.turn || b.createdAt - a.createdAt).slice(0, 12),
    working,
  };
}

/** 极端情况下（forced 记忆不占自身预算）可能超过 1100：从后往前的 short、再 long 裁掉尾部 */
function trimToBudget(permanent: readonly MemoryHit[], npcs: NpcMemory[]): void {
  let used = usedTokens(permanent) + npcs.reduce((n, v) => n + usedTokens(v.long) + usedTokens(v.short), 0);
  for (let i = npcs.length - 1; i >= 0 && used > INJECT_BUDGET; i -= 1) {
    const view = npcs[i]!;
    while (used > INJECT_BUDGET && view.short.length > 0) {
      const last = view.short.pop();
      if (last) used -= estimateTokens(last.record.content) + 8;
    }
  }
  for (let i = npcs.length - 1; i >= 0 && used > INJECT_BUDGET; i -= 1) {
    const view = npcs[i]!;
    while (used > INJECT_BUDGET && view.long.length > 0) {
      const last = view.long.pop();
      if (last) used -= estimateTokens(last.record.content) + 8;
    }
  }
}

/**
 * 读侧：世界层永久记忆 + 每个在场 NPC 的长期/短期记忆。
 * 多 NPC 场景不再退回玩家名下（issue #20 根因）；每段记忆都保留 owner 归属。
 * 按 owner 顺序 / id 排序，保证提示词逐字节稳定（缓存命中）。
 */
export async function readMemoryContext(
  memory: EventSourcedMemory,
  state: WorldState,
  req: TurnRequest,
): Promise<MemoryContext> {
  const { ownerId, npcId } = selectOwner(state, req.actorId);
  const npcIds = presentNpcIds(state, req.actorId);
  const worldId = state.room.worldId;
  const worldRoom = worldRoomId(worldId);
  const userId = resolveUserId(state, req);
  const nowTurn = state.clock.day * 100 + state.clock.tick;
  // 场景标签：地点名（提示词缓存无关，只影响召回打分）
  const loc = state.entities[state.room.scene.locId];
  const sceneTags = loc?.name ? [loc.name] : [];
  const base: MemoryContext = {
    worldId,
    worldRoom,
    ownerId,
    ownedCount: 0,
    recent: [],
    available: false,
    permanent: [],
    long: [],
    short: [],
    profile: null,
    npcs: [],
  };
  if (npcId) base.npcId = npcId;
  if (userId) base.userId = userId;

  try {
    const permanent = takeWithin(
      await memory.recall({
        roomId: worldRoom,
        ownerId: "mem_world",
        tiers: ["permanent"],
        scope: "world",
        worldId,
        budgetTokens: PERMANENT_BUDGET,
        nowTurn,
        ...(userId ? { userId } : {}),
        // 单 NPC 时保留"这个世界关于他的话"的过滤；多 NPC 时世界层不偏向某个人
        ...(npcId ? { about: [npcId] } : {}),
      }),
      PERMANENT_BUDGET,
    );

    // 没有 NPC：保持旧行为（玩家自己的记忆；注入段会因无 npcId 而用旧标题）
    if (npcIds.length === 0) {
      const one = await readOwner(memory, state, req, ownerId, userId, nowTurn, sceneTags, LONG_BUDGET, SHORT_BUDGET);
      return {
        ...base,
        available: true,
        permanent,
        long: one.long,
        short: one.short,
        profile: one.profile,
        ownedCount: one.ownedCount,
        recent: one.recent,
        npcs: [],
      };
    }

    const budgetLeft = Math.max(0, INJECT_BUDGET - usedTokens(permanent));
    const longTotal = Math.floor((budgetLeft * LONG_BUDGET) / (LONG_BUDGET + SHORT_BUDGET));
    const shortTotal = budgetLeft - longTotal;
    const longBudgets = npcIds.length === 1 ? [LONG_BUDGET] : splitBudget(longTotal, npcIds.length);
    const shortBudgets = npcIds.length === 1 ? [SHORT_BUDGET] : splitBudget(shortTotal, npcIds.length);

    const npcs: NpcMemory[] = [];
    for (let i = 0; i < npcIds.length; i += 1) {
      const id = npcIds[i]!;
      const one = await readOwner(
        memory,
        state,
        req,
        id,
        userId,
        nowTurn,
        sceneTags,
        longBudgets[i] ?? 0,
        shortBudgets[i] ?? 0,
      );
      npcs.push({ npcId: id, name: state.entities[id]?.name ?? id, ...one });
    }
    trimToBudget(permanent, npcs);

    // 单 NPC 时旧字段继续指向那个 NPC（对外兼容）；多 NPC 时旧字段不再代表某个人
    const single = npcs.length === 1 ? npcs[0]! : undefined;
    return {
      ...base,
      available: true,
      permanent,
      long: single ? single.long : [],
      short: single ? single.short : [],
      profile: single ? single.profile : null,
      ownedCount: single ? single.ownedCount : 0,
      recent: single ? single.recent : [],
      npcs,
    };
  } catch {
    return { ...base, available: false, permanent: [], long: [], short: [], profile: null, npcs: [] };
  }
}
