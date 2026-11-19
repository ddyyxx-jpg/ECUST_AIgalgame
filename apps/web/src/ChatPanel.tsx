/**
 * 对话页 = 2D 场景 + 底部对话框。
 *
 * 场景里用 WASD 走动、点 NPC 说话、点门换地方；
 * 对话框始终在底部（叙事要一直看得见），点 NPC 之后标题变成"和谁在说话"，
 * 输入框的提示也跟着换 —— 但输入仍然是自然语言，不受对话对象限制。
 */
import { useEffect, useRef, useState } from "react";
import type { ViewPatch, WorldState } from "../../../packages/shared/src/contract/types.ts";
import CampusMap from "./CampusMap.tsx";
import MiniMap from "./MiniMap.tsx";
import { getMap } from "./api.ts";
import type { MapView } from "./api.ts";
import { planNpcTalk } from "./npc-presence.ts";
import { phaseLabel } from "./ui.ts";
import type { Line, LineKind } from "./ui.ts";

/** 点了一个不在场的 NPC：只给说明与「前往」，不建立对话 */
type BlockedNpc =
  | { kind: "elsewhere"; id: string; name: string; locId: string; locName: string; error?: string }
  | { kind: "unlocatable"; id: string; name: string; reason: string };

export interface ChatPanelProps {
  state: WorldState | null;
  panels: ViewPatch["panels"];
  pos: ViewPatch["position"];
  lines: Line[];
  /** 正在打字的那一行（打字机状态）；null = 没有在打 */
  typing: { kind: LineKind; text: string } | null;
  busy: boolean;
  err: string;
  input: string;
  onInput: (value: string) => void;
  /** 提交行动；带上当前对话对象，服务端才知道你在跟谁说话 */
  onSend: (target?: { id: string; name: string } | null) => void;
  /** 每回合结束后的快捷行动建议（点击即说出这句话）；空数组 = 不显示 */
  suggestions: string[];
  onPick: (text: string, target?: { id: string; name: string } | null) => void;
  /** 点左上角小地图：展开全屏地图选点 */
  roomId: string;
  /** 状态版本号：与 GalleryPanel 一致，解锁 NPC 后据此重拉地图气泡 */
  version?: number;
  onOpenMap: () => void;
  /** 当前开局身份（用于左上角显示自己的头像） */
  heroId: string;
  /** 走到点位旁：静默同步世界状态（不往对话流里刷字）；返回是否真的到达 */
  onEnterScene: (locId: string) => Promise<{ ok: boolean; message?: string }>;
  /** 点击对话区 = 跳过打字动画 */
  onSkipLog: () => void;
  /** 上一回合失败且服务端标记可重试：重发最后一次玩家输入 */
  onRetry: () => void;
  retryable: boolean;
  /** 还有更早的已提交历史（服务端 hasEarlier）：显示"加载更早" */
  hasEarlier: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
}

