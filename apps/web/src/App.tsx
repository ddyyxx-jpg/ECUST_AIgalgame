import { useCallback, useEffect, useRef, useState } from "react";
import type { WorldState, ViewPatch } from "../../../packages/shared/src/contract/types.ts";
import { createSoloRoom, fetchState, runTurn } from "./api.ts";
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

  // 只读本地记录的房间号，用来决定"继续上次"是否出现
  useEffect(() => {
    try {
      setSavedRoomId(localStorage.getItem(ROOM_KEY) ?? "");
    } catch {
      setSavedRoomId("");
    }
  }, []);

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
  const enterRoom = useCallback(async (id: string, resumed: boolean) => {
    const snapshot = await fetchState(id);
    const fallback = scenarios[0] ?? null;
    let sc: Scenario | null = fallback;
    try {
      const stored = localStorage.getItem(scenarioKey(id)) ?? "";
      sc = scenarios.find((s) => s.id === stored) ?? fallback;
      localStorage.setItem(ROOM_KEY, id);
      setSavedRoomId(id);
    } catch {
      // 隐私模式读不了本地记录：用默认开局，不影响本局
    }

    // 开场 = 对话流的第一屏：身份 → 正文 → 第一条建议。全部交给打字机逐字打出。
    // 没有预设剧本（服务端 /api/v1/scenarios 不可用）时只留一行提示，不编造内容。
    const tw = getTw();
    tw.reset();
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
      ...(resumed ? [{ kind: "system" as LineKind, text: "（之前的对话不保存；世界状态已从事件日志恢复）" }] : []),
    ]);

    setScenario(sc);
    setState(snapshot);
    setRoomId(id);
    setTab("chat");
    setScreen("game");
  }, [scenarios]);

  const startNew = useCallback(
    async (scenarioId: string) => {
      setEntering(true);
      setErr("");
      try {
        const id = await createSoloRoom();
        try {
          localStorage.setItem(scenarioKey(id), scenarioId);
        } catch {
          // 隐私模式写不了，退回默认开局，不影响本局
        }
        await enterRoom(id, false);
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
      await enterRoom(savedRoomId, true);
    } catch (e) {
      // 房间被清理 / 服务重启后日志丢失：清掉记录，让玩家重新开局
      try {
        localStorage.removeItem(ROOM_KEY);
      } catch {
        // 忽略
      }
      setSavedRoomId("");
      setErr(`上次的房间已不可用（${errorMessage(e)}），请新建一局`);
    } finally {
      setEntering(false);
    }
  }, [enterRoom, savedRoomId]);

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
    }
  }, [busy, input, push, roomId]);

  if (screen === "title") {
    return (
      <TitleScreen
        scenarios={scenarios}
        scenariosLoading={scenariosLoading}
        onStart={(scenarioId) => void startNew(scenarioId)}
        onResume={savedRoomId ? () => void resumeLast() : null}
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
