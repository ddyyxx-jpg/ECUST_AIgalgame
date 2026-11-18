/**
 * 校园大地图：直接在奉贤校区的底图上走。
 *
 * - 底图是 6000×4500 的实拍鸟瞰，所有坐标都用这张图自己的像素系；
 * - 主角是抠过背景的立绘 PNG，站在地图上（不随缩放变形，固定显示尺寸）；
 * - 33 个场景点位散布在图上，走近就"到达"（静默同步世界状态，不往对话流里刷字）；
 * - NPC 按 located_in 的位置摆成头像标记，走近头顶浮一句台词，点一下才开始对话。
 *
 * 关键设计：**移动循环里不允许出现任何 setState**。
 * 位置、相机、立绘 transform 全部走 ref + 直接改 DOM；
 * "附近有谁"这类要进 React 的状态，放在 160ms 的独立 interval 里算。
 * 这样无论父组件怎么重渲染，手上按着的键和每一帧的位移都不会被打断。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { MapScene, MapView } from "./api.ts";
import { fetchGallery, muttersByNpcId } from "./api-gallery.ts";

const W = 6000;
const H = 4500;
const SCALE = 0.42;
const SPEED = 300;
const ENTER_DIST = 170;
const TALK_DIST = 140;
const PROBE_MS = 160;

const MOVE_KEYS = new Set(["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"]);

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export interface CampusMapProps {
  map: MapView | null;
  /** 当前房间：气泡台词从房间图鉴读取（只对 met=true 的 NPC 下发） */
  roomId: string;
  heroSrc: string;
  talkingTo: string;
  busy: boolean;
  onTalk: (actorId: string, name: string) => void;
  /** 走到某个点位旁：交给上层静默同步世界状态 */
  onEnter: (sceneId: string) => void;
}

