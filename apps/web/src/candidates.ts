/**
 * 候选行动的分级纯逻辑（PR-4）。
 *
 * 为什么在前端分级：suggestions 本来就是前端从服务端已下发的 View.position
 * 推导出来的输入辅助（见 suggestions.ts）。给它加"移动/说话/其他"的类别只是
 * 展示层的分组，不需要服务端多下发一个字段，也不需要动 docs/03 的契约版本。
 * 后端与引擎完全无感知，失败面只剩这一层纯函数。
 *
 * 为什么配数字键：这是一个回合制文字游戏，一回合最多几个候选、位置固定，
 * 玩家不用每回合把鼠标从输入框挪到候选条上；数字键 1–6 与数组下标严格一致，
 * 看到 hint 就知道按哪个。是否抢键由面板挂载时的键盘监听统一判断（输入框内不抢）。
 */

export type CandidateKind = "move" | "talk" | "action";

export interface Candidate {
  /** 稳定 key：kind + 原文（同 kind 下原文已去重） */
  id: string;
  /** 点一下就发这句话 */
  text: string;
  kind: CandidateKind;
  /** 数字键提示："1"…"6"；与数组下标一致 */
  hint: string;
}

export const DEFAULT_MAX_CANDIDATES = 6;

/**
 * 只看句子开头的动词，不做语义理解：建议本来就是模板生成的
 * （`去${地点}` / `和${人名}说话`），前缀就是最可靠的信号。
 */
export function classifySuggestion(text: string): CandidateKind {
  const t = text.trim();
  if (/^去/.test(t)) return "move";
  if (/^(和|跟|找|与)/.test(t)) return "talk";
  return "action";
}

/**
 * trim → 丢空串 → 按去空白后的原文去重（保留第一次出现）→ 截断 → 生成 hint/id。
 * 不改变输入顺序：候选的顺序就是服务端推导出来的顺序，玩家读起来才稳定。
 */
export function buildCandidates(
  suggestions: readonly string[],
  opts?: { max?: number },
): Candidate[] {
  const rawMax = opts?.max ?? DEFAULT_MAX_CANDIDATES;
  const max = Number.isFinite(rawMax) ? Math.max(1, Math.floor(rawMax)) : DEFAULT_MAX_CANDIDATES;

  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const s of suggestions) {
    const text = s.trim();
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    const kind = classifySuggestion(text);
    out.push({ id: `${kind}:${text}`, text, kind, hint: String(out.length + 1) });
    if (out.length >= max) break;
  }
  return out;
}
