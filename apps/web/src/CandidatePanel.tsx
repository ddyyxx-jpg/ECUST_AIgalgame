/**
 * 候选行动面板：把 suggestions 渲染成一组带数字键的候选条（PR-4 / issue #139）。
 *
 * 这里只负责展示与点击转发：不发请求、不读全局状态、不推导候选；
 * kind 来自来源（openings 数据 / turnSuggestions），分组与编号在 candidates.ts 归一化，
 * 点击后仍走 ChatPanel 的 onPick。
 * 禁用条件统一是「回合进行中」或「权威状态未就绪」，避免点了没反应。
 */
import type { Candidate } from "./candidates.ts";

interface Props {
  candidates: Candidate[];
  /** 回合进行中/无状态下不可点 */
  disabled: boolean;
  /** 权威状态是否已就绪（老逻辑：!state 时禁点） */
  ready: boolean;
  /**
   * 激活一条候选：talk 候选是“指名对象”（选中对话对象、等玩家自己说），
   * 其余候选才直接发出去。判定放在 ChatPanel，面板只转发。
   */
  onActivate: (c: Candidate) => void;
}

export default function CandidatePanel({ candidates, disabled, ready, onActivate }: Props) {
  if (candidates.length === 0) return null;

  return (
    <div className="candidate-panel" role="group" aria-label="候选行动">
      <span className="candidate-caption">候选行动</span>
      {candidates.map((c) => (
        <button
          key={c.id}
          type="button"
          className={"candidate-chip kind-" + c.kind}
          title={c.kind === "talk" ? "点一下选中对话对象，再输入你想说的话" : `说出：${c.text}`}
          disabled={disabled || !ready}
          onClick={() => onActivate(c)}
        >
          <kbd className="candidate-hint">{c.hint}</kbd>
          <span>{c.text}</span>
        </button>
      ))}
    </div>
  );
}
