import type { SceneDraft } from "./api.ts";
import { draftStatusLabel, formatTime } from "./ui.ts";

interface Props {
  draft: SceneDraft;
  anchorName: string;
}

/** 草案卡片（玩家侧）：状态 + 生成预览；审核/发布操作只在服务端管理端 */
export default function DraftCard({ draft, anchorName }: Props) {
  const generated = draft.generated;
  return (
    <article className="draft">
      <header>
        <span className={`pill ${draft.status}`}>{draftStatusLabel(draft.status)}</span>
        <strong>{draft.name}</strong>
        <span className="muted draft-id">{draft.id}</span>
      </header>
      <div className="muted">
        锚点：{anchorName} · 坐标 ({draft.coords?.x ?? "?"}, {draft.coords?.y ?? "?"}) · 更新{" "}
        {formatTime(draft.updatedAt)}
      </div>
      <p className="idea">{draft.idea}</p>
      {draft.error && <div className="draft-err">生成失败：{draft.error}</div>}
      {generated && (
        <div className="preview">
          <div className="preview-title">生成预览：{generated.name}</div>
          <p>{generated.desc}</p>
          <div className="chips">
            {(generated.tags ?? []).map((tag) => (
              <span key={tag} className="chip tag">
                {tag}
              </span>
            ))}
          </div>
          {(generated.links ?? []).length > 0 && (
            <div className="muted">
              链接：{generated.links.map((link) => link.label ?? link.id).join("、")}
            </div>
          )}
          {(generated.dialogues ?? []).map((dialogue) => (
            <div key={`${dialogue.title}:${dialogue.npcId}`} className="dlg">
              <div className="muted">
                {dialogue.title}（{dialogue.npcId}）
              </div>
              {(dialogue.lines ?? []).map((line, i) => (
                <p key={i} className="line npc">
                  {line}
                </p>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="muted history">
        历史：
        {(draft.history ?? []).map((h) => `${h.actor}:${h.action}`).join(" → ") || "—"}
      </div>
    </article>
  );
}
