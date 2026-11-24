/**
 * 候选行动的分级纯逻辑（PR-4 / issue #139）。
 *
 * kind 由建议的来源侧直接给出：openings.json 的内容作者标注，或 turnSuggestions
 * 按出口（move）/在场 NPC（talk）生成。这里只做归一化、过滤、去重、编号，
 * 不再从中文文本猜类别（旧版 /^去/、/^(和|跟|找|与)/ 前缀启发式已删除）。
 *
 * 为什么配数字键：这是一个回合制文字游戏，一回合最多几个候选、位置固定，
 * 玩家不用每回合把鼠标从输入框挪到候选条上；数字键 1–6 与数组下标严格一致，
 * 看到 hint 就知道按哪个。是否抢键由面板挂载时的键盘监听统一判断（输入框内不抢）。
 */

/** 现有展示层分组全集；action 承担"其他/查看"桶 */
export const CANDIDATE_KINDS = ["move", "talk", "action"] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

/** 建议的跨端形状（旧服务端只给字符串时仍可读，见 normalizeSuggestion） */
export interface Suggestion {
  text: string;
  kind: CandidateKind;
  /** talk 候选指向的 NPC：点候选时按它定向，而不是按“当前选中的对话对象” */
  actorId?: string;
}
export type SuggestionInput = Suggestion | string;

export interface Candidate {
  /** 稳定 key：kind + 原文（同原文已去重） */
  id: string;
  /** 点一下就发这句话 */
  text: string;
  kind: CandidateKind;
  /** 数字键提示："1"…"6"；与数组下标一致 */
  hint: string;
  /** 同 Suggestion.actorId：这条候选该说给谁听 */
  actorId?: string;
}

export const DEFAULT_MAX_CANDIDATES = 6;

/**
 * 旧数据兼容：只有字符串时归到 action（展示层"其他"桶）。
 * 不做任何中文前缀推断——前缀≠语义，issue #139 的两个误分级就是这么来的。
 */
export function normalizeSuggestion(input: SuggestionInput): Suggestion {
  if (typeof input === "string") return { text: input, kind: "action" };
  return { text: input.text, kind: input.kind, ...(input.actorId ? { actorId: input.actorId } : {}) };
}

/**
 * trim → 丢空串 → 按去空白后的原文去重（保留第一次出现）→ 截断 → 生成 hint/id。
 * 不改变输入顺序：候选的顺序就是来源侧给出的顺序，玩家读起来才稳定。
 */
export function buildCandidates(
  suggestions: readonly SuggestionInput[],
  opts?: { max?: number },
): Candidate[] {
  const rawMax = opts?.max ?? DEFAULT_MAX_CANDIDATES;
  const max = Number.isFinite(rawMax) ? Math.max(1, Math.floor(rawMax)) : DEFAULT_MAX_CANDIDATES;

  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const raw of suggestions) {
    const { text: rawText, kind } = normalizeSuggestion(raw);
    const text = rawText.trim();
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    out.push({ id: `${kind}:${text}`, text, kind, hint: String(out.length + 1) });
    if (out.length >= max) break;
  }
  return out;
}
