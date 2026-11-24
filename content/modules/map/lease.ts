/**
 * NPC 动作租约的唯一解析/时钟口径。
 * 模块 tick 与 server 的 talk 冻结/恢复都读同一份 JSON，避免两边字段校验漂移。
 */
import type { Phase } from "../../../packages/shared/src/contract/types.ts";

export const LEASE = "sim_lease";

export const PHASES: readonly Phase[] = ["morning", "noon", "afternoon", "evening", "night"];

export interface Lease {
  action: "move" | "stay" | "talk";
  target: string;
  /** 还需要占用几个 tick（含下一次 tick 检查）；0 表示本次结束 */
  remaining: number;
  phase: Phase;
  /** talk 专用：原租约 JSON 串，对话结束由服务端恢复 */
  resume?: string;
  /** talk 专用：绝对时钟（day*120 + phase*24 + tick）到点强制作废，防进程崩溃永久冻结 */
  expiresAt?: number;
}

/** 把 day/phase/tick 压成一个单调递增的整数，只用于 talk 租约超时。 */
export function clockIndex(clock: { day: number; phase: Phase; tick: number }): number {
  return clock.day * PHASES.length * 24 + PHASES.indexOf(clock.phase) * 24 + clock.tick;
}

/** 坏 JSON / 旧格式一律当空闲，不让一条脏租约卡死 NPC 的日程 */
export function parseLease(raw: unknown): Lease | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const v = JSON.parse(raw) as Partial<Lease>;
    if ((v.action !== "move" && v.action !== "stay" && v.action !== "talk") || typeof v.target !== "string") return null;
    if (typeof v.remaining !== "number" || !Number.isInteger(v.remaining) || v.remaining < 0) return null;
    if (typeof v.phase !== "string" || !PHASES.includes(v.phase as Phase)) return null;
    const lease: Lease = { action: v.action, target: v.target, remaining: v.remaining, phase: v.phase as Phase };
    if (typeof v.resume === "string") lease.resume = v.resume;
    if (typeof v.expiresAt === "number" && Number.isFinite(v.expiresAt)) lease.expiresAt = v.expiresAt;
    return lease;
  } catch {
    return null;
  }
}
