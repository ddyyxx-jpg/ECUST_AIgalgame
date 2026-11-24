/**
 * 对话页 = 2D 场景 + 底部对话框。
 *
 * 场景里用 WASD 走动、点 NPC 说话、点门换地方；
 * 对话框始终在底部（叙事要一直看得见），点 NPC 之后标题变成"和谁在说话"，
 * 输入框的提示也跟着换 —— 但输入仍然是自然语言，不受对话对象限制。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { hudStats, isActionPointRow } from "./hud-stats.ts";
import type { ViewPatch, WorldState } from "../../../packages/shared/src/contract/types.ts";
import CampusMap from "./CampusMap.tsx";
import CandidatePanel from "./CandidatePanel.tsx";
import InteriorMap from "./InteriorMap.tsx";
import MiniMap from "./MiniMap.tsx";
import { candidateKeyIndex } from "./candidate-keys.ts";
import { buildCandidates } from "./candidates.ts";
import type { SuggestionInput } from "./candidates.ts";
import { getMap } from "./api.ts";
import type { MapView } from "./api.ts";
import { interiorFor, interiorNpcSpot } from "./interior.ts";
import { planNpcTalk } from "./npc-presence.ts";
import { validateUtteranceDraft } from "./conversation-api.ts";
import type { UtteranceDraft, UtteranceModeInfo } from "./conversation-api.ts";
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
  /**
   * 已知的两个全屏遮罩（地图 MapOverlay、局内调试面板 DebugPanel）之一是否打开。
   * 显式登记而非「任意 dialog」：遮罩只是叠在上面、不会卸载 ChatPanel，所以数字键
   * 快选必须显式关掉；新增局内 dialog 需同步登记到 fullScreenOverlayOpen。
   * 否则遮罩里按 1 会穿透成 onPick→send，真的发出一个回合（PR #127 P1）。
   */
  overlayOpen: boolean;
  err: string;
  input: string;
  onInput: (value: string) => void;
  /** 提交行动；带上当前对话对象，服务端才知道你在跟谁说话 */
  onSend: (target?: { id: string; name: string } | null) => void;
  /** 每回合结束后的快捷行动建议（点击即说出这句话）；空数组 = 不显示 */
  suggestions: SuggestionInput[];
  /** 提交候选行动；返回 send 的 Promise 时，数字键快选在 settle 后解除自锁（见 busyRef） */
  onPick: (text: string, target?: { id: string; name: string } | null) => Promise<void> | undefined;
  /** 当前室内场景 id（App 持有，跨 tab 保留）；null = 校园大地图 */
  inside: string | null;
  /** 进入 / 退出室内地图 */
  onInsideChange: (locId: string | null) => void;
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
  /** v2 conversation.phase=listening：等待插话态（服务端 30s 自动恢复 speaking 后前端清掉） */
  waitingForInterjection?: boolean;
  /** 还有更早的已提交历史（服务端 hasEarlier）：显示"加载更早" */
  hasEarlier: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  /** v2 会话：说话类型清单（来自 GET /conversation/modes）；不提供则走 v1 老流程 */
  v2Modes?: UtteranceModeInfo[];
  /** v2 会话：让在场 NPC 自己聊一轮（玩家不说话）；不提供则不显示按钮 */
  onAutoRound?: () => void;
  /** v2 会话：提交一条完整 utterance（mode/target/content/action），与 onSend 二选一 */
  onSendUtterance?: (draft: UtteranceDraft) => void;
  /** v2 回合的乐观玩家行：等引擎把自己的 delivery 投回来就清掉（避免点了发送没反应） */
  pendingLines?: { kind: LineKind; text: string }[];
  /** 行动点已归零：显示「推进时段」入口，避免玩家卡在“行动点不足”里找不到出口 */
  zeroActionPoints?: boolean;
  /** 推进时段（服务端 tick advance）：回满行动点 */
  onRest?: () => void;
}

