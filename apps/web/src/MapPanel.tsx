import { useCallback, useEffect, useRef, useState } from "react";
import { getMap, openDialogue, tick, travel } from "./api.ts";
import type { MapScene, MapView } from "./api.ts";
import MapViewport from "./MapViewport.tsx";
import SceneDetail from "./SceneDetail.tsx";
import { errorMessage, phaseLabel, sceneName, sceneStatus } from "./ui.ts";
import type { LineKind } from "./ui.ts";

interface Props {
  roomId: string;
  actorId: string;
  push: (kind: LineKind, text: string) => void;
  /** travel/tick 后让 App 重拉 /state（只刷新，不缓存权威状态） */
  onRefreshState: () => void;
  /** 点击场景到达并写出剧情后：让 App 切回「对话」页，玩家立刻看到刚触发的剧情 */
  onStory?: () => void;
  /** 世界状态版本号：变化时静默重拉 /map（认识/改名后地图标注要立刻更新） */
  version?: number;
}

type Busy = "load" | "travel" | "tick" | "dialogue" | null;

/**
 * tick.moved 按 server-api 对齐的形状解析：`{actorId, name, from, to}` 的数组
 * （from/to 是 locId）。仍做防御解析，形状漂移时最多少显示摘要，不崩。
 */
function summarizeMoved(moved: unknown, map: MapView): string[] {
  if (!Array.isArray(moved) || moved.length === 0) return [];
  const sceneOf = (id: string) => map.scenes.find((s) => s.id === id)?.name ?? id;
  const out: string[] = [];
  for (const item of moved) {
    if (out.length >= 8) break;
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const actorId = typeof rec.actorId === "string" ? rec.actorId : "";
    const who =
      (typeof rec.name === "string" && rec.name) ||
      map.npcs.find((n) => n.id === actorId)?.name ||
      actorId;
    if (!who) continue;
    const from = typeof rec.from === "string" ? rec.from : "";
    const to = typeof rec.to === "string" ? rec.to : "";
    if (from && to) out.push(`${who} 从${sceneOf(from)}去了${sceneOf(to)}`);
    else if (to) out.push(`${who} 去了${sceneOf(to)}`);
    else out.push(`${who} 移动了`);
  }
  return out;
}

