import { useCallback, useEffect, useRef, useState } from "react";
import type { WorldState, ViewPatch } from "../../../packages/shared/src/contract/types.ts";
import { LEGACY_ACTOR_ID, createSoloRoom, deleteSave, fetchHistory, fetchState, fetchTurnStatus, runTurn, travel } from "./api.ts";
import type { HistoryPage } from "./api.ts";
import { GameError, HttpError, httpFailMessage, isUnauthorized, onUnauthorized } from "./http.ts";
import { useAuth } from "./use-auth.ts";
import { useSaves } from "./use-saves.ts";
import { RequestScope } from "./request-scope.ts";
import { earlierCursor, historyToLines, missingTurnContent, restoreConversation } from "./history-lines.ts";
import { makeTurnHandlers } from "./turn-handlers.ts";
import AuthScreen from "./AuthScreen.tsx";
import type { SaveEntry } from "./api.ts";
import ChatPanel from "./ChatPanel.tsx";
import DraftsPanel from "./DraftsPanel.tsx";
import InboxPanel from "./InboxPanel.tsx";
import GalleryPanel from "./GalleryPanel.tsx";
import MapOverlay from "./MapOverlay.tsx";
import TitleScreen from "./TitleScreen.tsx";
import { fetchScenarios } from "./scenarios.ts";
import type { Scenario } from "./scenarios.ts";
import { turnSuggestions } from "./suggestions.ts";
import { installClickSound, setSoundOn, soundOn } from "./sfx.ts";
import { Typewriter } from "./typewriter.ts";
import { shouldDropRetryOnMove } from "./turn-error.ts";
import { createSessionResync, type SessionResync } from "./session-wiring.ts";
import { loadRoomThenReset } from "./room-enter.ts";
import { fetchRoomEvents } from "./events-replay.ts";
import { npcLocIdFromLinks, targetStillInScene } from "./npc-presence.ts";
import { phaseLabel } from "./ui.ts";
import type { Line, LineKind } from "./ui.ts";
import type { ConversationEvent } from "../../../packages/shared/src/contract/v2.ts";
import { detectConversation, fetchUtteranceModes, runConversationTurn, runConversationUtterance } from "./conversation-api.ts";
import type { UtteranceDraft, UtteranceModeInfo } from "./conversation-api.ts";
import { DEFAULT_LISTEN_TIMEOUT_MS, initialConversationView, isListeningExpired, linesFromView, pendingLinesFor, reduceConversationView } from "./conversation-view.ts";
import type { ConversationView } from "./conversation-view.ts";
import DebugPanel from "./DebugPanel.tsx";
import { cachedDebugToken, clearDebugToken, unlockDebug } from "./debug-api.ts";

type Tab = "chat" | "gallery" | "drafts" | "inbox";
type Screen = "title" | "game";

const TABS: { id: Tab; label: string }[] = [
  { id: "chat", label: "对话" },
  { id: "gallery", label: "图鉴" },
  { id: "drafts", label: "审核" },
  { id: "inbox", label: "微信" },
];

/** 只存"上次进了哪个房间 / 选了哪个开局"，不存任何世界状态（权威状态永远在服务端） */
const ROOM_KEY = "ecust.galgame.lastRoomId";
const scenarioKey = (roomId: string) => `ecust.galgame.scenario.${roomId}`;

let lineId = 0;

interface EarlierState {
  before: string | number | null;
  hasEarlier: boolean;
  loading: boolean;
}

const NO_EARLIER: EarlierState = { before: null, hasEarlier: false, loading: false };