export default function ChatPanel({
  state,
  panels,
  pos,
  lines,
  typing,
  busy,
  overlayOpen,
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
  waitingForInterjection = false,
  hasEarlier,
  loadingEarlier,
  zeroActionPoints = false,
  onRest,
  onLoadEarlier,
  v2Modes,
  onSendUtterance,
  onAutoRound,
  pendingLines,
  inside: insideSceneId,
  onInsideChange,
}: ChatPanelProps) {
  const [talking, setTalking] = useState<{ id: string; name: string } | null>(null);
  /** 点击时记的是占位名；对方自报姓名解锁后，用权威状态里的真名覆盖标题/输入框 */
  const talkingName = talking ? (state?.entities[talking.id]?.name ?? talking.name) : "";
  const [blocked, setBlocked] = useState<BlockedNpc | null>(null);
  /** 「前往 TA 所在地」成功后，等位置真的切过去再选中这个人（避免被换场景的清理 effect 覆盖） */
  const [pendingTalk, setPendingTalk] = useState<{ id: string; name: string; locId: string } | null>(null);
  const [travelling, setTravelling] = useState(false);
  const [map, setMap] = useState<MapView | null>(null);
  /**
   * 当前所在室内地图对应的场景 id；null = 在校园大地图。
   * 这个标记必须由 App 持有：切「图鉴」等 tab 会卸载 ChatPanel（key={tab}），
   * 本地 state 会丢，回来就落到大地图，看起来像「被传送到楼外」。
   */
  const inside = insideSceneId;
  const setInside = onInsideChange;
  /** 刚点了入口、等世界状态真的走到该场景后再切渲染 */
  const [enteringInterior, setEnteringInterior] = useState<string | null>(null);
  /** v2 demo：当前说话类型（mode）与动作文本（action）；仅在 v2Modes 提供时显示 */
  const [mode, setMode] = useState("broadcast");
  const [action, setAction] = useState("");
  // 进房后用户尚未选择说话类型/输入内容时，不提前弹校验提示（避免一进房就报"请填写说话内容或动作"）
  const [v2Touched, setV2Touched] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  // 是否"跟着最新一条走"：玩家往上翻历史时不打扰，回到底部附近后自动恢复跟随
  const stickRef = useRef(true);
  /**
   * 数字键快选读的「最新 busy」：keydown 监听是 effect 里的闭包，
   * onPick→send→setBusy(true) 要等本次事件结束才提交；同一帧内的第二次按键
   * 若读到闭包里的旧 busy 就会连发。这里每次渲染同步 ref，并在真正发出候选后
   * 立刻置 true 兜住提交前的空窗（PR #127 P2）。
   * 复位：onPick 返回的 Promise settle 时复位（成功/失败/守卫提前返回都有路径），
   * 另由 busy prop 的 effect 同步兜底，避免只等 prop 翻转造成自锁（PR #127 复审 P3）。
   */
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

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

  // v2 modes 到位后校正默认值：不硬编码 "broadcast"，服务端清单若去掉它也能落到第一个合法 mode
  useEffect(() => {
    if (v2Modes && v2Modes.length > 0 && !v2Modes.some((m) => m.id === mode)) {
      setMode(v2Modes[0]!.id);
    }
  }, [v2Modes, mode]);

  // 换地点后把对话对象清掉：你走出去，就不该还挂着"和谁说话"
  useEffect(() => {
    setTalking(null);
  }, [pos?.locId]);

  // 进室内：等 pos 真的落到该场景再切渲染，避免"人在路上就已经在馆里"
  useEffect(() => {
    if (!enteringInterior) return;
    if (pos?.locId === enteringInterior) {
      setInside(enteringInterior);
      setEnteringInterior(null);
      return;
    }
    // 传送失败或超时：清掉等待，留在原地
    const t = window.setTimeout(() => setEnteringInterior(null), 3000);
    return () => window.clearTimeout(t);
  }, [enteringInterior, pos?.locId]);

  // 被传送到别处（点了小地图 / 世界状态变化）：自动退出门内地图
  useEffect(() => {
    if (inside && pos?.locId && pos.locId !== inside) setInside(null);
  }, [inside, pos?.locId]);

  // 「前往 TA 所在地」：travel 成功会推进 pos.locId，等它到位再选中目标 NPC
  useEffect(() => {
    if (!pendingTalk || pos?.locId !== pendingTalk.locId) return;
    setTalking({ id: pendingTalk.id, name: pendingTalk.name });
    // issue #110：选中对话目标即视为"已交互"，否则缺伴随动作时按钮禁用却无提示
    setV2Touched(true);
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
   * 时间推进不在这里做：权威时间只能由服务端推进（MapPanel 的「推进时段」或后续的服务端定时），
   * 前端定时器会让多 tab 叠加推进、并在玩家挂机时白烧剧情成本（PR #148 审阅 P1-c）。
   */

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
      // issue #110：点选在场 NPC 与选方式/输入同等视为"已交互"，让缺参数的校验提示出现
      setV2Touched(true);
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

  /** 时段的外观：颜色和图标，让时间在画面上一眼能认出来 */
const PHASE_META: Record<string, { name: string; icon: string; color: string }> = {
  morning: { name: "早上", icon: "☀", color: "#ffd479" },
  noon: { name: "中午", icon: "☀", color: "#fff3c0" },
  afternoon: { name: "下午", icon: "⛅", color: "#ffb877" },
  evening: { name: "傍晚", icon: "◐", color: "#ff8f63" },
  night: { name: "夜里", icon: "☾", color: "#7ea6ff" },
};

  // 室内视图：当前场景是否挂了室内地图，以及馆内的 NPC（位置按索引落到馆内座位点）
  const insideInterior = inside ? interiorFor(inside) : null;
  const interiorNpcs = useMemo(() => {
    if (!map || !inside) return [];
    return map.npcs
      .filter((n) => n.locId === inside)
      .map((n, i) => ({ ...n, ...interiorNpcSpot(i) }));
  }, [map, inside]);

  // v2 demo：当前说话类型与本地校验（规则对齐引擎 delivery.ts，避免用户第一次点就吃 E_SCHEMA_INVALID）
  const v2Active = Boolean(v2Modes && v2Modes.length > 0 && onSendUtterance);
  const panelRows = Object.values(panels ?? {})[0] ?? [];
  // 行动点目前只覆盖 v1 /turns；v2 群聊模式显示 6/6 会骗人，直接隐藏。
  const stats = hudStats(panelRows); // v2 也扣行动点（#153 复审 P1），必须显示
  const currentMode = v2Modes?.find((m) => m.id === mode);
  const draft = {
    mode,
    ...(talking ? { target: talking.id } : {}),
    ...(currentMode?.contentless ? {} : { content: input }),
    ...(action ? { action } : {}),
  };
  const v2Check = v2Active && v2Modes ? validateUtteranceDraft(draft, v2Modes) : { ok: true };
  const submitDisabled = busy || !state || !v2Check.ok;

  // 候选行动：只依赖 suggestions，kind 由来源给出；去重/编号在纯函数里做（见 candidates.ts）
  const candidates = useMemo(() => buildCandidates(suggestions), [suggestions]);

  // 数字键 1–6 快选：只在对话页标签激活时挂载（切走 tab 即卸载，故「切页面」不靠这里判断）。
  // 已知两个全屏遮罩（地图 MapOverlay、局内调试面板 DebugPanel）不会卸载本组件，
  // 必须由 App 传 overlayOpen 显式关掉这套语义；新增局内 dialog 需登记到 fullScreenOverlayOpen。
  // 否则遮罩打开时按 1 仍会 onPick→send，真的发出一个回合（PR #127 P1）。
  // 其余判定（repeat/修饰键/表单/可编辑元素/busy/范围）都在 candidate-keys.ts 的纯函数里，可独立测试。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const index = candidateKeyIndex(
        { key: e.key, repeat: e.repeat, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey },
        {
          overlayOpen,
          busy: busyRef.current,
          ready: Boolean(state),
          count: candidates.length,
          targetTag: el?.tagName ?? null,
          targetIsContentEditable: el?.isContentEditable ?? false,
        },
      );
      if (index === null) return;
      e.preventDefault();
      // 发给父组件后本帧内不再接第二发：setBusy(true) 的提交慢于本次事件
      busyRef.current = true;
      const picked = onPick(
        candidates[index - 1].text,
        talking ? { id: talking.id, name: talkingName } : null,
      );
      // 父组件返回 send 的 Promise：成功、失败、守卫提前返回都会在 settle 后解除自锁。
      // 不改成「只依赖 busy prop」：第二次按键可能早于 effect 同步 busy，会重新同帧连发；
      // 因此保留 ref，并补上这条确定性的复位路径。onPick 返回 undefined 时交给 busy effect。
      if (picked) {
        void picked.then(
          () => { busyRef.current = false; },
          () => { busyRef.current = false; },
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [candidates, state, overlayOpen, talking, talkingName, onPick]);

  return (
    <div className="world-page">
      <div className="world-shell">
        {insideInterior ? (
          <InteriorMap
            key={insideInterior.image}
            interior={insideInterior}
            npcs={interiorNpcs}
            heroSrc={`/heroes/hero-${heroId}-down.png`}
            talkingTo={talking?.id ?? ""}
            busy={busy}
            onTalk={talkTo}
            onExit={() => setInside(null)}
          />
        ) : (
          <CampusMap
            map={map}
            roomId={roomId}
            version={version}
            heroSrc={`/heroes/hero-${heroId}-down.png`}
            talkingTo={talking?.id ?? ""}
            busy={busy}
            onTalk={talkTo}
            onEnter={onEnterScene}
            onEnterInterior={setEnteringInterior}
          />
        )}
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
          {state && (
            <div className="hud-clock" data-phase={state.clock.phase}>
              <i aria-hidden="true">{PHASE_META[state.clock.phase]?.icon ?? "☀"}</i>
              <div>
                <b>第 {state.clock.day} 天</b>
                <span>{PHASE_META[state.clock.phase]?.name ?? phaseLabel(state.clock.phase)}</span>
              </div>
            </div>
          )}
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
          <button
            type="button"
            className="btn ghost dock-fold"
            onClick={onSkipLog}
            title="跳过打字动画"
            aria-label="跳过打字动画"
          >
            <svg width="15" height="12" viewBox="0 0 15 12" aria-hidden="true">
              <path d="M1 1 L6.5 6 L1 11 Z" fill="currentColor" />
              <path d="M8 1 L13.5 6 L8 11 Z" fill="currentColor" />
            </svg>
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
          {pendingLines?.map((l, i) => (
            <p key={`pending-${i}`} className={`line ${l.kind} pending`}>
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
          {waitingForInterjection && (
            <p className="line system interjection-wait">对方说完了，等你插话…</p>
          )}
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

        <CandidatePanel
          candidates={candidates}
          disabled={busy}
          ready={Boolean(state)}
          target={talking ? { id: talking.id, name: talkingName } : null}
          onPick={onPick}
        />

        {/* v2 demo：说话类型选择 + @谁（点场景里的 NPC 即 talking）。老流程无 v2Modes 时不显示。
            注意：这里**不能**加 requiresAction 门控——broadcast/addressed/dm 的 requiresAction 是 false，
            一加就会让「让他们继续聊」在默认模式下整块消失（PR #148 审阅 P1-a）。说话类型下拉在 form 里，这里不重复。 */}
        {v2Active && v2Modes && (
          <div className="v2-composer-opts">
            {onAutoRound && (
              <button
                type="button"
                className="v2-auto-round"
                onClick={onAutoRound}
                disabled={busy || !state}
                title="让在场 NPC 自己聊一轮（玩家不说话）"
              >
                让他们继续聊
              </button>
            )}
            {currentMode?.requiresAction && (
              <input
                className="v2-action"
                value={action}
                onChange={(e) => {
                  setAction(e.target.value);
                  setV2Touched(true);
                }}
                placeholder="伴随动作（必填，自然语言）"
                disabled={busy || !state}
              />
            )}
          </div>
        )}
        {/* 本地校验提示：与引擎规则一致，拦在提交前；进房未交互时不提前打扰（等用户先动一下） */}
        {v2Active && v2Touched && !v2Check.ok && (
          <div className="v2-hint" role="status">
            {v2Check.reason}
          </div>
        )}
        {zeroActionPoints && onRest && (
          <div className="action-rest" role="status">
            <span>行动点已用完：休息一下推进时段，行动点会回满。</span>
            <button type="button" className="btn" onClick={onRest} disabled={busy}>
              推进时段
            </button>
          </div>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (v2Active && onSendUtterance) {
              if (!v2Check.ok) return;
              onSendUtterance(draft);
              setAction("");
              return;
            }
            onSend(talking ? { id: talking.id, name: talkingName } : null);
          }}
        >
          {/* 说话类型放在输入框左侧，只留下拉本身 */}
          {v2Active && v2Modes && (
            <select
              className="v2-mode-select"
              aria-label="说话类型"
              title="说话类型"
              value={mode}
              onChange={(e) => {
                setMode(e.target.value);
                setV2Touched(true);
              }}
              disabled={busy || !state}
            >
              {v2Modes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          )}
          {v2Active && currentMode?.contentless ? (
            <div className="v2-contentless-note" role="note">
              此方式只填动作，不说话
            </div>
          ) : (
            <input
              value={input}
              onChange={(e) => {
                onInput(e.target.value);
                setV2Touched(true);
              }}
              placeholder={
                v2Active
                  ? talking
                    ? `对${talkingName}说…（自然语言）`
                    : "公开说什么？（自然语言，点 NPC 可改为私下说）"
                  : talking
                    ? `对${talkingName}说…`
                    : "你要做什么？（也可以直接用 WASD 走动）"
              }
              disabled={busy || !state}
            />
          )}
          <button type="submit" disabled={submitDisabled}>
            行动
          </button>
        </form>
      </div>
    </div>
  );
}
