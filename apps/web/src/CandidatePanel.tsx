/**
 * 候选行动面板：把纯文本 suggestions 渲染成一组带数字键的候选条（PR-4）。
 *
 * 这里只负责展示与点击转发：不发请求、不读全局状态、不推导候选；
 * 分级与编号来自 candidates.ts，点击后仍走 ChatPanel 的 onPick。
 * 禁用条件统一是「回合进行中」或「权威状态未就绪」，避免点了没反应。
 */
import type { Candidate } from "./candidates.ts";

interface Props {
  candidates: Candidate[];
  /** 回合进行中/无状态下不可点 */
  disabled: boolean;
  /** 权威状态是否已就绪（老逻辑：!state 时禁点） */
  ready: boolean;
  /** 当前对话对象：点了候选就按这个 target 说话；null = 没有选中的人 */
  target: { id: string; name: string } | null;
  onPick: (text: string, target?: { id: string; name: string } | null) => void;
}

export default function CandidatePanel({ candidates, disabled, ready, target, onPick }: Props) {
  if (candidates.length === 0) return null;

  return (
    <div className="candidate-panel" role="group" aria-label="候选行动">
      <span className="candidate-caption">候选行动</span>
      {candidates.map((c) => (
        <button
          key={c.id}
          type="button"
          className={"candidate-chip kind-" + c.kind}
          title={`说出：${c.text}`}
          disabled={disabled || !ready}
          onClick={() => onPick(c.text, target)}
        >
          <kbd className="candidate-hint">{c.hint}</kbd>
          <span>{c.text}</span>
        </button>
      ))}
    </div>
  );
}
