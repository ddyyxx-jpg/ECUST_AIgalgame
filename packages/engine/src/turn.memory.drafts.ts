/**
 * 记忆写侧：首轮种子 / 最近对话 / 模型记忆草稿，以及草稿 → memory.write 的纯函数。
 * 从 turn.memory.ts 拆出，守住"文件 ≤300 行"（AGENTS §6）；读侧仍只有 turn.memory.ts。
 */
import type { Id, MemoryRecord, Phase, Proposal, TurnRequest, WorldState } from "../../shared/src/index.ts";
import type { MemoryDraft } from "../../shared/src/index.ts";
import type { MemoryContext } from "./turn.memory.ts";
import { memoryDraftArgs, WORKING_MEMORY_TAG } from "./memory.gate.ts";

const PHASE_LABEL: Record<Phase, string> = {
  morning: "早上",
  noon: "中午",
  afternoon: "下午",
  evening: "傍晚",
  night: "夜里",
};

/** 首轮种子：每个 NPC 第一次见到玩家时，总要"记得"这件事，否则第一句话就穿帮 */
export function seedDrafts(mem: MemoryContext, state: WorldState, req: TurnRequest): MemoryDraft[] {
  if (!mem.available) return [];
  // 单 NPC 时 npcs 里就是它自己；多 NPC 时每个在场 NPC 各自种一条（归属互不串）
  const views = mem.npcs.length > 0 ? mem.npcs : [];
  const me = state.entities[req.actorId];
  const here = state.entities[state.room.scene.locId];
  const out: MemoryDraft[] = [];
  for (const view of views) {
    // 只看**这个 NPC 自己**记得什么：世界层有 permanent（"换档后世界记得你"）不代表 NPC 认识玩家，
    // 否则世界层一有内容，新 NPC 就永远不会种"第一次见到"（审阅 P1）
    if (view.profile !== null || view.long.length + view.short.length > 0) continue;
    const draft: MemoryDraft = {
      ownerId: view.npcId,
      content: `第 ${state.clock.day} 天${PHASE_LABEL[state.clock.phase]}，我在${here?.name ?? "这里"}第一次见到${me?.name ?? "这个人"}。`,
      tags: ["初次见面", here?.name ?? "这里"],
      salience: 4,
      about: [req.actorId],
      visibility: "private",
      tier: "long",
    };
    if (mem.userId) draft.userId = mem.userId;
    out.push(draft);
  }
  return out;
}

/**
 * 最近对话（#21-2）：把本回合的"玩家输入 + 叙事摘要 + NPC 台词"写进每个在场 NPC 的 short 记忆。
 * 这是给下一回合用的工作记忆，不是模型产出的情节记忆。
 *
 * - 叙事与台词**分别**分配预算（PR #24 P2-2）：只要叙事写满 100 字就把台词整段截掉，
 *   "明早 8 点见"这类约定会丢；现在 narrative≤70、dialogue≤90、玩家输入≤30，总 ≤200。
 * - 滚动替换（PR #24 P2-1a）：写新条前先 tombstone 该 owner 的旧工作记忆，只保留最新 1 条；
 *   tombstone 排在写入之前（同一批内先撤回再写，幂等由 turnId 去重与 Arbiter 顺序保证）。
 * - 工作记忆不占 sessionCap=30（见 memory.gate 的 WORKING_MEMORY_TAG 豁免），
 *   所以它不会挤掉模型/情节记忆，也不会被它们挤掉。
 */
export interface WorkingMemoryPlan {
  drafts: MemoryDraft[];
  /** 旧工作记忆的 tombstone proposals（提交时排在新的 memory.write 之前） */
  tombstones: Proposal[];
}

const SAID_MAX = 30;
const NARRATIVE_MAX = 70;
const DIALOGUE_MAX = 90;

/** 旧工作记忆 → memory.write(status=tombstoned)：撤回旧条，释放"每 owner 只留最新 1 条"的位置 */
function tombstoneProposal(old: MemoryRecord): Proposal {
  const args: Record<string, unknown> = {
    ownerId: old.ownerId,
    content: old.content,
    tags: old.tags,
    salience: old.salience,
    about: old.about,
    visibility: old.visibility,
    tier: old.tier,
    status: "tombstoned",
    supersedes: old.id,
  };
  if (old.userId) args.userId = old.userId;
  if (old.aboutUserIds && old.aboutUserIds.length > 0) args.aboutUserIds = old.aboutUserIds;
  return { op: "memory.write", args, reason: "工作记忆滚动替换：旧条让位", by: "engine.memory" };
}

export function recentDrafts(
  mem: MemoryContext,
  state: WorldState,
  req: TurnRequest,
  narrative: string,
  dialogue = "",
): WorkingMemoryPlan {
  if (!mem.available || mem.npcs.length === 0) return { drafts: [], tombstones: [] };
  const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
  const said = clip(req.input.trim(), SAID_MAX);
  const happened = clip(narrative.trim(), NARRATIVE_MAX);
  const replied = clip(dialogue.trim(), DIALOGUE_MAX);
  if (!said && !happened && !replied) return { drafts: [], tombstones: [] };
  const content = clip([said ? `刚才玩家说「${said}」` : "", happened, replied].filter(Boolean).join("，"), 200);
  // 地点标签既帮助召回打分，也让"刚才的事"和当前场景绑定
  const here = state.entities[state.room.scene.locId];
  const tags = [WORKING_MEMORY_TAG, ...(here?.name ? [here.name] : [])];
  const tombstones: Proposal[] = [];
  const drafts = mem.npcs.map((view) => {
    for (const old of view.working) tombstones.push(tombstoneProposal(old));
    const draft: MemoryDraft = {
      ownerId: view.npcId,
      content,
      tags,
      salience: 3,
      about: [req.actorId],
      visibility: "private",
      tier: "short",
    };
    if (mem.userId) draft.userId = mem.userId;
    return draft;
  });
  return { drafts, tombstones };
}

/**
 * 印象的反查键：把 about 里的实体映射到成员的账号（canonize 发布后按它投递"世界印象"）。
 * 没有 userId 的成员（未登录/单机）就留空 —— 宁可少投递，不要投错人。
 */
export function attachAboutUserIds(drafts: readonly MemoryDraft[], state: WorldState): MemoryDraft[] {
  return drafts.map((d) => {
    const ids = (d.about ?? [])
      .map((actorId) => state.room.members.find((m) => m.actorId === actorId)?.userId)
      .filter((v): v is Id => typeof v === "string" && v.length > 0);
    if (ids.length === 0) return d;
    return { ...d, aboutUserIds: [...new Set(ids)].slice(0, 8) };
  });
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