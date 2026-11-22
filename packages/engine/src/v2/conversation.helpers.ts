/**
 * 会话编排的纯函数（dev/v2）：审核字段拼接 + 私忆 Proposal 生成。
 * 从 conversation.ts 拆出，让编排保持在 300 行以内（AGENTS §6）。
 */
import type { Delivery, Id, Proposal, RoomId, Utterance, UtteranceModeDef, ActorId } from "../../../shared/src/index.ts";

/** 与 Arbiter 的 limits.memoryContentMax 对齐：组合后的记忆正文必须落在这个闭区间内 */
const MEMORY_CONTENT_MAX = 500;

/** 组合文本统一收口到 memory.write 的内容上限，避免字段各自合法、拼接后整批被拒 */
function fitMemoryContent(text: string): string {
  return text.slice(0, MEMORY_CONTENT_MAX);
}

/** 共享场景总结只能读 public 模式投出的通道；私聊/暗号的正文绝不进群像总结 */
export function publicSceneText(
  deliveries: readonly Delivery[],
  modes: Map<string, UtteranceModeDef>,
): string[] {
  return deliveries
    .filter((d) => modes.get(d.mode)?.visibility === "public")
    .map((d) => [d.speaker, d.content ?? "", d.action ?? ""].filter(Boolean).join(" / "));
}

export interface AuditText {
  label: string;
  text: string;
}

/** 说话四段 + 附加标记 → 待审字段（标签稳定，不随文案变化） */
export function utteranceFields(u: Utterance): AuditText[] {
  return [
    { label: "target", text: u.target ? String(u.target) : "all" },
    { label: "mode", text: u.mode },
    { label: "content", text: u.content ?? "" },
    { label: "action", text: u.action ?? "" },
    { label: "coverAction", text: u.coverAction ?? "" },
    { label: "notice", text: u.notice ?? "" },
  ];
}

/** 心理活动（含可执行的 plan）也必须过审核：plan 不自动执行，但内容要受同一把尺子管 */
export function mentalFields(m: { thought: string; plan?: string }): AuditText[] {
  return [
    { label: "thought", text: m.thought },
    { label: "plan", text: m.plan ?? "" },
  ];
}

/** 一句话 → 可持久化的 memory.write Proposal。可见性来自模式数据，缺省 private（fail-closed） */
export function memoryProposals(u: Utterance, roomId: RoomId, modes: Map<string, UtteranceModeDef>, locName?: string): Proposal[] {
  const text = u.content ? `${u.content}${u.action ? ` (${u.action})` : ""}` : u.action ?? "";
  if (!text.trim()) return [];
  const visibility: "public" | "private" | "secret" = modes.get(u.mode)?.visibility ?? "private";
  const args: Record<string, unknown> = {
    ownerId: u.speaker,
    content: fitMemoryContent(text),
    // 地点 tag 让「在图书馆说过的话」和按地点检索的记忆真正重叠（#135；空 tag 会让打分恒 0）
    tags: locName ? ["dialogue", u.mode, locName] : ["dialogue", u.mode],
    // #135：关键线索可让模型通过 utterance.salience 提权（1–5 → 20–100 分），缺省 3
    salience: typeof u.salience === "number" ? Math.min(5, Math.max(1, Math.round(u.salience))) * 20 : 60,
    visibility,
  };
  if (u.target && u.target !== "all") args.about = Array.isArray(u.target) ? u.target : [u.target];
  return [{ op: "memory.write", args, reason: `group utterance (${u.mode})`, by: "dialogue.speak" }];
}

/** mental 记忆：只由引擎代写；plan 不自动执行，仅作为后续轮次的 secret 上下文 */
export function mentalProposal(actorId: ActorId, m: { thought: string; plan?: string; salience: number; about?: Id[] }): Proposal {
  return {
    op: "memory.write",
    args: {
      ownerId: actorId,
      // thought(≤300) + "plan: "(6) + plan(≤200) 可达 507 > 500；先拼接再统一截断，字段各自合法也不会打回整批
      content: fitMemoryContent([m.thought, m.plan ? `plan: ${m.plan}` : ""].filter(Boolean).join("\n")),
      tags: ["mental", ...(m.about ?? [])],
      salience: m.salience * 20,
      visibility: "secret",
      ...(m.about?.length ? { about: m.about } : {}),
    },
    reason: "NPC mental activity",
    by: "dialogue.think",
  };
}
