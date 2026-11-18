import { useCallback, useEffect, useRef, useState } from "react";
import type { WorldState, ViewPatch } from "../../../packages/shared/src/contract/types.ts";
import { GameError, LEGACY_ACTOR_ID, createSoloRoom, deleteSave, fetchHistory, fetchSaves, fetchState, playerId, runTurn, travel } from "./api.ts";
import type { HistoryLine, SaveEntry } from "./api.ts";
import ChatPanel from "./ChatPanel.tsx";
import DraftsPanel from "./DraftsPanel.tsx";
import GalleryPanel from "./GalleryPanel.tsx";
import MapOverlay from "./MapOverlay.tsx";
import TitleScreen from "./TitleScreen.tsx";
import { fetchScenarios } from "./scenarios.ts";
import type { Scenario } from "./scenarios.ts";
import { turnSuggestions } from "./suggestions.ts";
import { installClickSound, setSoundOn, soundOn } from "./sfx.ts";
import { Typewriter } from "./typewriter.ts";
import type { TypeItem } from "./typewriter.ts";
import { explainTurnError, isRetryableTurnError, shouldDropRetryOnMove } from "./turn-error.ts";
import { npcLocIdFromLinks, targetStillInScene } from "./npc-presence.ts";
import { errorMessage, phaseLabel } from "./ui.ts";
import type { Line, LineKind } from "./ui.ts";

type Tab = "chat" | "gallery" | "drafts";
type Screen = "title" | "game";

const TABS: { id: Tab; label: string }[] = [
  { id: "chat", label: "对话" },
  { id: "gallery", label: "图鉴" },
  { id: "drafts", label: "审核" },
];

/** 只存"上次进了哪个房间 / 选了哪个开局"，不存任何世界状态（权威状态永远在服务端） */
const ROOM_KEY = "ecust.galgame.lastRoomId";
const scenarioKey = (roomId: string) => `ecust.galgame.scenario.${roomId}`;

let lineId = 0;

