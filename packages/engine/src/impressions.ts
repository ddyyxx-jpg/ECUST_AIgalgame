/**
 * 世界印象（P4，docs/08 §8）：canonize 成功把某个玩家的事迹写进世界层后，
 * 让"这个世界"在下一回合记住他 —— 不调模型、不占叙事文本、不增加输入 token。
 *
 * 这里只有纯函数与端口定义；落盘（哪个文件、什么格式）由 server 决定，引擎不做 IO。
 */
import type { Id, ImpressionNotice } from "../../shared/src/index.ts";

/** ≥ 这个长度才值得生成印象（太短的一句话没有"记住"的价值） */
const MIN_SUBJECT = 6;
const MAX_SUBJECT = 40;

/** 印象正文：去掉引号/换行，截断到 40 字（不给玩家看私密细节，只给"被记住"的感觉） */
export function subjectTextOf(content: string): string {
  const flat = content.replace(/[\r\n]+/g, " ").replace(/["'“”‘’]/g, "").trim();
  return flat.length <= MAX_SUBJECT ? flat : `${flat.slice(0, MAX_SUBJECT - 1)}…`;
}

export function buildImpression(input: {
  memoryId: Id;
  userId: Id;
  worldId: Id;
  content: string;
  npcId?: Id;
  now?: number;
}): ImpressionNotice | null {
  if (!input.userId || input.userId.trim() === "") return null;
  const subjectText = subjectTextOf(input.content);
  if (subjectText.length < MIN_SUBJECT) return null;
  return {
    id: `imp_${input.memoryId}`,
    memoryId: input.memoryId,
    userId: input.userId,
    worldId: input.worldId,
    subjectText,
    ...(input.npcId ? { npcId: input.npcId } : {}),
    createdAt: input.now ?? Date.now(),
  };
}

/** 投递文案：{npcName ?? "这个世界"}记住了你 */
export function impressionFact(notice: ImpressionNotice, npcName?: string): string {
  return `【世界印象】${npcName && npcName.trim() !== "" ? npcName : "这个世界"}记住了你：${notice.subjectText}`;
}

/** 过期与已投递的都不再出现；按 createdAt 升序（先记住的先说） */
export function pendingNotices(
  notices: ImpressionNotice[],
  opts: { ttlDays: number; now: number; limit: number },
): ImpressionNotice[] {
  const ttlMs = Math.max(1, opts.ttlDays) * 24 * 60 * 60 * 1000;
  return notices
    .filter((n) => !n.deliveredAt)
    .filter((n) => opts.now - n.createdAt <= ttlMs)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, Math.max(0, opts.limit));
}

/** 投递端口：Turn 只依赖它，落盘/重建都在实现方 */
export interface Impressions {
  pending(userId: Id, roomId: Id, limit: number): Promise<ImpressionNotice[]>;
  /** 传完整 notice：投递记录是"谁看过哪条"，只有 id 不足以定位用户文件 */
  markDelivered(notices: ImpressionNotice[]): Promise<void>;
  count?(userId: Id): Promise<number>;
}

export const NO_IMPRESSIONS: Impressions = {
  async pending() {
    return [];
  },
  async markDelivered() {
    return;
  },
};
