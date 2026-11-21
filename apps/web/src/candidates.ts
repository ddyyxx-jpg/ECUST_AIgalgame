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

/** 「去某地」→ move；与 suggestions.ts 的 `去${e.name}` 模板对应 */
const MOVE_PREFIX = /^去/;
/** 「和/跟/找/与某人说话」→ talk；与 suggestions.ts 的 `和${a.name}说话` 模板对应 */
const TALK_PREFIX = /^(和|跟|找|与)/;

/**
 * 分级规则表：**仅展示层启发式**，不是语义理解。
 *
 * 建议由 suggestions.ts 的模板生成（`去${地点}` / `和${人名}说话`），
 * 开头动词就是最可靠的信号，所以这里只看前缀、不做 NLP。顺序即优先级，先命中先生效。
 * 这张表只决定候选条的分组/配色，不参与服务端判定，也不进任何契约。
 *
 * 将来 suggestions 若在契约里带上 kind（需要改 docs/03 并 bump 版本），
 * 可以改成直通并删掉这张表；本轮不改契约，避免为一个 UI 分组牵动服务端。
 * 配置化也只需替换这张表，classifySuggestion 与测试不用动。
 *
 * 已知局限（中文前缀 ≠ 语义，已登记 issue #139）：openings 的「问室友监控的事」
 * 会被归为 action、「去找校刊编辑部打听」会被归为 move，只影响分组颜色，不影响发送。
 * suggestions 侧直接产出 kind 后，即可删除本表与 MOVE_PREFIX / TALK_PREFIX。
 */
const CLASSIFY_RULES: readonly { kind: CandidateKind; prefix: RegExp }[] = [
  { kind: "move", prefix: MOVE_PREFIX },
  { kind: "talk", prefix: TALK_PREFIX },
];

/**
 * 只看句子开头的动词，不做语义理解：建议本来就是模板生成的，
 * 前缀就是最可靠的信号；未命中规则的一律归到 action（其他）。
 */
export function classifySuggestion(text: string): CandidateKind {
  const t = text.trim();
  for (const rule of CLASSIFY_RULES) {
    if (rule.prefix.test(t)) return rule.kind;
  }
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
