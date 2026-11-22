/**
 * Turn 提交证据（issue #76）：`turn.committed` 标记的 payload 与读回。
 *
 * 标记与回合状态事件同批写进房间 EventLog，是跨重启幂等/对账的**提交事实**。
 * 它不重放整个 SSE 事件流，而是带上足以还原"历史行"的最小内容（narrative/facts/usage）
 * 与提交 seq；进程重启后据此重建幂等键、确认额度、恢复缺失的回合历史。
 * 这里只定义形状与边界解析（zod-first）；写标记由 Arbiter 在同批 append 时完成。
 */
import { z } from "zod";
import type { Envelope } from "../../shared/src/index.ts";

export const TURN_COMMITTED_TYPE = "turn.committed" as const;

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  calls: number;
}

const usageSchema = z.object({
  promptTokens: z.number(), completionTokens: z.number(), cachedTokens: z.number().optional(), calls: z.number(),
});

const commitPayloadSchema = z.object({
  clientTurnId: z.string(),
  turnId: z.string(),
  actorId: z.string(),
  committedSeq: z.number().int().nonnegative(),
  narrative: z.string().optional(),
  facts: z.array(z.string()).optional(),
  usage: usageSchema.optional(),
});

export interface TurnCommitEvidence {
  clientTurnId: string;
  turnId: string;
  actorId: string;
  committedSeq: number;
  narrative?: string;
  facts?: string[];
  usage?: UsageInfo;
}

/** 构造标记的 Envelope（seq/ts/roomId 由 Arbiter 在 append 时决定） */
export function commitMarker(evidence: TurnCommitEvidence): Envelope {
  return {
    v: 1,
    id: `turn_commit_${evidence.clientTurnId}`,
    roomId: "",
    seq: 0,
    ts: 0,
    actorId: evidence.actorId,
    type: TURN_COMMITTED_TYPE,
    payload: evidence,
  };
}

/** 边界解析：坏标记（半截/旧版/结构不符）跳过，绝不误判为已提交 */
export function parseCommitEvidence(env: Envelope): TurnCommitEvidence | undefined {
  if (env.type !== TURN_COMMITTED_TYPE) return undefined;
  const parsed = commitPayloadSchema.safeParse(env.payload);
  if (!parsed.success) return undefined;
  const { clientTurnId, turnId, actorId, committedSeq, narrative, facts, usage } = parsed.data;
  return {
    clientTurnId, turnId, actorId, committedSeq,
    ...(narrative !== undefined ? { narrative } : {}),
    ...(facts !== undefined ? { facts } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}

/** 幂等键与引擎一致：房间 + 角色 + 逻辑 ID */
export function evidenceKey(roomId: string, actorId: string, clientTurnId: string): string {
  return JSON.stringify([roomId, actorId, clientTurnId]);
}
