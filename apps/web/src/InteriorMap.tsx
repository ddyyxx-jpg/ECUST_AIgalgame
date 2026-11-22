/**
 * 图书馆室内地图。
 *
 * 与 CampusMap 同一套移动手感（rAF 走位 + ref 直改 DOM，移动循环里零 setState），
 * 但室内只有三层内容：地板底图、几个功能点位、以及馆内的 NPC。
 *
 * 出口单独做成一个醒目的门标记：走到附近点它，就交回上层切回校园大地图。
 */
import { useEffect, useRef, useState } from "react";
import type { MapNpc } from "./api.ts";
import type { InteriorMap } from "./interior.ts";

const SCALE = 0.85;
const SPEED = 380;
const TALK_DIST = 110;
const EXIT_DIST = 130;
/** 靠近出口满 0.5 秒自动离开 */
const EXIT_DWELL_MS = 1500;
const PROBE_MS = 160;
/** 4 帧走路循环：并腿 → 迈左脚 → 并腿 → 迈右脚 */
const WALK_SEQ = ["", "-walk1", "", "-walk2"];
/** 每帧时长（毫秒）：4 帧约 0.6 秒一个完整步循环 */
const STEP_MS = 150;

const MOVE_KEYS = new Set(["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"]);

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export interface InteriorMapProps {
  interior: InteriorMap;
  /** 馆内的 NPC（已由上层筛好，坐标是室内坐标） */
  npcs: MapNpc[];
  heroSrc: string;
  talkingTo: string;
  busy: boolean;
  onTalk: (actorId: string, name: string) => void;
  /** 点出口：回到校园大地图 */
  onExit: () => void;
}

