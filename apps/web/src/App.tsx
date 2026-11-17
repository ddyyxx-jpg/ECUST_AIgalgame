import { useCallback, useEffect, useRef, useState } from "react";
import type { WorldState, ViewPatch } from "../../../packages/shared/src/contract/types.ts";
import { GameError, createSoloRoom, deleteSave, fetchHistory, fetchSaves, fetchState, playerId, runTurn } from "./api.ts";
import type { HistoryLine, SaveEntry } from "./api.ts";
import ChatPanel from "./ChatPanel.tsx";
import DraftsPanel from "./DraftsPanel.tsx";
import GalleryPanel from "./GalleryPanel.tsx";
import MapPanel from "./MapPanel.tsx";
import TitleScreen from "./TitleScreen.tsx";
import { fetchScenarios } from "./scenarios.ts";
import type { Scenario } from "./scenarios.ts";
import { installClickSound, setSoundOn, soundOn } from "./sfx.ts";
import { Typewriter } from "./typewriter.ts";
import type { TypeItem } from "./typewriter.ts";
import { ACTOR, errorMessage, phaseLabel } from "./ui.ts";
import type { Line, LineKind } from "./ui.ts";

type Tab = "chat" | "map" | "gallery" | "drafts";
type Screen = "title" | "game";

const TABS: { id: Tab; label: string }[] = [
  { id: "chat", label: "对话" },
  { id: "map", label: "地图" },
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
  const [saves, setSaves] = useState<SaveEntry[]>([]);
  const [sfx, setSfx] = useState(soundOn);
  const turnSeq = useRef(0);
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
    async (id: string, opts: { resumed?: boolean; scenarioId?: string } = {}) => {
      const snapshot = await fetchState(id);
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
        // 开场 = 对话流的第一屏：身份 → 正文 → 第一条建议。全部交给打字机逐字打出。
        // 没有预设剧本（服务端 /api/v1/scenarios 不可用）时只留一行提示，不编造内容。
        setLines([]);
        const opening: TypeItem[] = sc
          ? [
              { kind: "system", text: `序章 · ${sc.name} · ${sc.role}` },
              ...sc.opening.map((text) => ({ kind: "narrative" as LineKind, text })),
              { kind: "system", text: `试试：${sc.hint}` },
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
        const id = await createSoloRoom(scenarioId);
        await enterRoom(id, { scenarioId });
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
      await enterRoom(savedRoomId, { resumed: true });
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
  }, [enterRoom, savedRoomId]);

  /** 从"我的存档"进房：走与继续上次相同的恢复路径（有历史就重放） */
  const openSave = useCallback(
    async (save: SaveEntry) => {
      setEntering(true);
      setErr("");
      try {
        await enterRoom(save.roomId, { resumed: true, scenarioId: save.scenarioId });
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

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy || !roomId) return;
    const tw = getTw();
    // 玩家急着说下一句：先把手上的字放完（包括上一回合还没打完的叙事）
    if (tw.typing) tw.skip();
    setBusy(true);
    setErr("");
    setInput("");
    push("player", text);
    const clientTurnId = `${Date.now()}_${++turnSeq.current}`;
    tw.setTurnEnded(false);
    try {
      await runTurn(roomId, ACTOR, text, clientTurnId, {
        onDelta: (field, chunk) => {
          if (field !== "narrative") return;
          tw.feed(chunk);
        },
        // 模块的 facts 是玩家唯一能"看见世界动了"的地方（Mock 模式下尤其重要）
        onFacts: (facts) => {
          tw.enqueue(facts.filter((f) => f.trim().length > 0).map((f) => ({ kind: "fact" as LineKind, text: f })));
        },
        onPatch: (s) => setState(s),
        onUi: (v) => setView((old) => ({ ...old, ...v })),
        onError: (code, message) => setErr(`${code}: ${message}`),
      });
    } catch (e) {
      setErr(String(e));
    } finally {
      tw.setTurnEnded(true);
      setBusy(false);
      void fetchState(roomId).then(setState).catch(() => undefined);
      // 回合提交后存档游标由服务端推进；这里刷新列表，回标题时时间戳是新的
      void refreshSaves();
    }
  }, [busy, input, push, roomId]);

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
            onSend={() => void send()}
            onSkipLog={() => getTw().skip()}
          />
        )}

        {tab === "map" &&
          (roomId ? (
            <MapPanel
              roomId={roomId}
              actorId={ACTOR}
              push={push}
              onRefreshState={refreshState}
              onStory={() => setTab("chat")}
            />
          ) : (
            <div className="panel-note">连接房间中…</div>
          ))}

        {tab === "drafts" &&
          (roomId ? (
            <DraftsPanel roomId={roomId} push={push} onRefreshState={refreshState} />
          ) : (
            <div className="panel-note">连接房间中…</div>
          ))}
        </div>
      </div>
    </div>
  );
}