export default function ChatPanel({
  state,
  panels,
  pos,
  lines,
  typing,
  busy,
  err,
  input,
  onInput,
  onSend,
  suggestions,
  onPick,
  roomId,
  version = 0,
  onOpenMap,
  heroId,
  onEnterScene,
  onSkipLog,
  onRetry,
  retryable,
  hasEarlier,
  loadingEarlier,
  onLoadEarlier,
}: ChatPanelProps) {
  const [talking, setTalking] = useState<{ id: string; name: string } | null>(null);
  /** 点击时记的是占位名；对方自报姓名解锁后，用权威状态里的真名覆盖标题/输入框 */
  const talkingName = talking ? (state?.entities[talking.id]?.name ?? talking.name) : "";
  const [blocked, setBlocked] = useState<BlockedNpc | null>(null);
  /** 「前往 TA 所在地」成功后，等位置真的切过去再选中这个人（避免被换场景的清理 effect 覆盖） */
  const [pendingTalk, setPendingTalk] = useState<{ id: string; name: string; locId: string } | null>(null);
  const [travelling, setTravelling] = useState(false);
  const [map, setMap] = useState<MapView | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  // 是否"跟着最新一条走"：玩家往上翻历史时不打扰，回到底部附近后自动恢复跟随
  const stickRef = useRef(true);

  const scrollToBottom = () => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    stickRef.current = true;
    scrollToBottom();
  }, []);

  useEffect(() => {
    if (stickRef.current) scrollToBottom();
  }, [lines, typing?.text]);

  // 换地点后把对话对象清掉：你走出去，就不该还挂着"和谁说话"
  useEffect(() => {
    setTalking(null);
  }, [pos?.locId]);

  // 「前往 TA 所在地」：travel 成功会推进 pos.locId，等它到位再选中目标 NPC
  useEffect(() => {
    if (!pendingTalk || pos?.locId !== pendingTalk.locId) return;
    setTalking({ id: pendingTalk.id, name: pendingTalk.name });
    setPendingTalk(null);
    setBlocked(null);
  }, [pos?.locId, pendingTalk]);

  // 地图数据：每次换地点重拉一次，顺便更新 NPC 的实时位置
  useEffect(() => {
    if (!roomId) return;
    let alive = true;
    getMap(roomId)
      .then((m) => {
        if (alive) setMap(m);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [roomId, pos?.locId]);

  /**
   * 点 NPC（issue #21-1）：只有和玩家同场景的人才打开对话；
   * 在别处的人不建立对话对象，改为提示 + 一键前往（复用地图 travel）。
   */
  const talkTo = (id: string, fallbackName: string) => {
    if (busy || !map) return;
    // 刚进房间还没跑过回合时 view.position 可能为空：以服务端地图的 player.locId 兜底，
    // 否则同场景的人会被误判成"在别处"。
    const currentLocId = pos?.locId || map.player.locId || "";
    const plan = planNpcTalk(map.npcs, map.scenes, id, fallbackName, currentLocId);
    if (plan.kind === "present") {
      setBlocked(null);
      setTalking({ id: plan.npc.id, name: plan.npc.name || fallbackName });
      return;
    }
    setTalking(null);
    if (plan.kind === "unlocatable") {
      setBlocked({ kind: "unlocatable", id, name: plan.name, reason: plan.reason });
      return;
    }
    setBlocked({ kind: "elsewhere", id, name: plan.npc.name || fallbackName, locId: plan.locId, locName: plan.locName });
  };

  const goToBlocked = async () => {
    if (!blocked || blocked.kind !== "elsewhere" || travelling || busy) return;
    const target = blocked;
    setTravelling(true);
    setBlocked({ ...target, error: undefined });
    const res = await onEnterScene(target.locId);
    setTravelling(false);
    if (!res.ok) {
      setBlocked({ ...target, error: res.message ?? "无法到达" });
      return;
    }
    setPendingTalk({ id: target.id, name: target.name, locId: target.locId });
  };

  const stats = (Object.values(panels ?? {})[0] ?? []).slice(0, 4);

  return (
    <div className="world-page">
      <div className="world-shell">
        <CampusMap
          map={map}
          roomId={roomId}
          version={version}
          heroSrc={`/heroes/hero-${heroId}.png`}
          talkingTo={talking?.id ?? ""}
          busy={busy}
          onTalk={talkTo}
          onEnter={onEnterScene}
        />

        <div className="world-hud-left">
          <MiniMap roomId={roomId} locId={pos?.locId ?? ""} onOpen={onOpenMap} />
          <div className="hud-place">
            {heroId && (
              <img
                className="hud-face"
                src={`/portraits/hero-${heroId}.jpg`}
                alt=""
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                }}
              />
            )}
            <div>
              <strong>{pos?.name ?? "—"}</strong>
              <span>{state ? `第 ${state.clock.day} 天 · ${phaseLabel(state.clock.phase)}` : "—"}</span>
            </div>
          </div>
        </div>

        <div className="world-hud-right">
          {stats.map((r) => (
            <span className="hud-stat" key={r.label}>
              <i>{r.label}</i>
              <b>
                {String(r.value)}
                {r.unit ?? ""}
              </b>
            </span>
          ))}
        </div>

        {lines.length === 0 && !typing && (
          <div className="world-hint">WASD 走动 · 走近 NPC 点他说话 · 底部也能直接输入行动</div>
        )}

        {/* 视觉小说式立绘：说话时从左侧滑入，站在对话框边上 */}
        {talking && (
          <div className="standee" key={talking.id}>
            <img
              src={`/portraits/${talking.id}.jpg`}
              alt=""
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          </div>
        )}
      </div>

      <div className={`dialog-dock${talking ? " talking" : ""}`}>
        <div className="dock-bar">
          {talking ? (
            <>
              <span className="dock-face">
                <img
                  src={`/portraits/${talking.id}.jpg`}
                  alt=""
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
              </span>
              <strong>{talkingName || talking.name}</strong>
              <span className="muted">正在对话</span>
              <button type="button" className="btn ghost" onClick={() => setTalking(null)}>
                结束对话
              </button>
            </>
          ) : (
            <span className="muted">自由行动</span>
          )}
          <button type="button" className="btn ghost dock-fold" onClick={onSkipLog} title="跳过打字动画">
            ⏩
          </button>
        </div>

        <div
          className="log"
          ref={logRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          }}
          onClick={() => {
            onSkipLog();
            stickRef.current = true;
            requestAnimationFrame(scrollToBottom);
          }}
          title="点击可跳过打字动画并定位到最新剧情"
        >
          {hasEarlier && (
            <button
              type="button"
              className="btn ghost load-earlier"
              disabled={loadingEarlier}
              onClick={(e) => {
                // 不触发日志区的"跳过打字 + 滚到底部"
                e.stopPropagation();
                onLoadEarlier();
              }}
            >
              {loadingEarlier ? "正在加载更早…" : "加载更早"}
            </button>
          )}
          {lines.map((l) => (
            <p key={l.id} className={`line ${l.kind}`}>
              {l.text}
            </p>
          ))}
          {typing && (
            <p className={`line ${typing.kind} typing`}>
              {typing.text}
              <span className="caret" />
            </p>
          )}
          {busy && !typing && <p className="line system">…</p>}
        </div>

        {blocked && (
          <div className={`scene-notice${blocked.kind === "unlocatable" ? " unlocatable" : ""}`}>
            <span>
              {blocked.kind === "unlocatable"
                ? `${blocked.name} 不在这里，而且${blocked.reason}，所以没法直接找过去。`
                : `${blocked.name} 不在这里（现在在「${blocked.locName}」）。`}
            </span>
            {blocked.kind === "elsewhere" && (
              <button type="button" className="btn" onClick={() => void goToBlocked()} disabled={busy || travelling}>
                {travelling ? "正在前往…" : "前往 TA 所在地"}
              </button>
            )}
            {blocked.kind === "elsewhere" && blocked.error && (
              <em className="notice-err">前往失败：{blocked.error}</em>
            )}
            <button type="button" className="btn ghost" onClick={() => setBlocked(null)} disabled={travelling}>
              知道了
            </button>
          </div>
        )}

        {err && (
          <div className="err">
            <span>{err}</span>
            {retryable && (
              <button type="button" className="btn retry" onClick={onRetry} disabled={busy}>
                重试
              </button>
            )}
          </div>
        )}

        {suggestions.length > 0 && (
          <div className="suggestions">
            <span className="muted">你可以：</span>
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                className="suggest-chip"
                onClick={() => onPick(s, talking ? { id: talking.id, name: talkingName } : null)}
                disabled={busy || !state}
                title={`说出：${s}`}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            onSend(talking ? { id: talking.id, name: talkingName } : null);
          }}
        >
          <input
            value={input}
            onChange={(e) => onInput(e.target.value)}
            placeholder={talking ? `对${talkingName}说…` : "你要做什么？（也可以直接用 WASD 走动）"}
            disabled={busy || !state}
          />
          <button type="submit" disabled={busy || !state}>
            行动
          </button>
        </form>
      </div>
    </div>
  );
}