export default function InteriorMap({
  interior,
  npcs,
  heroSrc,
  talkingTo,
  busy,
  onTalk,
  onExit,
}: InteriorMapProps) {
  const { width: W, height: H } = interior;
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const posRef = useRef<{ x: number; y: number } | null>(null);
  const keysRef = useRef<Set<string>>(new Set());
  const camRef = useRef({ x: 0, y: 0 });
  const [ready, setReady] = useState(false);
  const [nearNpc, setNearNpc] = useState<{ id: string; name: string } | null>(null);
  const [nearExit, setNearExit] = useState(false);
  /** 出口同样要"离开过一次范围"才武装，避免刚进门就触发离开 */
  const exitArmedRef = useRef(false);
  const exitDwellRef = useRef<{ since: number; fired: boolean }>({ since: 0, fired: false });
  const exitRingRef = useRef<SVGCircleElement | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  // 四方向立绘
  const heroBase = heroSrc.endsWith("-down.png") ? heroSrc.slice(0, -"-down.png".length) : heroSrc.replace(/\.png$/, "");
  const heroImgRef = useRef<HTMLImageElement | null>(null);
  const heroDirRef = useRef('down');
  const heroStepRef = useRef(0);
  const heroLastStepRef = useRef(0);
  const heroBaseRef = useRef(heroBase);
  heroBaseRef.current = heroBase;

  useEffect(() => {
    for (const d of ["up", "side", "left", "down-walk1", "down-walk2", "side-walk1", "side-walk2", "left-walk1", "left-walk2"]) {
      const im = new Image();
      im.src = `${heroBase}-${d}.png`;
    }
  }, [heroBase]);

  // 出生点：进门就站在门口内侧
  useEffect(() => {
    if (posRef.current) return;
    posRef.current = { ...interior.spawn };
    setReady(true);
  }, [interior]);

  // 键盘只绑一次
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

  // 位移 + 相机：只碰 DOM
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
          p.x = clamp(p.x + (vx / len) * SPEED * dt, 60, W - 60);
          p.y = clamp(p.y + (vy / len) * SPEED * dt, 60, H - 60);
        }
        const viewW = vp.clientWidth / SCALE;
        const viewH = vp.clientHeight / SCALE;
        const cam = camRef.current;
        // 室内图比视口小时居中显示（之前会贴在左上角）
        const tx = W > viewW ? clamp(p.x - viewW / 2, 0, W - viewW) : (W - viewW) / 2;
        const ty = H > viewH ? clamp(p.y - viewH / 2, 0, H - viewH) : (H - viewH) / 2;
        cam.x += (tx - cam.x) * 0.32;
        cam.y += (ty - cam.y) * 0.32;
        const world = worldRef.current;
        if (world) world.style.transform = `translate3d(${Math.round(-cam.x * SCALE)}px, ${Math.round(-cam.y * SCALE)}px, 0)`;
        const hero = heroRef.current;
        if (hero) {
          hero.style.transform = `translate3d(${Math.round(p.x * SCALE)}px, ${Math.round(p.y * SCALE)}px, 0)`;
          hero.classList.toggle("walking", vx !== 0 || vy !== 0);
          const img = heroImgRef.current;
          if (img) {
            const moving = vx !== 0 || vy !== 0;
            let dir = "";
            if (vx < 0) dir = "left";
            else if (vx > 0) dir = "side";
            else if (vy < 0) dir = "up";
            else if (vy > 0) dir = "down";

            let changed = false;
            if (dir && dir !== heroDirRef.current) {
              heroDirRef.current = dir;
              changed = true;
            }
            // 4 帧走路循环：并腿 → 迈左脚 → 并腿 → 迈右脚
            if (moving && dir && dir !== "up") {
              if (now - heroLastStepRef.current > STEP_MS) {
                heroLastStepRef.current = now;
                heroStepRef.current = (heroStepRef.current + 1) % WALK_SEQ.length;
                changed = true;
              }
            } else if (heroStepRef.current !== 0) {
              heroStepRef.current = 0;
              changed = true;
            }
            if (changed) {
              const d = heroDirRef.current;
              const suffix = d !== "up" ? WALK_SEQ[heroStepRef.current] : "";
              img.src = `${heroBaseRef.current}-${d}${suffix}.png`;
            }
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready, W, H]);

  // 附近有谁 / 是否靠近出口
  useEffect(() => {
    if (!ready) return;
    const probe = () => {
      const p = posRef.current;
      if (!p) return;
      let best: { id: string; name: string } | null = null;
      let bestD = TALK_DIST;
      for (const n of npcs) {
        const d = Math.hypot(n.x - p.x, n.y - p.y);
        if (d < bestD) {
          bestD = d;
          best = { id: n.id, name: n.name };
        }
      }
      setNearNpc((prev) => (prev?.id === best?.id ? prev : best));

      // 靠近出口满 1.5 秒自动离开（和大地图进室内同一套手感）
      const near = Math.hypot(interior.exit.x - p.x, interior.exit.y - p.y) < EXIT_DIST;
      setNearExit(near);
      const now = Date.now();
      const dw = exitDwellRef.current;
      const RING_LEN = 2 * Math.PI * 17;
      const ring = exitRingRef.current;

      if (!near) {
        exitArmedRef.current = true;
        dw.since = 0;
        dw.fired = false;
        if (ring) {
          ring.style.strokeDashoffset = String(RING_LEN);
          ring.classList.remove("on");
        }
      } else if (!exitArmedRef.current) {
        dw.since = 0;
        dw.fired = false;
        if (ring) {
          ring.style.strokeDashoffset = String(RING_LEN);
          ring.classList.remove("on");
        }
      } else if (!dw.since) {
        dw.since = now;
      } else {
        const pct = Math.min(1, (now - dw.since) / EXIT_DWELL_MS);
        if (ring) {
          ring.style.strokeDashoffset = String(RING_LEN * (1 - pct));
          ring.classList.toggle("on", pct > 0.01);
        }
        if (!dw.fired && pct >= 1) {
          dw.fired = true;
          exitArmedRef.current = false;
          onExitRef.current();
        }
      }
    };
    probe();
    const timer = window.setInterval(probe, PROBE_MS);
    return () => window.clearInterval(timer);
  }, [ready, npcs, interior.exit]);

  return (
    <div
      className="campus interior"
      ref={viewportRef}
      onClick={() => {
        const el = document.activeElement;
        if (el instanceof HTMLElement && el !== document.body) el.blur();
      }}
    >
      <div className="campus-world" ref={worldRef} style={{ width: W * SCALE, height: H * SCALE }}>
        <div className="campus-ground" style={{ backgroundImage: `url(${interior.image})` }} />

        {interior.spots.map((s) => (
          <div key={s.id} className={`interior-spot ${s.kind}`} style={{ left: Math.round(s.x * SCALE), top: Math.round(s.y * SCALE) }}>
            <i />
            <span>{s.name}</span>
          </div>
        ))}

        {npcs.map((n) => {
          const isNear = nearNpc?.id === n.id;
          const isTalking = talkingTo === n.id;
          return (
            <button
              type="button"
              key={n.id}
              className={`campus-npc${isNear ? " near" : ""}${isTalking ? " talking" : ""}`}
              style={{ left: Math.round(n.x * SCALE), top: Math.round(n.y * SCALE) }}
              onClick={() => onTalk(n.id, n.name)}
              disabled={busy}
              title={`和${n.name}说话`}
            >
              <img
                src={`/portraits/npc-${n.id.replace(/^npc_/, "")}.png`}
                alt=""
                onError={(e) => (e.currentTarget.style.display = "none")}
              />
              <span className="npc-name">{n.name}</span>
            </button>
          );
        })}

        <button
          type="button"
          className={`interior-exit${nearExit ? " near" : ""}`}
          style={{ left: Math.round(interior.exit.x * SCALE), top: Math.round(interior.exit.y * SCALE) }}
          onClick={onExit}
          title="离开这里"
        >
          <span className="exit-ic">
            <svg className="exit-ring" viewBox="0 0 40 40" width="40" height="40">
              <circle className="ring-bg" cx="20" cy="20" r="17" />
              <circle
                className="ring-fg"
                ref={exitRingRef}
                cx="20"
                cy="20"
                r="17"
                strokeDasharray={String(2 * Math.PI * 17)}
                strokeDashoffset={String(2 * Math.PI * 17)}
              />
            </svg>
            <i>出</i>
          </span>
          <span className="exit-label">离开</span>
        </button>

        <div className="campus-hero" ref={heroRef}>
          <img
            ref={heroImgRef}
            src={heroSrc}
            alt=""
            onError={(e) => (e.currentTarget.style.display = "none")}
          />
        </div>
      </div>

      <div className="campus-controls">
        <span className="campus-key">W</span>
        <span className="campus-key">A</span>
        <span className="campus-key">S</span>
        <span className="campus-key">D</span>
        <span className="campus-hint">走动</span>
      </div>

      {nearExit && (
        <div className="campus-tip">
          <strong>出口</strong>
          <span>点「出」回到校园</span>
        </div>
      )}
    </div>
  );
}
