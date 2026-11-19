import { useCallback, useEffect, useState } from "react";
import { createDraft, getDraft, getMap } from "./api.ts";
import type { MapScene, SceneDraft } from "./api.ts";
import DraftCard from "./DraftCard.tsx";
import { errorMessage, sceneName } from "./ui.ts";
import type { LineKind } from "./ui.ts";

interface Props {
  roomId: string;
  push: (kind: LineKind, text: string) => void;
}

interface Form {
  name: string;
  idea: string;
  anchorLocId: string;
}

/** 草案面板（玩家侧）：创建提案 + 按 id 查询进度；审核/发布只在服务端管理端进行 */
export default function DraftsPanel({ roomId, push }: Props) {
  const [anchors, setAnchors] = useState<MapScene[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [form, setForm] = useState<Form>({ name: "", idea: "", anchorLocId: "" });
  const [created, setCreated] = useState<SceneDraft | null>(null);
  const [queryId, setQueryId] = useState("");
  const [queried, setQueried] = useState<SceneDraft | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const map = await getMap(roomId);
        if (!alive) return;
        setAnchors(map.scenes);
        setForm((prev) => ({
          ...prev,
          anchorLocId: prev.anchorLocId || map.player.locId || map.scenes[0]?.id || "",
        }));
      } catch (e) {
        if (alive) setErr(errorMessage(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [roomId]);

  const submitCreate = useCallback(async () => {
    const name = form.name.trim();
    const idea = form.idea.trim();
    if (name.length < 2 || name.length > 24) return setErr("名称需 2–24 字");
    if (idea.length < 10 || idea.length > 300) return setErr("想法需 10–300 字");
    if (!form.anchorLocId) return setErr("请选择锚点场景");
    setBusy("create");
    setErr("");
    try {
      const draft = await createDraft({ name, idea, anchorLocId: form.anchorLocId });
      setCreated(draft);
      setQueryId(draft.id);
      setForm((prev) => ({ ...prev, name: "", idea: "" }));
      push("system", `已提交场景草案「${draft.name}」（${draft.id}），等待管理员审核。`);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [form, push]);

  const submitQuery = useCallback(async () => {
    const id = queryId.trim();
    if (!id) return setErr("请输入草案 id");
    setBusy("query");
    setErr("");
    try {
      setQueried(await getDraft(id));
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [queryId]);

  const disabled = busy !== null;

  return (
    <div className="drafts-panel">
      <section className="drafts-col">
        <h2>造一个场景</h2>
        <p className="muted">玩家提案 → 管理员审核 → AI 生成草案 → 管理员审核发布。坐标由服务端按锚点随机生成。</p>
        <div className="field">
          <label htmlFor="draft-name">名称（2–24 字）</label>
          <input
            id="draft-name"
            value={form.name}
            maxLength={24}
            placeholder="例如：旧实验楼后门"
            onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
          />
        </div>
        <div className="field">
          <label htmlFor="draft-idea">想法（10–300 字）</label>
          <textarea
            id="draft-idea"
            value={form.idea}
            maxLength={300}
            placeholder="描述你希望这里发生什么、有什么线索或人物。"
            onChange={(e) => setForm((prev) => ({ ...prev, idea: e.target.value }))}
          />
        </div>
        <div className="field">
          <label htmlFor="draft-anchor">锚点场景</label>
          <select
            id="draft-anchor"
            value={form.anchorLocId}
            onChange={(e) => setForm((prev) => ({ ...prev, anchorLocId: e.target.value }))}
          >
            {anchors.map((scene) => (
              <option key={scene.id} value={scene.id}>
                {scene.name}
              </option>
            ))}
          </select>
        </div>
        <button className="btn primary" onClick={() => void submitCreate()} disabled={disabled}>
          提交草案
        </button>
        {err && <div className="err">{err}</div>}
        {busy && <div className="muted">处理中：{busy}</div>}
        {created && (
          <div className="created">
            <DraftCard draft={created} anchorName={sceneName(anchors, created.anchorLocId)} />
          </div>
        )}

        <h2>查询草案</h2>
        <div className="query-row">
          <input
            value={queryId}
            placeholder="draft_xxxxxxxx"
            onChange={(e) => setQueryId(e.target.value)}
          />
          <button className="btn" onClick={() => void submitQuery()} disabled={disabled}>
            查询
          </button>
        </div>
        {queried && (
          <DraftCard draft={queried} anchorName={sceneName(anchors, queried.anchorLocId)} />
        )}
      </section>
    </div>
  );
}