export default function App() {
  const [screen, setScreen] = useState<Screen>("title");
  const [tab, setTab] = useState<Tab>("chat");
  const [roomId, setRoomId] = useState<string>("");
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
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  /** 本次回合失败是否值得重试：由 turn.error/retryable 决定（issue #21-3） */
  const [errRetryable, setErrRetryable] = useState(false);
  /** 最近一次玩家行动：重试时原样再发（新的 clientTurnId），不重复打印玩家行 */
  const lastTurn = useRef<{ text: string; target: { id: string; name: string } | null } | null>(null);
  /** 全屏地图层：点对话页左上角的小地图打开 */
  const [mapOpen, setMapOpen] = useState(false);
  const [saves, setSaves] = useState<SaveEntry[]>([]);
  const [sfx, setSfx] = useState(soundOn);
  const turnSeq = useRef(0);
  /**
   * 上一回合 facts 的指纹。模块的 facts 是「世界动了」的提示，
   * 但连续做同质动作（比如两次「环顾四周」）会给出完全一样的三行，
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

  const push = useCallback((kind: LineKind, text: string) => {
    // 叙事类文本走打字机；玩家的输入和系统提示直接出现（它们不是"剧情"）
    if (kind === "narrative") {
      getTw().enqueue([{ kind, text }]);
      return;
    }
    setLines((prev) => [...prev, { id: ++lineId, kind, text }]);
  }, []);

  const refreshSaves = useCallback(async () => {
    try {
      setSaves(await fetchSaves());
    } catch {
      // 存档列表是锦上添花：服务器不可达 / 隐私模式没有本地身份时静默降级，不影响开局
      setSaves([]);
    }
  }, []);

  // 只读本地记录的房间号，用来决定"继续上次"是否出现
  useEffect(() => {
    try {
      setSavedRoomId(localStorage.getItem(ROOM_KEY) ?? "");
    } catch {
      setSavedRoomId("");
    }
  }, []);

  // 标题页就生成/读取本地身份（issue #7），并拉一次本人存档列表
  useEffect(() => {
    playerId();
    void refreshSaves();
  }, [refreshSaves]);

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
   * 进入一个已存在的房间：拉权威状态、记下房间号与开局，并把开场剧情铺进对话流。
   * 开场只由前端渲染（不在前端推演世界）；之后玩家输入与叙事接在它下面。
   */
  const enterRoom = useCallback(
    async (id: string, opts: { resumed?: boolean; scenarioId?: string; actorId?: string } = {}) => {
      const snapshot = await fetchState(id);
      // actorId 的优先级：调用方（建房/存档）→ 房间成员表 → 旧房间兼容值。
      // 服务端签发后客户端只消费，不再写死 plr_self。
      const memberActorId = snapshot.room.members.find((m) => m.role === "player")?.actorId;
      const candidates = [opts.actorId, memberActorId].filter((v): v is string => typeof v === "string" && v.length > 0);
      const resolvedActorId = candidates.find((v) => snapshot.entities[v]) ?? candidates[0] ?? LEGACY_ACTOR_ID;
      setActorId(resolvedActorId);
      const fallback = scenarios[0] ?? null;
      let sc: Scenario | null = fallback;
      try {
        const stored = localStorage.getItem(scenarioKey(id)) ?? "";
        const wanted = opts.scenarioId ?? stored;
        sc = scenarios.find((s) => s.id === wanted) ?? fallback;
        if (sc) localStorage.setItem(scenarioKey(id), sc.id);
        localStorage.setItem(ROOM_KEY, id);
        setSavedRoomId(id);
      } catch {
        // 隐私模式读不了/写不了本地记录：用调用方给的或默认开局，不影响本局
        sc = opts.scenarioId ? scenarios.find((s) => s.id === opts.scenarioId) ?? fallback : fallback;
      }

      // 历史 = 已提交回合的投影（issue #7）：读得到就直接铺出来，不重播序章、不发任何 turn；
      // 读不到（老房间/网络异常）就退回序章，不能因为"没有历史"进不了房间。
      const history: HistoryLine[] = await fetchHistory(id).catch(() => []);
      const tw = getTw();
      tw.reset();
      lastFacts.current = "";
      if (history.length > 0) {
        const replay: Line[] = [];
        for (const h of history) {
          if (h.input.trim()) replay.push({ id: ++lineId, kind: "player", text: h.input });
          if (h.narrative.trim()) replay.push({ id: ++lineId, kind: "narrative", text: h.narrative });
          for (const f of h.facts) if (f.trim()) replay.push({ id: ++lineId, kind: "fact", text: f });
        }
        setLines([
          {
            id: ++lineId,
            kind: "system",
            text: `继续上次${sc ? ` · ${sc.name} · ${sc.role}` : ""}（已恢复 ${history.length} 个回合）`,
          },
          ...replay,
        ]);
      } else {
        // 开场 = 对话流的第一屏：身份 → 正文。建议行动改由输入框上方的快捷按钮给出。
        // 没有预设剧本（服务端 /api/v1/scenarios 不可用）时只留一行提示，不编造内容。
        setLines([]);
        const opening: TypeItem[] = sc
          ? [
              { kind: "system", text: `序章 · ${sc.name} · ${sc.role}` },
              ...sc.opening.map((text) => ({ kind: "narrative" as LineKind, text })),
            ]
          : [{ kind: "system", text: "无预设开局（服务端 /api/v1/scenarios 不可用），直接开始吧。" }];
        tw.enqueue([
          ...opening,
          ...(opts.resumed
            ? [{ kind: "system" as LineKind, text: "（世界状态已从事件日志恢复；本局对话历史从这次继续开始记录）" }]
            : []),
        ]);
      }

      setScenario(sc);
      setState(snapshot);
      setRoomId(id);
      setTab("chat");
      setScreen("game");
    },
    [scenarios],
  );

  const startNew = useCallback(
    async (scenarioId: string) => {
      setEntering(true);
      setErr("");
      try {
        const room = await createSoloRoom(scenarioId);
        await enterRoom(room.roomId, { scenarioId, actorId: room.actorId });
      } catch (e) {
        setErr(`开局失败：${errorMessage(e)}`);
      } finally {
        setEntering(false);
      }
    },
    [enterRoom],
  );

  const resumeLast = useCallback(async () => {
    if (!savedRoomId) return;
    setEntering(true);
    setErr("");
    try {
      const save = saves.find((s) => s.roomId === savedRoomId);
      await enterRoom(savedRoomId, { resumed: true, ...(save?.actorId ? { actorId: save.actorId } : {}) });
    } catch (e) {
      // 只有"房间真的没了"才清记录；网络错误保留，避免用户以为存档丢了
      if (e instanceof GameError && e.code === "E_ROOM_NOT_FOUND") {
        try {
          localStorage.removeItem(ROOM_KEY);
        } catch {
          // 忽略
        }
        setSavedRoomId("");
        setErr(`上次的房间已不可用（${errorMessage(e)}），请新建一局`);
      } else {
        setErr(`连接失败（${errorMessage(e)}）；已保留上次记录，可稍后重试`);
      }
    } finally {
      setEntering(false);
    }
  }, [enterRoom, savedRoomId, saves]);

  /** 从"我的存档"进房：走与继续上次相同的恢复路径（有历史就重放） */
  const openSave = useCallback(
    async (save: SaveEntry) => {
      setEntering(true);
      setErr("");
      try {
        await enterRoom(save.roomId, { resumed: true, scenarioId: save.scenarioId, ...(save.actorId ? { actorId: save.actorId } : {}) });
      } catch (e) {
        if (e instanceof GameError && e.code === "E_ROOM_NOT_FOUND") {
          setErr(`存档对应的房间已不可用（${errorMessage(e)}），已从列表移除`);
          void refreshSaves();
        } else {
          setErr(`读取存档失败：${errorMessage(e)}`);
        }
      } finally {
        setEntering(false);
      }
    },
    [enterRoom, refreshSaves],
  );

  const removeSave = useCallback(
    async (save: SaveEntry) => {
      const ok = await deleteSave(save.roomId);
      if (!ok) setErr("删除存档失败（索引未更新），请稍后重试");
      await refreshSaves();
    },
    [refreshSaves],
  );

  /** 地图操作后重拉 /state；只刷新服务端权威数据，不在前端推演 */
  const refreshState = useCallback(() => {
    if (!roomId) return;
    void fetchState(roomId).then(setState).catch(() => undefined);
  }, [roomId]);

  /**
   * 走到某个点位旁：静默同步世界状态。
   * 不往对话流里 push 文字——走动是连续动作，每一步都刷一行会把剧情冲没。
   *
   * travel 会返回权威地图，必须拿它把 `view.position` 一起推进：
   * 位置视图只在回合 SSE 的 onUi 里更新，光刷 state 的话 HUD / 小地图 / 快捷选项
   * 会停在旧地点，直到玩家再说一句话为止。
   *
   * 返回是否真的到达：点「前往 TA 所在地」要据此决定是选中 NPC 还是报错；
   * 普通走动（WASD/地图点）忽略返回值，不把失败弹到对话流里。
   */
  const enterScene = useCallback(
    async (locId: string): Promise<{ ok: boolean; message?: string }> => {
      if (!roomId || !actorId) return { ok: false, message: "还没进入房间" };
      try {
        const res = await travel(roomId, actorId, locId);
        setView((v) => ({
          ...v,
          position: {
            locId: res.map.player.locId,
            name: res.scene.name,
            actors: v.position?.actors ?? [],
            exits: v.position?.exits ?? [],
          },
        }));
        void fetchState(roomId).then(setState).catch(() => undefined);
        return { ok: true };
      } catch (e) {
        // 已经在原地 / 点位未建成 / 不可达：交给调用方决定要不要提示
        return { ok: false, message: errorMessage(e) };
      }
    },
    [actorId, roomId],
  );

  /**
   * 发一回合。`echo=false` 用于「重试」：不重复把玩家那句话打进日志、不清空输入框；
   * clientTurnId 每次都是新 id，所以重试是一条全新的回合（幂等键由服务端回合表管）。
   */
  const dispatchTurn = useCallback(
    async (raw: string, targetNpc: { id: string; name: string } | null, echo: boolean) => {
      const base = raw.trim();
      if (!base || busy || !roomId || !actorId) return;
      // 选了对话对象就把目标写进行动语义：契约里 TurnRequest 没有 target 字段，
      // 否则两个不同 NPC 收到同一句"你好"时，服务端分不清在跟谁说话。
      const text = targetNpc ? `对${targetNpc.name}说：${base}` : base;
      lastTurn.current = { text: base, target: targetNpc };
      const tw = getTw();
      // 玩家急着说下一句：先把手上的字放完（包括上一回合还没打完的叙事）
      if (tw.typing) tw.skip();
      setBusy(true);
      setErr("");
      setErrRetryable(false);
      if (echo) {
        setInput("");
        push("player", text);
      }
      const clientTurnId = `${Date.now()}_${++turnSeq.current}`;
      tw.setTurnEnded(false);
      try {
        await runTurn(roomId, actorId, text, clientTurnId, {
          onDelta: (field, chunk) => {
            if (field !== "narrative") return;
            tw.feed(chunk);
          },
          // 模块的 facts 是玩家唯一能"看见世界动了"的地方（Mock 模式下尤其重要）
          onFacts: (facts) => {
            const rows = facts.filter((f) => f.trim().length > 0);
            if (rows.length === 0) return;
            const key = rows.join("\n");
            if (key === lastFacts.current) return; // 与上一回合完全相同：不再重复刷屏
            lastFacts.current = key;
            tw.enqueue(rows.map((f) => ({ kind: "fact" as LineKind, text: f })));
          },
          onPatch: (s) => setState(s),
          onUi: (v) => setView((old) => ({ ...old, ...v })),
          onError: (code, message, retryable) => {
            setErr(explainTurnError(code, message));
            setErrRetryable(isRetryableTurnError(code, retryable));
          },
        });
      } catch (e) {
        // 传输层/网络错误：可稍后再试，但不自动重发（避免重复扣费 / 重复回合）
        setErr(`${errorMessage(e)}（网络问题可稍后再试）`);
        setErrRetryable(false);
      } finally {
        tw.setTurnEnded(true);
        setBusy(false);
        void fetchState(roomId).then(setState).catch(() => undefined);
        // 回合提交后存档游标由服务端推进；这里刷新列表，回标题时时间戳是新的
        void refreshSaves();
      }
    },
    [actorId, busy, push, roomId, refreshSaves],
  );

  /** 发新回合（快捷建议把 `raw` 传进来就等于说出这句话，不必先填输入框） */
  const send = useCallback(
    (raw?: string, targetNpc?: { id: string; name: string } | null) => {
      void dispatchTurn(raw ?? input, targetNpc ?? null, true);
    },
    [dispatchTurn, input],
  );

  /** 重试上一回合：失败（尤其 E_LLM_FORMAT）时对话区出现按钮，不自动重试 */
  const retry = useCallback(() => {
    const last = lastTurn.current;
    if (!last) return;
    // 最后一道保险（issue #21 P2）：位置变化时上面的 effect 已经清过 lastTurn，
    // 但 NPC 自己也可能在回合之间换场景；重发前用当前状态再核一次在场，
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
    void dispatchTurn(last.text, last.target, false);
  }, [dispatchTurn, state, view.position?.locId]);

  /**
   * 换场景后旧的重试目标不再可信（issue #21 P2）：
   * 清掉 `lastTurn`；如果重试按钮正显示着，把按钮收掉并说明失效原因。
   * 重试按钮只可能出现在「上一回合可重试失败」之后，所以清 lastTurn 不影响正常对话。
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

  if (screen === "title") {
    return (
      <TitleScreen
        scenarios={scenarios}
        scenariosLoading={scenariosLoading}
        onStart={(scenarioId) => void startNew(scenarioId)}
        onResume={savedRoomId ? () => void resumeLast() : null}
        saves={saves}
        onOpenSave={(save) => void openSave(save)}
        onDeleteSave={(save) => void removeSave(save)}
        savedRoomId={savedRoomId}
        busy={entering}
        err={err}
      />
    );
  }

  const panels = view.panels ?? {};
  const pos = view.position;
  const typing = getTw().activeLine;
  /**
   * 开场白打完了吗？建议按钮要等逐字动画收尾后再出现，
   * 否则字还没打出来、按钮先摆在那儿，剧情的节奏就断了。
   * 玩家点一下日志跳过打字时 typing 也会立刻变 false，按钮随即出现。
   */
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
        <div className="tab-pane" key={tab}>
        {tab === "gallery" &&
          (roomId ? <GalleryPanel roomId={roomId} /> : <div className="panel-note">连接房间中…</div>)}

        {tab === "chat" && (
          <ChatPanel
            state={state}
            panels={panels}
            pos={pos}
            lines={lines}
            typing={typing}
            busy={busy}
            err={err}
            input={input}
            onInput={setInput}
            onSend={(target) => void send(undefined, target)}
            // 每回合结束（字打完、且不在等回复）都给建议；等回复时先收起，免得发旧选项
            suggestions={!busy && sceneSettled ? nextActions : []}
            onPick={(text, target) => void send(text, target)}
            onRetry={retry}
            retryable={errRetryable}
            roomId={roomId}
            onOpenMap={() => setMapOpen(true)}
            heroId={scenario?.id ?? ""}
            onEnterScene={enterScene}
            onSkipLog={() => getTw().skip()}
          />
        )}

        {tab === "drafts" &&
          (roomId ? (
            <DraftsPanel roomId={roomId} push={push} onRefreshState={refreshState} />
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
        />
      )}
    </div>
  );
}
