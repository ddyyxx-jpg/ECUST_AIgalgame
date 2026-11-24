/**
 * 模拟策略：把"每回合扣多少行动点、推进时段是否回满"这类可调参数放在内容层，
 * 而不是写死在引擎/服务端代码里（I2/I3）。文件缺失 = 功能关闭，测试与旧部署不受影响。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { NpcDecisionPolicy } from "./npc-decision.ts";

const PolicySchema = z.object({
  schemaVersion: z.number().int().optional(),
  actionPoints: z.object({
    enabled: z.boolean().optional(),
    attr: z.string().min(1),
    perTurn: z.number().int().min(0).max(6),
    max: z.number().int().min(0).max(99),
    refillOnPhaseAdvance: z.boolean().optional(),
  }).strict().optional(),
  clock: z.object({
    enabled: z.boolean().optional(),
    intervalMs: z.number().int().min(1_000).max(3_600_000),
    ticksPerBeat: z.number().int().min(1).max(8),
    /** 0 = 不设上限；>0 时 tick 到达上限就停下等玩家推进时段（D22：自动推进不切 phase） */
    maxTick: z.number().int().min(0).max(24),
  }).strict().optional(),
  /** talk 租约最多冻结多少个 tick（防进程崩溃后永久冻结）；默认 12 */
  talkLeaseTicks: z.number().int().min(1).max(1440).optional(),
  /** NPC 自由活动决策：默认关闭；开启后每拍最多 maxPerBeat 个 NPC 调模型 */
  decision: z.object({
    enabled: z.boolean().optional(),
    maxPerBeat: z.number().int().min(1).max(5).optional(),
    intervalTicks: z.number().int().min(1).max(48).optional(),
    hourlyCalls: z.number().int().min(1).max(120).optional(),
    maxOptions: z.number().int().min(2).max(6).optional(),
  }).strict().optional(),
  /** NPC 自由对话：玩家回合结束后，在同一条会话流里让在场 NPC 自己再聊几轮（0 = 关闭） */
  chat: z.object({
    enabled: z.boolean().optional(),
    autoTurns: z.number().int().min(0).max(5).optional(),
    minPresentNpcs: z.number().int().min(1).max(6).optional(),
  }).strict().optional(),
}).strict();

export interface SimClockPolicy {
  enabled: boolean;
  intervalMs: number;
  ticksPerBeat: number;
  maxTick: number;
}

export interface SimPolicy {
  /** 行动点属性键（必须在 registry 声明） */
  actionAttr: string;
  /** 每个普通回合扣多少点 */
  actionCostPerTurn: number;
  /** 行动点上限；推进时段回满到这个值 */
  actionMax: number;
  /** 推进时段时是否把玩家的行动点回满 */
  refillOnPhaseAdvance: boolean;
  /** 自动时钟；未配置 = 不启动 */
  clock?: SimClockPolicy;
  /** talk 租约超时（tick 数） */
  talkLeaseTicks?: number;
  /** NPC 自由活动决策；未配置/关闭 = 不跑 */
  decision?: NpcDecisionPolicy;
  /** NPC 自由对话：autoTurns 轮，且在场 NPC 至少 minPresentNpcs 个 */
  autoChat?: { turns: number; minPresentNpcs: number };
}

/**
 * 读 `<contentDir>/sim/policy.json`。缺文件、坏 JSON、缺 actionPoints 都返回 undefined
 * （= 不启用），避免一个手滑的配置文件把整个服务卡死。
 */
export async function loadSimPolicy(contentDir: string): Promise<SimPolicy | undefined> {
  try {
    const raw = JSON.parse(await readFile(path.join(contentDir, "sim", "policy.json"), "utf8")) as unknown;
    const parsed = PolicySchema.safeParse(raw);
    if (!parsed.success) {
      console.warn("[sim] content/sim/policy.json 校验失败，行动点功能关闭");
      return undefined;
    }
    const ap = parsed.data.actionPoints;
    const clock = parsed.data.clock;
    const chat = parsed.data.chat;
    const autoChat = chat?.enabled !== false && (chat?.autoTurns ?? 0) > 0
      ? { turns: chat?.autoTurns ?? 1, minPresentNpcs: chat?.minPresentNpcs ?? 2 }
      : undefined;
    const decision = parsed.data.decision?.enabled
      ? {
          enabled: true,
          maxPerBeat: parsed.data.decision.maxPerBeat ?? 2,
          intervalTicks: parsed.data.decision.intervalTicks ?? 6,
          hourlyCalls: parsed.data.decision.hourlyCalls ?? 12,
          maxOptions: parsed.data.decision.maxOptions ?? 4,
        }
      : undefined;
    // 行动点/时钟/决策是三份独立能力：只配其一时也必须能启动对应功能。
    if ((!ap || ap.enabled === false) && !clock?.enabled && !decision && !autoChat) return undefined;
    const clockPolicy = clock
      ? { enabled: clock.enabled ?? false, intervalMs: clock.intervalMs, ticksPerBeat: clock.ticksPerBeat, maxTick: clock.maxTick }
      : undefined;
    if (!ap || ap.enabled === false) {
      return {
        actionAttr: "action_points",
        actionCostPerTurn: 0,
        actionMax: 0,
        refillOnPhaseAdvance: false,
        talkLeaseTicks: parsed.data.talkLeaseTicks ?? 12,
        ...(clockPolicy ? { clock: clockPolicy } : {}),
        ...(decision ? { decision } : {}),
        ...(autoChat ? { autoChat } : {}),
      };
    }
    return {
      actionAttr: ap.attr,
      actionCostPerTurn: ap.perTurn,
      actionMax: ap.max,
      refillOnPhaseAdvance: ap.refillOnPhaseAdvance ?? true,
      talkLeaseTicks: parsed.data.talkLeaseTicks ?? 12,
      ...(clockPolicy ? { clock: clockPolicy } : {}),
      ...(decision ? { decision } : {}),
      ...(autoChat ? { autoChat } : {}),
    };
  } catch (e) {
    // 文件不存在是"功能未配置"，静默关闭；坏 JSON / 读失败要留一条日志，避免配置写错后无线索。
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[sim] 读取 content/sim/policy.json 失败，模拟功能关闭：${e instanceof Error ? e.message : String(e)}`);
    }
    return undefined;
  }
}