export default function App() {
  const { user, authReady, authStatus, notice, onAuthed, enterVisitor, logout: authLogout, expireSession } = useAuth();
  const [screen, setScreen] = useState<Screen>("title");
  const [tab, setTab] = useState<Tab>("chat");
  /** 调试面板：首页快捷键 + 口令解锁，平时完全隐藏 */
  const [debugPrompt, setDebugPrompt] = useState(false);
  const [debugToken, setDebugToken] = useState<string>(() => cachedDebugToken());
  const [debugPass, setDebugPass] = useState("");
  const [debugErr, setDebugErr] = useState("");
  const [roomId, setRoomId] = useState<string>("");
  /** 每次渲染同步：enterRoom 是 useCallback，异步流程里要判断「当前画面属于哪个房间」 */
  const roomIdRef = useRef("");
  roomIdRef.current = roomId;
  /** 当前房间的玩家角色 id：由服务端签发（建房返回值 / 房间成员表），不在前端猜 */
  const [actorId, setActorId] = useState<string>("");
  const [savedRoomId, setSavedRoomId] = useState<string>("");
  const [scenario, setScenario] = useState<Scenario | null>(null);
  /** 开局剧本是内容数据（content/scenarios/openings.json）：服务端拉不到就降级为"无预设开局" */
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [scenariosLoading, setScenariosLoading] = useState(true);
  const [entering, setEntering] = useState(false);
  const [state, setState] = useState<WorldState | null>(null);
  const [view, setView] = useState<ViewPatch>({});
  const [lines, setLines] = useState<Line[]>([]);
  /**
   * v2 群聊会话（issue #85）。默认 v1：进房探测 /conversation 成功才切 v2。
   * v2 事件行单独存在 convLines，渲染时接在 v1 历史之后——老流程一行不改。
   */
  const [convMode, setConvMode] = useState<"v1" | "v2">("v1");
  /** resetRoomUi 会把 convMode 置 v1；同房间重进房要恢复已探测的值（PR #126 P2） */
  const convModeRef = useRef<"v1" | "v2">("v1");
  convModeRef.current = convMode;
  const [convLines, setConvLines] = useState<Line[]>([]);
  /** v2 说话类型清单（GET /conversation/modes）；空数组 = 老流程或取清单失败 */
  const [v2Modes, setV2Modes] = useState<UtteranceModeInfo[]>([]);
  const convView = useRef<ConversationView>(initialConversationView());
  const [waitingInterjection, setWaitingInterjection] = useState(false);
  const listenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 渲染 v2 行时取名字用；每次渲染同步，避免 SSE 回调闭包读到旧 state */
  const stateRef = useRef<WorldState | null>(null);
  stateRef.current = state;
  const [input, setInput] = useState("");
  /** 草稿：enterRoom 在 reset 前捕获、成功后恢复（PR #126 P2），异步流程里读最新值 */
  const inputRef = useRef("");
  inputRef.current = input;
  const [busy, setBusy] = useState(false);
  /** PR-3 前台恢复接线实例（effect 中创建）；enterRoom 成功时用它回写上次同步时刻 */
  const resyncRef = useRef<SessionResync | null>(null);
  /** v2 回合的乐观玩家行：点发送到 committed 之间先浅色显示，引擎把本人 delivery 投回来就清掉 */
  const [pendingLines, setPendingLines] = useState<{ kind: LineKind; text: string }[]>([]);
  const [err, setErr] = useState<string>("");
  /** 本次回合失败是否值得重试：由 turn.error/retryable 决定（issue #21-3） */
  const [errRetryable, setErrRetryable] = useState(false);
  /** 流结束但没有 commit/error：重试前必须先向服务端核对（不盲目重发） */
  const [unconfirmed, setUnconfirmed] = useState<{ clientTurnId: string } | null>(null);
  /**
   * #87：/events 回放降级提示（actorId 传错 → 不渲染私信）；空字符串 = 不显示。
   * PR-3：前台恢复失败也复用这条提示位——失败同样计入一次同步（session-wiring 在发起前
   * 就刷新了同步时刻），但不会 reset，所以旧画面、草稿与可重试状态都保留。
   */
  const [eventsNotice, setEventsNotice] = useState<string>("");
  /** 最近一次玩家行动：重试时原样再发，不重复打印玩家行 */
  const lastTurn = useRef<{ text: string; target: { id: string; name: string } | null; utterance?: UtteranceDraft } | null>(null);
  /** 断流前已收到的叙事/facts：核对到 committed 后只补历史里的差集，避免重复刷屏 */
  const pendingTurn = useRef<{ clientTurnId: string; narrative: string; facts: string[] } | null>(null);
  /** 全屏地图层：点对话页左上角的小地图打开 */
  const [mapOpen, setMapOpen] = useState(false);
const [earlier, setEarlier] = useState<EarlierState>(NO_EARLIER);
  const { savesState, refreshSaves } = useSaves(user?.userId ?? null);
  /** 状态版本号：每次刷新权威状态 +1，派生视图（图鉴）据此重新拉取 */
  const [stateRev, setStateRev] = useState(0);
  const [sfx, setSfx] = useState(soundOn);
  /** 身份来自服务端会话（HttpOnly Cookie）；房间指针按 userId 分开，避免同一浏览器切账号串档 */
  const roomKey = user ? `${ROOM_KEY}:${user.userId}` : "";
  const turnSeq = useRef(0);
  /** 身份+房间版本：切换后旧在途请求/SSE 一律作废（abort + 版本号核对） */
  const scopeRef = useRef(new RequestScope());
  /**
   * 上一回合 facts 的指纹。连续同质动作会给出完全一样的提示行，
   * 重复打印只会让对话流看起来在原地打转——完全相同就跳过。
   */
  const lastFacts = useRef<string>("");
  // 打字机：文本逐字打出。实例只建一次；onTick 触发重绘。
  const [, setTick] = useState(0);
  const twRef = useRef<Typewriter | null>(null);
  const getTw = () => {
    if (!twRef.current) {
      twRef.current = new Typewriter(
        () => ++lineId,
        (line) => setLines((prev) => [...prev, line]),
        () => setTick((v) => v + 1),
      );
    }
    return twRef.current;
  };

  // 全局按键音效（Web Audio 合成，零依赖）；开关由本地状态 + localStorage 记忆
  useEffect(() => installClickSound(), []);

  /** 调试面板：首页按 D 键打开口令框（普通玩家不会碰，避免误触） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (screen === "title" && (e.key === "d" || e.key === "D") && !debugToken) {
        setDebugPrompt(true);
      }
      if (e.key === "Escape") {
        setDebugPrompt(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, debugToken]);

  const submitDebugPass = useCallback(async () => {
    setDebugErr("");
    try {
      const token = await unlockDebug(debugPass);
      if (!token) {
        setDebugErr("口令错误");
        return;
      }
      setDebugToken(token);
      setDebugPrompt(false);
      setDebugPass("");
    } catch (e) {
      setDebugErr(e instanceof Error ? e.message : String(e));
    }
  }, [debugPass]);

  const push = useCallback((kind: LineKind, text: string) => {
    // 叙事类文本走打字机；玩家的输入和系统提示直接出现（它们不是"剧情"）
    if (kind === "narrative") {
      getTw().enqueue([{ kind, text }]);
      return;
    }
    setLines((prev) => [...prev, { id: ++lineId, kind, text }]);
  }, []);

  // ---- v2 会话视图辅助：渲染、插话等待态定时器（纯决策在 conversation-view.ts） ----
  const renderConv = useCallback((view: ConversationView, forActor: string) => {
    setConvLines(linesFromView(view, {
      selfActorId: forActor,
      nameOf: (id) => stateRef.current?.entities[id]?.name ?? id,
    }));
  }, []);

  const disarmListenTimer = useCallback(() => {
    if (listenTimer.current !== null) {
      clearTimeout(listenTimer.current);
      listenTimer.current = null;
    }
    setWaitingInterjection(false);
  }, []);

  const armListenTimer = useCallback((forActor: string) => {
    disarmListenTimer();
    setWaitingInterjection(true);
    listenTimer.current = setTimeout(() => {
      listenTimer.current = null;
      // 服务端 listenTimeoutMs(30s) 到期自动恢复 speaking：期间没来 phase 事件时前端也清掉
      const view = convView.current;
      if (isListeningExpired(view, Date.now())) {
        convView.current = reduceConversationView(view, {
          type: "conversation.phase",
          sessionId: "",
          phase: "speaking",
        }, { selfActorId: forActor, now: Date.now(), lineId: () => ++lineId });
        renderConv(convView.current, forActor);
      }
      setWaitingInterjection(false);
    }, DEFAULT_LISTEN_TIMEOUT_MS);
  }, [disarmListenTimer, renderConv]);

  // 切账号/卸载时别把插话定时器带到下一局
  useEffect(() => () => {
    if (listenTimer.current !== null) clearTimeout(listenTimer.current);
  }, []);

  /** 统一失败出口：401 一律回登录页（多标签页改密/被吊销），其余给人话 */
  const fail = useCallback(
    (e: unknown): string => {
      if (isUnauthorized(e)) {
        expireSession();
        return "登录已失效，请重新登录";
      }
      return httpFailMessage(e);
    },
    [expireSession],
  );

  /** 切账号/切房间：清掉上一局的全部画面状态（权威数据不缓存，这里只清 UI） */
  const resetRoomUi = useCallback(() => {
    getTw().reset();
    lastFacts.current = "";
    lastTurn.current = null;
    disarmListenTimer();
    setConvMode("v1");
    setConvLines([]);
    setV2Modes([]);
    convView.current = initialConversationView();
    setView({});
    setLines([]);
    setInput("");
    setBusy(false);
    setErr("");
    setErrRetryable(false);
    setEventsNotice("");
    setUnconfirmed(null);
    setEarlier(NO_EARLIER);
    setMapOpen(false);
    setState(null);
    setRoomId("");
    setActorId("");
  }, [disarmListenTimer]);

  // 会话失效/退出：中止在途请求并清局内状态，绝不渲染坏掉的游戏画面
  useEffect(() => {
    if (user) return;
    scopeRef.current.renew();
    resetRoomUi();
    setScreen("title");
  }, [user, resetRoomUi]);

  // 存档列表的 401 同样触发会话失效（per-request 处理，无需跨标签广播）
  useEffect(() => {
    if (savesState.status === "unauthorized") expireSession();
  }, [savesState.status, expireSession]);

  // 面板级请求（图鉴/地图等走 request()）的 401 也统一回登录页
  useEffect(() => {
    onUnauthorized(expireSession);
    return () => onUnauthorized(null);
  }, [expireSession]);

  // 每个账号自己的"上次房间"指针：同一浏览器切账号不会串到别人的房间
  useEffect(() => {
    if (!roomKey) {
      setSavedRoomId("");
      return;
    }
    try {
      setSavedRoomId(localStorage.getItem(roomKey) ?? "");
    } catch {
      setSavedRoomId("");
    }
  }, [roomKey]);

  // 开局剧本随内容数据走：失败不是致命错误，标题页会提示"无预设开局"并允许直接开始
  useEffect(() => {
    let alive = true;
    fetchScenarios()
      .then((list) => {
        if (alive) setScenarios(list);
      })
      .catch(() => {
        if (alive) setScenarios([]);
      })
      .finally(() => {
        if (alive) setScenariosLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 进入一个已存在的房间：**先把数据拉全，成功后才 reset 并切换 UI**。
   * PR #126 P1-2：旧实现第一行 resetRoomUi() 会清 state/lines/input，resumed 拉取失败时
   * 画面被清空、草稿丢失；现在失败直接抛给调用方（前台恢复走 onNotice），旧画面、草稿与
   * 可重试状态都保持原样。首次进房/普通换房同样走这条路径，只是没有旧画面可保。
   * 「reset 必须在两次 fetch 之后」由 room-enter.ts 的 loadRoomThenReset 保证并被测试钉死。
   */
  const enterRoom = useCallback(
    async (id: string, opts: { resumed?: boolean; scenarioId?: string; actorId?: string } = {}) => {
      const token = scopeRef.current.renew();
      const current = () => scopeRef.current.isCurrent(token.version);
      // resumed 期间禁止新回合（PR #126 复审 P2）：前台恢复会先拉数据后 reset，若这段窗口
      // 里允许玩家发回合，新回合可能被返回的旧快照/历史覆盖，或 resetRoomUi 把 busy 清零。
      // 接线的前置条件保证进入时 busy=false，失败/作废时在 finally 恢复。
      const resumedBusy = opts.resumed === true;
      if (resumedBusy) setBusy(true);
      try {
        // 续玩时读历史失败则留在标题页/旧画面，保留存档与当前状态供玩家重试。
        const fetchHistoryOrFallback = async (): Promise<HistoryPage> => {
          try {
            return await fetchHistory(id);
          } catch (e) {
            if (!current()) return { history: [], lastCommittedSeq: 0, hasEarlier: false };
            if (isUnauthorized(e)) throw e;
            if (opts.resumed) throw new Error("对话历史暂不可用，请稍后重试", { cause: e });
            return { history: [], lastCommittedSeq: 0, hasEarlier: false };
          }
        };
        const loaded = await loadRoomThenReset<WorldState, HistoryPage, {
          snapshot: WorldState;
          page: HistoryPage;
          sc: Scenario | null;
          resolvedActorId: string;
          keepDraft: string;
          keepConvMode: "v1" | "v2";
        }>({
          fetchState: () => fetchState(id),
          fetchHistory: fetchHistoryOrFallback,
          isCurrent: current,
          // capture 在 reset 之前执行：数据已齐、请求仍有效，才解析 actor/剧本并读取要跨
          // 重进房保留的本地状态（草稿/convMode）。reset 之后这些旧 state 就没了。
          capture: (snapshot, page) => {
            // actorId 的优先级：调用方（建房/存档）→ 房间成员表 → 旧房间兼容值。
            const memberActorId = snapshot.room.members.find((m) => m.role === "player")?.actorId;
            const candidates = [opts.actorId, memberActorId].filter((v): v is string => typeof v === "string" && v.length > 0);
            const resolvedActorId = candidates.find((v) => snapshot.entities[v]) ?? candidates[0] ?? LEGACY_ACTOR_ID;
            const fallback = scenarios[0] ?? null;
            let sc: Scenario | null = fallback;
            try {
              const stored = localStorage.getItem(scenarioKey(id)) ?? "";
              const wanted = opts.scenarioId ?? stored;
              sc = scenarios.find((s) => s.id === wanted) ?? fallback;
              if (sc) localStorage.setItem(scenarioKey(id), sc.id);
              if (roomKey) localStorage.setItem(roomKey, id);
              setSavedRoomId(id);
            } catch {
              // 隐私模式读不了/写不了本地记录：用调用方给的或默认开局，不影响本局
              sc = opts.scenarioId ? scenarios.find((s) => s.id === opts.scenarioId) ?? fallback : fallback;
            }
            // 同房间重进房才保留草稿/convMode；换房/新开局清空，草稿只属于写它的那个房间。
            const sameRoom = opts.resumed === true && id === roomIdRef.current;
            return {
              snapshot,
              page,
              sc,
              resolvedActorId,
              keepDraft: sameRoom ? inputRef.current : "",
              keepConvMode: sameRoom ? convModeRef.current : "v1",
            };
          },
          reset: resetRoomUi,
          restore: (entry) => {
            if (entry.keepDraft) setInput(entry.keepDraft);
            if (entry.keepConvMode === "v2") setConvMode("v2");
            const restored = restoreConversation(entry.page.history, entry.sc, opts.resumed === true, () => ++lineId);
            if (restored.lines.length > 0) {
              setLines(restored.lines);
            } else {
              // 开场 = 对话流的第一屏：身份 → 正文。没有预设剧本时只留一行提示，不编造内容。
              setLines([]);
              getTw().enqueue(restored.opening);
            }
            setEarlier({ before: entry.page.earlierCursor ?? earlierCursor(entry.page.history), hasEarlier: entry.page.hasEarlier, loading: false });
            setScenario(entry.sc);
            setState(entry.snapshot);
            setActorId(entry.resolvedActorId);
            setRoomId(id);
            setTab("chat");
            setScreen("game");
          },
        });
        if (!loaded) return;
        // 成功进房 = 已同步（复审 P2）：否则 lastSyncAt 停在 0，刚进房就切后台 6s 回来
        // 会被判成「很久没同步」而立即全量重拉。
        resyncRef.current?.markSynced();
        // v2 服务端（issue #89）探测：探不到 /conversation 就保持 v1 /turns，老流程零回归。
        // 探测放在 UI 呈现之后，不阻塞进房；失败/切房都会由 current() 拦掉。
        void detectConversation(id, token.signal).then((v2) => {
          if (!current()) return;
          setConvMode(v2 ? "v2" : "v1");
          if (v2) void fetchUtteranceModes(id, token.signal).then((modes) => { if (current()) setV2Modes(modes); });
        });

        // #87：历史事件回放不阻塞进房。带本人 actorId 请求；若被 403 判为传错，
        // fetchRoomEvents 会无 actorId 重拉一次，只关私信并把提示带回来（不判死事件流）。
        void fetchRoomEvents(id, { actorId: loaded.resolvedActorId })
          .then((outcome) => {
            if (current()) setEventsNotice(outcome.notice ?? "");
          })
          .catch(() => {
            // 纯函数决策不抛；这里只兜意外，绝不让一次回放失败影响进房
          });
      } finally {
        if (resumedBusy) setBusy(false);
      }
    },
    [roomKey, scenarios, resetRoomUi],
  );

  /**
   * PR-3 客户端轻唤醒：合盖/切后台/断网再回来时 SSE 可能已经断了，画面停在旧状态。
   * 服务端没有 plot.ping 发射点，所以只信「回到前台 / 网络恢复」这类本地信号。
   * 接线（事件注册、离开时长、节流、防重入、失败提示）全部在 session-wiring.ts，
   * 用 fake 事件源可在 node 里测；这里只注入真实 DOM 与最新 React 状态。
   *
   * 实例只建一次，deps 用 ref 读最新值：若把 busy/input 放进依赖，每次按键都会重建
   * 实例，隐藏起点与同步时刻随之丢失。
   */
  const resyncLive = useRef({ screen, roomId, busy, enterRoom, fail });
  resyncLive.current = { screen, roomId, busy, enterRoom, fail };
  useEffect(() => {
    const resync = createSessionResync({
      now: () => Date.now(),
      on: (target, type, handler) => {
        const el: EventTarget = target === "document" ? document : window;
        el.addEventListener(type, handler);
        return () => el.removeEventListener(type, handler);
      },
      isVisible: () => document.visibilityState === "visible",
      isOnline: () => navigator.onLine,
      screen: () => resyncLive.current.screen,
      roomId: () => resyncLive.current.roomId,
      busy: () => resyncLive.current.busy,
      enterRoom: (id) => resyncLive.current.enterRoom(id, { resumed: true }),
      // 失败也计一次同步（接线在发起前已刷新同步时刻）；提示复用 eventsNotice 降级提示位。
      // enterRoom 先拉数据后 reset，失败时旧画面、草稿与可重试状态原样保留。
      onNotice: (e) => setEventsNotice(resyncLive.current.fail(e)),
    });
    // 实例放 ref：enterRoom 成功后要 markSynced；直接进 effect 依赖会形成循环重建。
    resyncRef.current = resync;
    return () => {
      resync.dispose();
      if (resyncRef.current === resync) resyncRef.current = null;
    };
  }, []);

  const startNew = useCallback(
    async (scenarioId: string) => {
      setEntering(true);
      setErr("");
      try {
        const room = await createSoloRoom(scenarioId);
        await enterRoom(room.roomId, { scenarioId, actorId: room.actorId });
      } catch (e) {
        setErr(`开局失败：${fail(e)}`);
      } finally {
        setEntering(false);
      }
    },
    [enterRoom, fail],
  );

  const resumeLast = useCallback(async () => {
    if (!savedRoomId) return;
    setEntering(true);
    setErr("");
    try {
      const save = savesState.saves.find((s) => s.roomId === savedRoomId);
      await enterRoom(savedRoomId, { resumed: true, ...(save?.actorId ? { actorId: save.actorId } : {}) });
    } catch (e) {
      // 只有"房间真的没了"才清记录；网络错误保留，避免用户以为存档丢了
      if (e instanceof GameError && e.code === "E_ROOM_NOT_FOUND") {
        try {
          if (roomKey) localStorage.removeItem(roomKey);
        } catch {
          // 忽略
        }
        setSavedRoomId("");
        setErr(`上次的房间已不可用（${fail(e)}），请新建一局`);
      } else {
        setErr(`连接失败（${fail(e)}）；已保留上次记录，可稍后重试`);
      }
    } finally {
      setEntering(false);
    }
  }, [enterRoom, roomKey, savedRoomId, savesState.saves, fail]);

  /** 从"我的存档"进房：走与继续上次相同的恢复路径（有历史就重放） */
  const openSave = useCallback(
    async (save: SaveEntry) => {
      setEntering(true);
      setErr("");
      try {
        await enterRoom(save.roomId, { resumed: true, scenarioId: save.scenarioId, ...(save.actorId ? { actorId: save.actorId } : {}) });
      } catch (e) {
        if (e instanceof GameError && e.code === "E_ROOM_NOT_FOUND") {
          setErr(`存档对应的房间已不可用（${fail(e)}），已从列表移除`);
          void refreshSaves();
        } else {
          setErr(`读取存档失败：${fail(e)}`);
        }
      } finally {
        setEntering(false);
      }
    },
    [enterRoom, refreshSaves, fail],
  );

  const removeSave = useCallback(
    async (save: SaveEntry) => {
      try {
        const ok = await deleteSave(save.roomId);
        if (!ok) setErr("移除失败（索引未更新），请稍后重试");
      } catch (e) {
        setErr(`移除失败：${fail(e)}`);
      }
      await refreshSaves();
    },
    [refreshSaves, fail],
  );

  /** 地图操作后重拉 /state；只刷新服务端权威数据，不在前端推演 */
  const refreshState = useCallback(() => {
    if (!roomId) return;
const token = scopeRef.current.current();
    void fetchState(roomId)
      .then((s) => {
        if (!scopeRef.current.isCurrent(token.version)) return;
        setState(s);
        // 位置视图里的 actor 名字是回合当时下发的（可能还是占位名）：认识/改名后用权威状态覆盖，
        // 走动界面的 NPC 标注才能立刻跟着改，不必等下一回合。
        setView((old) => {
          const pos = old.position;
          if (!pos) return old;
          const actors = pos.actors.map((a) => ({ ...a, name: s.entities[a.actorId]?.name ?? a.name }));
          return { ...old, position: { ...pos, actors } };
        });
        // 图鉴是服务端派生视图：状态一变就让它重新拉，认识/读数不需要玩家手动切换 tab 才同步
        setStateRev((v) => v + 1);
      })
      .catch((e) => {
        if (isUnauthorized(e)) expireSession();
      });
  }, [roomId, expireSession]);

  /**
   * 走到某个点位旁：静默同步世界状态（不往对话流刷字）。
   * travel 返回权威地图，必须拿它推进 view.position，否则 HUD/小地图停在旧地点。
   * 返回是否真的到达：点「前往 TA 所在地」据此决定选中 NPC 还是报错。
   */
  const enterScene = useCallback(
    async (locId: string): Promise<{ ok: boolean; message?: string }> => {
      if (!roomId || !actorId) return { ok: false, message: "还没进入房间" };
      const token = scopeRef.current.current();
      try {
        const res = await travel(roomId, actorId, locId);
        if (!scopeRef.current.isCurrent(token.version)) return { ok: false };
        setView((v) => ({
          ...v,
          position: {
            locId: res.map.player.locId,
            name: res.scene.name,
            actors: v.position?.actors ?? [],
            exits: v.position?.exits ?? [],
          },
        }));
        refreshState();
        return { ok: true };
      } catch (e) {
        // 已经在原地 / 点位未建成 / 不可达：交给调用方决定要不要提示
        return { ok: false, message: fail(e) };
      }
    },
    [actorId, roomId, refreshState, fail],
  );

  /**
   * v2 群聊回合（ConversationHostV2 的 SSE）。事件先过纯 reducer 算出渲染行，
   * 只有 conversation.committed 才把服务端 state 写回权威状态；错误按 retryable 给重试入口。
   * 与 v1 完全并行：convMode 不是 v2 时根本不会走到这里。
   */
  const dispatchConversationTurn = useCallback(
    async (raw: string, targetNpc: { id: string; name: string } | null, echo: boolean, reuseId?: string, utterance?: UtteranceDraft) => {
      const base = raw.trim();
      // contentless 类型（如 signal）正文可空，只靠 action 表达；其余类型必须非空
      if ((!base && !utterance) || busy || !roomId || !actorId) return;
      const token = scopeRef.current.current();
      const current = () => scopeRef.current.isCurrent(token.version);
      // 没有完整 utterance 时退回 #85 别名端点：它只收自然语言 input，目标靠 targetNpcId 传，
      // 所以这里保留「对<展示名>说：」的兜底拼法（服务端会先换回真名再喂模型）。
      const text = targetNpc ? `对${targetNpc.name}说：${base}` : base;
      lastTurn.current = { text: base, target: targetNpc, ...(utterance ? { utterance } : {}) };
      // 乐观行：玩家自己的 utterance 要等引擎投回（SSE 非流式），先本地显示浅色的。
      // 新一轮只在「本次派发之后追加的行」里查重（同一句两轮都发仍要显示）；
      // 重试复用同一 clientTurnId，扫全部已渲染行——真行已在就不挂，避免短暂重复。
      setPendingLines(
        pendingLinesFor(
          convView.current,
          actorId,
          utterance ? (utterance.content ?? "") : text,
          utterance?.action,
          { sinceLineIndex: reuseId ? 0 : convView.current.lines.length },
        ),
      );
      const tw = getTw();
      if (tw.typing) tw.skip();
      setBusy(true);
      setErr("");
      setErrRetryable(false);
      setUnconfirmed(null);
      if (echo) {
        setInput("");
        // 玩家行不回显：引擎本就会把玩家自己的 utterance 作为 Delivery 投回给本人
        // （deliver() 的 isTarget 含 speaker），由 SSE 的 conversation.utterance 渲染。
        // 再本地回显同一句就会出现两行（且旧的「对<展示名>说：」前缀会把外貌占位名写进对话）。
      }
      const clientTurnId = reuseId ?? `${Date.now()}_${++turnSeq.current}`;

      const apply = (ev: ConversationEvent) => {
        if (!current()) return;
        if (ev.type === "conversation.committed") {
          setState(ev.state);
          setStateRev((v) => v + 1);
        }
        // 引擎把玩家自己的 utterance 作为 delivery 投回来：真行已到，清掉乐观行
        if (ev.type === "conversation.utterance" && ev.delivery.to === actorId && ev.delivery.speaker === actorId) {
          setPendingLines([]);
        }
        convView.current = reduceConversationView(convView.current, ev, {
          selfActorId: actorId,
          now: Date.now(),
          lineId: () => ++lineId,
        });
        renderConv(convView.current, actorId);
        if (ev.type === "conversation.phase") {
          if (ev.phase === "listening") armListenTimer(actorId);
          else disarmListenTimer();
        }
        if (ev.type === "conversation.error") {
          setErr(ev.message || ev.code);
          setErrRetryable(ev.retryable === true);
        }
      };

      const handlers = {
        onEvent: apply,
        onError: (code: string, message: string, retryable?: boolean) => {
          if (!current()) return;
          setPendingLines([]);
          setErr(message || code);
          setErrRetryable(retryable === true);
        },
        onUnconfirmed: () => {
          if (!current()) return;
          setPendingLines([]);
          setUnconfirmed({ clientTurnId });
          setErr("会话结果未确认，重试会以同一 ID 重发（服务端按 ID 去重）。");
          setErrRetryable(true);
        },
      };
      try {
        if (utterance) {
          // demo：完整 utterance（mode/target/content/action）走规范端点
          await runConversationUtterance(roomId, actorId, utterance, clientTurnId, handlers, token.signal);
        } else {
          await runConversationTurn(
            roomId,
            actorId,
            text,
            clientTurnId,
            handlers,
            token.signal,
            targetNpc?.id,
          );
        }
      } catch (e) {
        if (!current() || token.signal.aborted) return;
        if (isUnauthorized(e)) {
          expireSession();
          return;
        }
        setUnconfirmed({ clientTurnId });
        setErr(`${httpFailMessage(e)}：本回合结果未确认，重试会以同一 ID 重发。`);
        setErrRetryable(true);
      } finally {
        setPendingLines([]);
        if (current()) {
          // 流结束时仍在 listening：保留等待态，让 30s 定时器按服务端节奏清掉
          if (convView.current.phase !== "listening") disarmListenTimer();
          setBusy(false);
          refreshState();
          void refreshSaves();
        }
      }
    },
    [actorId, armListenTimer, busy, disarmListenTimer, expireSession, refreshSaves, refreshState, renderConv, roomId, v2Modes],
  );

  /** v2 demo：从 ChatPanel 的选择器提交一条完整 utterance（@谁 + 方式 + 说话/行动） */
  const sendV2Utterance = useCallback(
    (draft: UtteranceDraft) => {
      if (convMode !== "v2") return;
      const targetNpc = draft.target
        ? { id: draft.target, name: stateRef.current?.entities[draft.target]?.name ?? draft.target }
        : null;
      const raw = draft.content ?? draft.action ?? "";
      void dispatchConversationTurn(raw, targetNpc, true, undefined, draft);
    },
    [convMode, dispatchConversationTurn],
  );

  /**
   * 发一回合。`echo=false` 用于「重试」：不重复打印玩家行、不清输入框。
   * `reuseId` 用于未确认回合的重发：服务端按 clientTurnId 去重，不会重复执行。
   */
  const dispatchTurn = useCallback(
    async (raw: string, targetNpc: { id: string; name: string } | null, echo: boolean, reuseId?: string) => {
      const base = raw.trim();
      if (!base || busy || !roomId || !actorId) return;
      const token = scopeRef.current.current();
      const current = () => scopeRef.current.isCurrent(token.version);
      // 探测到 v2 端点才走群聊 SSE；否则一切照旧（v1 /turns 完全不动）
      if (convMode === "v2") {
        await dispatchConversationTurn(raw, targetNpc, echo, reuseId);
        return;
      }
      // 选了对话对象就把目标写进行动语义：契约里 TurnRequest 没有 target 字段
      const text = targetNpc ? `对${targetNpc.name}说：${base}` : base;
      lastTurn.current = { text: base, target: targetNpc };
      const tw = getTw();
      if (tw.typing) tw.skip();
      setBusy(true);
      setErr("");
      setErrRetryable(false);
      setUnconfirmed(null);
      if (echo) {
        setInput("");
        push("player", text);
      }
      const clientTurnId = reuseId ?? `${Date.now()}_${++turnSeq.current}`;
      tw.setTurnEnded(false);
      // 记录断流前已经收到的内容：核对到 committed 后只补历史差集，避免重复显示
      const received: { clientTurnId: string; narrative: string; facts: string[] } = { clientTurnId, narrative: "", facts: [] };
      pendingTurn.current = received;
      const baseHandlers = makeTurnHandlers({ current, tw, lastFacts, setState, setView, setErr, setErrRetryable, setUnconfirmed, expireSession });
      const handlers = {
        ...baseHandlers,
        onDelta: (field: "narrative" | "dialogue", chunk: string) => {
          if (field === "narrative") received.narrative = received.narrative ? `${received.narrative}\n${chunk}` : chunk;
          baseHandlers.onDelta?.(field, chunk);
        },
        onFacts: (facts: string[]) => {
          received.facts.push(...facts);
          baseHandlers.onFacts?.(facts);
        },
        onCommit: (seq: number) => {
          pendingTurn.current = null;
          baseHandlers.onCommit?.(seq);
        },
      };
      try {
await runTurn(
          roomId,
          actorId,
          text,
          clientTurnId,
          handlers,
          token.signal,
          targetNpc?.id,
        );
      } catch (e) {
        if (!current() || token.signal.aborted) return;
        if (isUnauthorized(e)) {
          expireSession();
          return;
        }
        // POST 可能已到达服务端：按"未确认"处理，重试前先核对，不盲目重发
        setUnconfirmed({ clientTurnId });
        setErr(`${httpFailMessage(e)}：本回合结果未确认，重试会先向服务端核对。`);
        setErrRetryable(true);
      } finally {
        if (current()) {
          tw.setTurnEnded(true);
          setBusy(false);
          refreshState();
          // 回合提交后存档游标由服务端推进；这里刷新列表，回标题时时间戳是新的
          void refreshSaves();
        }
      }
    },
    [actorId, busy, convMode, dispatchConversationTurn, push, roomId, refreshSaves, refreshState, expireSession],
  );
  /** 发新回合（快捷建议把 `raw` 传进来就等于说出这句话，不必先填输入框） */
  const send = useCallback(
    (raw?: string, targetNpc?: { id: string; name: string } | null) => {
      void dispatchTurn(raw ?? input, targetNpc ?? null, true);
    },
    [dispatchTurn, input],
  );

  /** 未确认回合：先核对服务端结果，committed 不重发；failed/未知 才用同一 id 重跑 */
  const reconcileThenRetry = useCallback(
    async (clientTurnId: string, last: { text: string; target: { id: string; name: string } | null }) => {
      const token = scopeRef.current.current();
      const current = () => scopeRef.current.isCurrent(token.version);
      setBusy(true);
      setErr("");
      try {
        const status = await fetchTurnStatus(roomId, clientTurnId);
        if (!current()) return;
        if (status.state === "committed") {
          const received = pendingTurn.current?.clientTurnId === clientTurnId
            ? pendingTurn.current
            : { narrative: "", facts: [] as string[] };
          pendingTurn.current = null;
          setUnconfirmed(null);
          setErrRetryable(false);
          // 世界序号可能被多个回合共用，按回合与角色补齐断流前未收到的内容。
          if (status.turnId) {
            const turnId = status.turnId;
            try {
              const page = await fetchHistory(roomId, { match: { turnId, actorId } });
              if (!current()) return;
              const line = page.history.find((h) => h.turnId === turnId && h.actorId === actorId);
              if (line) {
                const missing = missingTurnContent(line, received);
                if (missing.narrative) push("narrative", missing.narrative);
                for (const fact of missing.facts) push("fact", fact);
              } else {
                push("system", "该行动已提交，暂未找到可恢复的回合叙事。");
              }
            } catch (e) {
              if (!current()) return;
              if (isUnauthorized(e)) {
                fail(e);
                return;
              }
              push("system", "该行动已提交；补齐该回合叙事失败，可重新进入房间从历史查看。");
            }
          }
          push("system", `已核对：该行动已提交（seq ${status.committedSeq ?? "?"}），未重复执行。`);
          refreshState();
          return;
        }
        if (status.state === "running" || status.state === "reserved") {
          setErr("上一回合仍在服务端执行，请稍后再点重试核对。");
          setErrRetryable(true);
          return;
        }
        if (status.state === "unconfirmed") {
          // 服务端明确"结果待核对"：同 id 重发会被拒（E_PRECONDITION），保留提示等结案
          setErr("该行动结果仍待核对，请稍后再核对；确认前不会重复执行。");
          setErrRetryable(true);
          return;
        }
        // failed：服务端允许 failed 复用同一逻辑 ID 重试
        setUnconfirmed(null);
        await dispatchTurn(last.text, last.target, false, clientTurnId);
      } catch (e) {
        if (!current()) return;
        if (e instanceof HttpError && e.code === "E_REF_NOT_FOUND") {
          // 服务端没有这条记录（如重启丢 ledger）：重发安全
          setUnconfirmed(null);
          await dispatchTurn(last.text, last.target, false, clientTurnId);
          return;
        }
        setErr(`核对失败：${fail(e)}`);
        setErrRetryable(true);
      } finally {
        if (current()) setBusy(false);
      }
    },
    [roomId, actorId, dispatchTurn, push, refreshState, fail],
  );

  /** 重试上一回合：失败（尤其 E_LLM_FORMAT）时对话区出现按钮，不自动重试 */
  const retry = useCallback(() => {
    const last = lastTurn.current;
    if (!last) return;
    if (convMode === "v2") {
      // v2 按 clientTurnId 去重；未确认回合复用同一 ID，服务端已提交就直接回放结果
      void dispatchConversationTurn(last.text, last.target, false, unconfirmed?.clientTurnId, last.utterance);
      return;
    }
    // NPC 可能在回合之间换场景；重发前用当前状态再核一次在场，
    // 不在就禁用重试，绝不构造「对 X 说：…」绕过场景隔离。
    if (last.target) {
      const currentLocId = view.position?.locId ?? state?.room.scene.locId ?? "";
      const npcLocId = npcLocIdFromLinks(last.target.id, state?.links ?? []);
      const presentIds = state?.room.scene.presentIds ?? [];
      if (!targetStillInScene(last.target, currentLocId, npcLocId, presentIds)) {
        lastTurn.current = null;
        setErrRetryable(false);
        setErr(`${last.target.name} 已不在当前场景，上次失败的重试已失效。`);
        return;
      }
    }
    if (unconfirmed) {
      void reconcileThenRetry(unconfirmed.clientTurnId, last);
      return;
    }
    void dispatchTurn(last.text, last.target, false);
  }, [convMode, dispatchConversationTurn, dispatchTurn, reconcileThenRetry, unconfirmed, state, view.position?.locId]);

  /** 使用服务端页首游标加载更早的历史，前插到对话流顶部。 */
  const loadEarlier = useCallback(async () => {
    if (!roomId || earlier.loading || !earlier.hasEarlier || earlier.before === null) return;
    const token = scopeRef.current.current();
    const before = earlier.before;
    setEarlier((s) => ({ ...s, loading: true }));
    try {
      const page = await fetchHistory(roomId, { before });
      if (!scopeRef.current.isCurrent(token.version)) return;
      const older = historyToLines(page.history, () => ++lineId);
      setLines((prev) => [...older, ...prev]);
      setEarlier({ before: page.earlierCursor ?? earlierCursor(page.history), hasEarlier: page.hasEarlier, loading: false });
    } catch (e) {
      if (!scopeRef.current.isCurrent(token.version)) return;
      setEarlier((s) => ({ ...s, loading: false }));
      setErr(`加载更早历史失败：${fail(e)}`);
    }
  }, [roomId, earlier, fail]);

  /**
   * 换场景后旧的重试目标不再可信（issue #21 P2）：清 lastTurn 并收掉重试按钮。
   */
  const lastSceneRef = useRef<string>("");
  useEffect(() => {
    const locId = view.position?.locId ?? "";
    if (!locId) return;
    const prev = lastSceneRef.current;
    lastSceneRef.current = locId;
    if (!shouldDropRetryOnMove(prev, locId)) return;
    lastTurn.current = null;
    if (errRetryable) {
      setErrRetryable(false);
      setErr("已离开原来的场景，上次失败的重试已失效。");
    }
  }, [view.position?.locId, errRetryable]);

  /** 退出登录：先确认，再等服务端确认成功才清本地会话（失败保留并提示） */
  const logoutNow = useCallback(() => {
    if (!window.confirm("退出登录？")) return;
    void (async () => {
      const ok = await authLogout();
      if (!ok) {
        setErr("退出登录失败（网络异常）：服务端会话可能仍有效，请重试。");
        return;
      }
      scopeRef.current.renew();
      clearDebugToken();
      setDebugToken("");
      resetRoomUi();
      setScenario(null);
      setSavedRoomId("");
      setScreen("title");
    })();
  }, [authLogout, resetRoomUi]);

  if (!authReady) {
    return (
      <div className="auth-screen">
        <div className="auth-card auth-loading">正在检查登录状态…</div>
      </div>
    );
  }
  if (!user) {
    return <AuthScreen status={authStatus} notice={notice} onAuthed={onAuthed} onVisitor={enterVisitor} />;
  }

  if (screen === "title") {
    return (
      <>
        <TitleScreen
          scenarios={scenarios}
          scenariosLoading={scenariosLoading}
          onStart={(scenarioId) => void startNew(scenarioId)}
          onResume={savedRoomId ? () => void resumeLast() : null}
          savesState={savesState}
          onOpenSave={(save) => void openSave(save)}
          onDeleteSave={(save) => void removeSave(save)}
          savedRoomId={savedRoomId}
          busy={entering}
          err={err}
          username={user.nickname || user.username}
          onLogout={logoutNow}
        />
        {debugPrompt && (
          <div className="dbg-overlay" role="dialog" aria-label="调试口令">
            <div className="dbg-window dbg-unlock">
              <h2>调试模式</h2>
              <p className="panel-note">输入调试口令以解锁只读调试视图。</p>
              <input
                type="password"
                autoFocus
                value={debugPass}
                onChange={(e) => setDebugPass(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void submitDebugPass(); }}
                placeholder="调试口令"
              />
              {debugErr && <div className="err">{debugErr}</div>}
              <div className="dbg-header-actions">
                <button type="button" onClick={() => { setDebugPrompt(false); setDebugErr(""); }}>取消</button>
                <button type="button" onClick={() => void submitDebugPass()}>解锁</button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  const panels = view.panels ?? {};
  const pos = view.position;
  const typing = getTw().activeLine;
  /** 开场白打完了吗？建议按钮要等逐字动画收尾后再出现 */
  const sceneSettled = !getTw().typing;
  /** 已经进行到第几回合（玩家开口次数） */
  const playedTurns = lines.filter((l) => l.kind === "player").length;
  /** 下一步能干什么：开局给剧本建议，之后按当前场景推导（出口 + 在场的人） */
  const nextActions = playedTurns === 0 ? (scenario?.suggestions ?? []) : turnSuggestions(pos, playedTurns, actorId);

  return (
    <div className="app screen-in">
      <header className="topbar">
        <div className="brand">
          <h1>ECUST · AI 校园</h1>
          <span className="muted">{roomId ? `${scenario?.name ?? ""}${scenario ? " · " : ""}room ${roomId}` : "连接中…"}</span>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tab${tab === t.id ? " active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <button type="button" className="btn ghost auth-user" onClick={logoutNow} title="退出登录">
          {user.nickname || user.username} · 退出
        </button>
        <button
          type="button"
          className="btn ghost back-title"
          onClick={() => {
            // 回标题时清掉局内报错、放完正在打的字并停表，别把上一局的错误/定时器带到入口页
            getTw().skip();
            getTw().stop();
            setErr("");
            setScreen("title");
          }}
        >
          ← 标题
        </button>
        <button
          type="button"
          className={`btn ghost sfx-toggle${sfx ? "" : " off"}`}
          onClick={() => {
            const next = !sfx;
            setSoundOn(next);
            setSfx(next);
          }}
          title={sfx ? "点击静音" : "点击开启音效"}
        >
          {sfx ? "♪" : "静音"}
        </button>
        <div className="muted clock">
          {state ? `第 ${state.clock.day} 天 · ${phaseLabel(state.clock.phase)}` : ""}
        </div>
      </header>

      <div className="app-body">
        {eventsNotice && (
          <div className="err events-degrade-notice" role="status">
            {eventsNotice}
          </div>
        )}
        <div className="tab-pane" key={tab}>
        {tab === "gallery" &&
          (roomId ? <GalleryPanel roomId={roomId} version={stateRev} /> : <div className="panel-note">连接房间中…</div>)}

        {tab === "chat" && (
          <ChatPanel
            state={state}
            panels={panels}
            pos={pos}
            lines={convMode === "v2" ? [...lines, ...convLines] : lines}
            typing={typing}
            busy={busy}
            // 地图是全屏遮罩，不会卸载 ChatPanel：打开时数字键快选必须停用，否则会穿透真发回合（PR #127 P1）
            overlayOpen={mapOpen}
            err={err}
            input={input}
            onInput={setInput}
            onSend={(target) => void send(undefined, target)}
            // 每回合结束（字打完、且不在等回复）都给建议；等回复时先收起，免得发旧选项
            suggestions={!busy && sceneSettled ? nextActions : []}
            onPick={(text, target) => void send(text, target)}
            onRetry={retry}
            retryable={errRetryable}
            waitingForInterjection={convMode === "v2" && waitingInterjection}
            roomId={roomId}
            version={stateRev}
            onOpenMap={() => setMapOpen(true)}
            heroId={scenario?.id ?? ""}
            onEnterScene={enterScene}
            onSkipLog={() => getTw().skip()}
            hasEarlier={earlier.hasEarlier}
            loadingEarlier={earlier.loading}
            onLoadEarlier={() => void loadEarlier()}
            v2Modes={convMode === "v2" ? v2Modes : undefined}
            onSendUtterance={convMode === "v2" ? sendV2Utterance : undefined}
            pendingLines={pendingLines}
          />
        )}

        {tab === "drafts" &&
          (roomId ? (
            <DraftsPanel roomId={roomId} push={push} />
          ) : (
            <div className="panel-note">连接房间中…</div>
          ))}

        {tab === "inbox" &&
          (roomId ? (
            <InboxPanel roomId={roomId} actorId={actorId} state={state} />
          ) : (
            <div className="panel-note">连接房间中…</div>
          ))}
        </div>
      </div>

      {/* 地图不再是独立标签页：从对话页左上角的小地图展开，选完地点自动回到对话 */}
      {roomId && (
        <MapOverlay
          open={mapOpen}
          onClose={() => setMapOpen(false)}
          roomId={roomId}
          actorId={actorId}
          push={push}
          onRefreshState={refreshState}
          version={stateRev}
        />
      )}

      {/* 调试面板：仅在首页解锁过口令后挂载，平时完全不出现在 DOM 中 */}
      {debugToken && roomId && (
        <DebugPanel
          roomId={roomId}
          token={debugToken}
          onClose={() => { clearDebugToken(); setDebugToken(""); }}
          onExpired={() => { clearDebugToken(); setDebugToken(""); }}
        />
      )}
    </div>
  );
}