export default function CampusMap({ map, roomId, heroSrc, talkingTo, busy, onTalk, onEnter }: CampusMapProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [nearScene, setNearScene] = useState<MapScene | null>(null);
  const [nearNpc, setNearNpc] = useState<{ id: string; name: string } | null>(null);
  /** 头顶气泡台词：只取房间图鉴里 met=true 的 NPC；拉不到图鉴就空表（不出气泡） */
  const [mutters, setMutters] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!roomId) return;
    let alive = true;
    fetchGallery(roomId)
      .then((gallery) => {
        if (alive) setMutters(muttersByNpcId(gallery.npcs));
      })
      .catch(() => {
        if (alive) setMutters({});
      });
    return () => {
      alive = false;
    };
  }, [roomId]);

  const posRef = useRef<{ x: number; y: number } | null>(null);
  const keysRef = useRef<Set<string>>(new Set());
  const camRef = useRef({ x: 0, y: 0 });
  const mapRef = useRef<MapView | null>(null);
  mapRef.current = map;
  const onEnterRef = useRef(onEnter);
  onEnterRef.current = onEnter;

  const nearSceneRef = useRef<string>("");
  const nearNpcRef = useRef<string>("");
  const enteredRef = useRef<string>("");
  const startRef = useRef("");

  const scenes = map?.scenes ?? [];
  const spawn = useMemo(() => {
    const here = scenes.find((s) => s.id === map?.player.locId);
    return here ? { x: here.x, y: here.y } : { x: W / 2, y: H / 2 };
  }, [map?.player.locId, scenes]);

  // 出生：放在当前 locId 对应的点位
  useEffect(() => {
    if (!map || posRef.current) return;
    posRef.current = { ...spawn };
    setReady(true);
  }, [map, spawn]);

  // 用地图层传送（点小地图）后，人跟着点位走
  useEffect(() => {
    if (!map) return;
    const here = map.scenes.find((s) => s.id === map.player.locId);
    if (!here) return;
    if (startRef.current === here.id) return;
    startRef.current = here.id;
    if (posRef.current && Math.hypot(posRef.current.x - here.x, posRef.current.y - here.y) > 320) {
      posRef.current = { x: here.x, y: here.y };
      enteredRef.current = here.id;
    }
  }, [map]);

  // 键盘只绑一次：不随任何 React 状态重建
  useEffect(() => {
    const keys = keysRef.current;
    const onDown = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      const k = e.key.toLowerCase();
      if (!MOVE_KEYS.has(k)) return;
      keys.add(k);
      e.preventDefault();
    };
    const onUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
    const onBlur = () => keys.clear();

    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // 位移 + 相机：这一帧只碰 DOM，不碰 React
  useEffect(() => {
    if (!ready) return;
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const p = posRef.current;
      const vp = viewportRef.current;
      if (p && vp) {
        const keys = keysRef.current;
        let vx = 0;
        let vy = 0;
        if (keys.has("a") || keys.has("arrowleft")) vx -= 1;
        if (keys.has("d") || keys.has("arrowright")) vx += 1;
        if (keys.has("w") || keys.has("arrowup")) vy -= 1;
        if (keys.has("s") || keys.has("arrowdown")) vy += 1;
        if (vx !== 0 || vy !== 0) {
          const len = Math.hypot(vx, vy);
          p.x = clamp(p.x + (vx / len) * SPEED * dt, 40, W - 40);
          p.y = clamp(p.y + (vy / len) * SPEED * dt, 40, H - 40);
        }
        const viewW = vp.clientWidth / SCALE;
        const viewH = vp.clientHeight / SCALE;
        const cam = camRef.current;
        const targetX = clamp(p.x - viewW / 2, 0, Math.max(0, W - viewW));
        const targetY = clamp(p.y - viewH / 2, 0, Math.max(0, H - viewH));
        cam.x += (targetX - cam.x) * 0.22;
        cam.y += (targetY - cam.y) * 0.22;

        const world = worldRef.current;
        if (world) world.style.transform = `translate3d(${-cam.x * SCALE}px, ${-cam.y * SCALE}px, 0)`;
        const hero = heroRef.current;
        if (hero) {
          hero.style.transform = `translate3d(${p.x * SCALE}px, ${p.y * SCALE}px, 0)`;
          // 走动时给立绘一点起伏，肉眼就能确认"人在动"
          hero.classList.toggle("walking", vx !== 0 || vy !== 0);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready]);

  // 附近有谁：与渲染解耦的低频探测（160ms），setState 和 enter 都放这里
  useEffect(() => {
    if (!ready) return;
    const probe = () => {
      const p = posRef.current;
      const live = mapRef.current;
      if (!p || !live) return;

      let bestScene: MapScene | null = null;
      let bestD = ENTER_DIST;
      for (const s of live.scenes) {
        if (s.status !== "built") continue;
        const d = Math.hypot(s.x - p.x, s.y - p.y);
        if (d < bestD) {
          bestD = d;
          bestScene = s;
        }
      }
      const sceneKey = bestScene?.id ?? "";
      if (sceneKey !== nearSceneRef.current) {
        nearSceneRef.current = sceneKey;
        setNearScene(bestScene);
        if (bestScene && bestScene.id !== live.player.locId && enteredRef.current !== bestScene.id) {
          enteredRef.current = bestScene.id;
          onEnterRef.current(bestScene.id);
        }
        if (!bestScene) enteredRef.current = "";
      }

      let bestNpc: { id: string; name: string } | null = null;
      let bestNpcD = TALK_DIST;
      for (const n of live.npcs) {
        const d = Math.hypot(n.x - p.x, n.y - p.y);
        if (d < bestNpcD) {
          bestNpcD = d;
          bestNpc = { id: n.id, name: n.name };
        }
      }
      const npcKey = bestNpc?.id ?? "";
      if (npcKey !== nearNpcRef.current) {
        nearNpcRef.current = npcKey;
        setNearNpc(bestNpc);
      }
    };
    probe();
    const timer = window.setInterval(probe, PROBE_MS);
    return () => window.clearInterval(timer);
  }, [ready]);

  if (!map) {
    return (
      <div className="campus-loading">
        <span>正在加载校园地图…</span>
      </div>
    );
  }

  return (
    <div
      className="campus"
      ref={viewportRef}
      // 点场景 = 把焦点从输入框挪开；否则 WASD 会被当成打字
      onClick={() => {
        const el = document.activeElement;
        if (el instanceof HTMLElement && el !== document.body) el.blur();
      }}
    >
      <div className="campus-world" ref={worldRef} style={{ width: W * SCALE, height: H * SCALE }}>
        <div
          className="campus-ground"
          style={{ backgroundImage: `url(${map.image ?? "/map/ecust-campus.jpg"})` }}
        />

        {map.scenes.map((s) => {
          const built = s.status === "built";
          const isNear = nearScene?.id === s.id;
          return (
            <button
              type="button"
              key={s.id}
              className={`campus-poi${built ? "" : " planned"}${isNear ? " near" : ""}`}
              style={{ left: s.x * SCALE, top: s.y * SCALE }}
              title={built ? s.name : `${s.name}（${s.status === "planned" ? "规划中" : "在建"}）`}
              onClick={() => built && onEnter(s.id)}
            >
              <i />
              <span>{s.name}</span>
            </button>
          );
        })}

        {map.npcs.map((n) => {
          const isNear = nearNpc?.id === n.id;
          const isTalking = talkingTo === n.id;
          const mutter = mutters[n.id];
          return (
            <button
              type="button"
              key={n.id}
              className={`campus-npc${isNear ? " near" : ""}${isTalking ? " talking" : ""}`}
              style={{ left: n.x * SCALE, top: n.y * SCALE }}
              onClick={() => onTalk(n.id, n.name)}
              disabled={busy}
              title={`和${n.name}说话`}
            >
              {/* 走近时头顶浮一句短台词：只提示"可以聊"，不打断你走路 */}
              {isNear && !talkingTo && mutter && <span className="campus-mutter">{mutter}</span>}
              <img src={`/portraits/${n.id}.jpg`} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />
              <span className="npc-name">{n.name}</span>
            </button>
          );
        })}

        <div className="campus-hero" ref={heroRef}>
          <img src={heroSrc} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />
        </div>
      </div>

      <div className="campus-controls">
        <span className="campus-key">W</span>
        <span className="campus-key">A</span>
        <span className="campus-key">S</span>
        <span className="campus-key">D</span>
        <span className="campus-hint">走动</span>
      </div>

      {nearScene && (
        <div className="campus-tip">
          <strong>{nearScene.name}</strong>
          <span>
            {nearScene.id === map.player.locId
              ? "你就在这里"
              : nearScene.status === "built"
                ? "走近即到达"
                : "尚未开放"}
          </span>
        </div>
      )}
    </div>
  );
}