export default function MapPanel({ roomId, actorId, push, onRefreshState, onStory, version }: Props) {
  const [map, setMap] = useState<MapView | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [err, setErr] = useState("");
  /** 最新版本号：load 不能依赖 version，否则 version 一变会先触发挂载 effect 再发一次请求（审阅 P2） */
  const versionRef = useRef(version ?? 0);
  versionRef.current = version ?? versionRef.current;
  /** 已消费到的状态版本：挂载首拉与 version effect 不重复发请求 */
  const consumedVersion = useRef(version ?? 0);
  /** 静默重拉/主动写入的序号：晚到的旧响应不能覆盖 travel/tick 刚写入的新地图 */
  const reloadSeq = useRef(0);

  const applyMap = useCallback((next: MapView) => {
    setMap(next);
    setSelectedId((prev) => (next.scenes.some((s) => s.id === prev) ? prev : next.player.locId));
  }, []);

  /** travel/tick 的权威响应：先自增序号，作废所有在途的静默重拉与旧 load */
  const applyFresh = useCallback(
    (next: MapView) => {
      reloadSeq.current += 1;
      applyMap(next);
    },
    [applyMap],
  );

  const load = useCallback(async () => {
    const seq = ++reloadSeq.current;
    setBusy("load");
    try {
      const next = await getMap(roomId);
      if (seq !== reloadSeq.current) return; // 期间已有更新的写入（travel/tick/静默重拉）
      applyMap(next);
      setErr("");
      consumedVersion.current = versionRef.current;
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [applyMap, roomId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 认识/改名后地图标注必须立刻更新：状态版本真正变化时才静默重拉（不显示加载态）。
  // 版本没变不发请求；用序号丢弃过期响应，避免覆盖 travel/tick 刚写入的地图。
  useEffect(() => {
    if (version === undefined || version === consumedVersion.current) return;
    consumedVersion.current = version;
    const seq = ++reloadSeq.current;
    void getMap(roomId)
      .then((m) => {
        if (seq === reloadSeq.current) applyMap(m);
      })
      .catch(() => undefined);
  }, [version, roomId, applyMap]);

  // Esc 取消选中：详情回到「选择场景查看详情」的空态
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedId("");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const go = useCallback(
    async (scene: MapScene) => {
      setSelectedId(scene.id);
      // 未建成场景只展示，不能 travel（按钮在详情里也会禁用/隐藏）
      if (sceneStatus(scene) !== "built") return;
      if (!map || scene.id === map.player.locId) return;
      setBusy("travel");
      setErr("");
      try {
        const res = await travel(roomId, actorId, scene.id);
        applyFresh(res.map);
        setSelectedId(scene.id);
        if (res.map.player.locId === scene.id) {
          push("narrative", `【${res.scene.name}】${res.scene.desc}`);
          // 剧情已经写进对话流：自动切回对话页，玩家不用手动点 tab
          onStory?.();
        } else {
          setErr("没有到达该场景");
        }
        onRefreshState();
      } catch (e) {
        setErr(errorMessage(e));
      } finally {
        setBusy(null);
      }
    },
    [actorId, applyFresh, map, onRefreshState, onStory, push, roomId],
  );

  /**
   * 点击标记 = 只选中并展示详情（不自动前往）。
   * 出发统一走详情里的「前往此处」或场景链接，避免"手一滑就被传到别处"。
   */
  const handleSceneClick = useCallback((scene: MapScene) => {
    setSelectedId(scene.id);
  }, []);

  /** 详情里「链接」区域的场景跳转：按 id 或名称找场景，找到就沿用同一套 go 流程 */
  const goById = useCallback(
    (idOrName: string) => {
      if (!map) return;
      const target =
        map.scenes.find((s) => s.id === idOrName) ??
        map.scenes.find((s) => s.name === idOrName);
      if (!target) {
        setErr(`地图上找不到场景：${idOrName}`);
        return;
      }
      void go(target);
    },
    [go, map],
  );

  const advance = useCallback(async () => {
    setBusy("tick");
    setErr("");
    try {
      const res = await tick(roomId, true);
      applyFresh(res.map);
      const moves = summarizeMoved(res.moved, res.map);
      const head = `【时段推进】第 ${res.map.clock.day} 天 · ${phaseLabel(res.map.clock.phase)}`;
      push("system", moves.length ? `${head}。${moves.join("；")}` : `${head}。没有人移动。`);
      onRefreshState();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [applyFresh, onRefreshState, push, roomId]);

  const talk = useCallback(
    async (scene: MapScene, dialogueId: string) => {
      setBusy("dialogue");
      setErr("");
      try {
        const res = await openDialogue(roomId, actorId, scene.id, dialogueId);
        for (const line of res.lines) push("npc", `${res.npc.name}：${line}`);
        // 台词已经写进对话流：切回对话页，玩家立刻看到这场对话（与场景前往一致）
        onStory?.();
      } catch (e) {
        setErr(errorMessage(e));
      } finally {
        setBusy(null);
      }
    },
    [actorId, onStory, push, roomId],
  );

  if (!map) {
    return (
      <div className="panel-note">
        <div className="muted">{busy === "load" ? "加载地图…" : "地图尚未加载"}</div>
        {err && <div className="err">{err}</div>}
        <button className="btn" onClick={() => void load()} disabled={busy !== null}>
          重试
        </button>
      </div>
    );
  }

  const selected = map.scenes.find((s) => s.id === selectedId) ?? null;
  return (
    <div className="map-panel">
      <div className="map-stage">
        <div className="map-toolbar">
          <div>
            <strong>第 {map.clock.day} 天</strong>
            <span className="muted"> · {phaseLabel(map.clock.phase)}</span>
            <span className="muted"> · 你在{sceneName(map.scenes, map.player.locId)}</span>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => void advance()} disabled={busy !== null}>
              推进时段
            </button>
            <button className="btn ghost" onClick={() => void load()} disabled={busy !== null}>
              刷新
            </button>
          </div>
        </div>
        {err && <div className="err">{err}</div>}
        <MapViewport map={map} selectedId={selectedId} busy={busy !== null} onSceneClick={handleSceneClick} />
      </div>
      {selected ? (
        <SceneDetail
          scene={selected}
          map={map}
          busy={busy !== null}
          onTravel={(scene) => void go(scene)}
          onDialogue={(dialogueId) => void talk(selected, dialogueId)}
          onGoScene={goById}
        />
      ) : (
        <aside className="map-detail">
          <div className="muted">选择场景查看详情。</div>
        </aside>
      )}
    </div>
  );
}
