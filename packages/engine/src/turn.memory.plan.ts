/**
 * 记忆写侧流水线（#39）：把"最终采信的模型产物"统一收敛成 memory proposals。
 *
 * 为什么单独抽出来：首版成功与 repair 成功必须走**同一条**流程。旧实现里 repair 分支只重提
 * module+llm，漏掉了记忆，导致"模型第一次提案被拒、修复成功后整回合 memory.written=0"。
 * 这里也确保只用修复后的产物重建，绝不把被拒首版写进记忆。
 */
import type { MemoryDraft, Proposal, TurnRequest, WorldState } from "../../shared/src/index.ts";
import type { MemoryContext } from "./turn.memory.ts";
import { applyMemoryGates } from "./memory.gate.ts";
import { attachAboutUserIds, recentDrafts, seedDrafts, toMemoryProposals } from "./turn.memory.drafts.ts";

export interface MemoryPlanInput {
  mem: MemoryContext;
  state: WorldState;
  req: TurnRequest;
  /** 最终采信的叙事文本（首版或 repair 版） */
  narrative: string;
  /** 最终采信的 NPC 台词（与叙事分别进工作记忆，PR #24 P2-2） */
  dialogue: string;
  /** 最终采信的模型记忆草稿（首版或 repair 版） */
  modelDrafts: readonly MemoryDraft[];
}

export interface MemoryPlan {
  /** tombstone（滚动替换旧工作记忆）+ 新记忆的 memory.write proposals */
  proposals: Proposal[];
  /** 被闸门丢弃的条数（写进 turn.facts「记忆校准」） */
  dropped: number;
}

export function buildMemoryPlan(input: MemoryPlanInput): MemoryPlan {
  const { mem, state, req } = input;
  if (!mem.available) return { proposals: [], dropped: 0 };

  // 多 NPC 场景每个在场 NPC 各记一份；0 NPC 时仍记在玩家名下（旧行为）
  const units = mem.npcs.length > 0
    ? mem.npcs.map((v) => ({ ownerId: v.npcId, recent: v.recent, ownedCount: v.ownedCount }))
    : [{ ownerId: mem.ownerId, recent: mem.recent, ownedCount: mem.ownedCount }];

  // 模型草稿的 ownerId 是空串（由闸门按 owner 重建）；种子草稿已经带 ownerId
  const baseDrafts = attachAboutUserIds([...seedDrafts(mem, state, req), ...input.modelDrafts], state);
  // 工作记忆（最近对话）：滚动替换旧条 + 叙事/台词分别取（PR #24 P2-2）；
  // tombstone 排在新的 memory.write 之前，同一批内先撤回再写。
  const working = recentDrafts(mem, state, req, input.narrative, input.dialogue);

  const accepted: MemoryDraft[] = [];
  let dropped = 0;
  for (const unit of units) {
    const gated = applyMemoryGates({
      state,
      actorId: req.actorId,
      ownerId: unit.ownerId,
      ...(mem.userId ? { userId: mem.userId } : {}),
      drafts: baseDrafts.filter((d) => d.ownerId === unit.ownerId || d.ownerId === ""),
      workingDrafts: working.drafts.filter((d) => d.ownerId === unit.ownerId),
      recent: unit.recent,
      ownedCount: unit.ownedCount,
    });
    dropped += gated.dropped.length;
    accepted.push(...gated.accepted);
  }
  return { proposals: [...working.tombstones, ...toMemoryProposals(accepted)], dropped };
}
