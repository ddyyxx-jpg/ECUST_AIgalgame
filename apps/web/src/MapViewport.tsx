import { useCallback, useEffect, useRef, useState } from "react";
import type { MapChatter, MapNpc, MapScene, MapView } from "./api.ts";
import MapLegend from "./MapLegend.tsx";
import {
  DRAG_THRESHOLD_PX,
  MAX_ZOOM_MULTIPLIER,
  clampView,
  fitScaleOf,
  fitView,
  wheelPixels,
  zoomAt,
} from "./map-geometry.ts";
import type { Size, ViewTransform } from "./map-geometry.ts";
import { sceneStatus, sceneStatusLabel } from "./ui.ts";

interface Props {
  map: MapView;
  selectedId: string;
  busy: boolean;
  /** 标记点击：由 MapPanel 决定（built = 选中并前往；其余只选中） */
  onSceneClick: (scene: MapScene) => void;
}

/**
 * 地图视口：底图 + 缩放/拖拽 + 场景标记。
 * 只读取 MapView，不做任何权威状态推演；点击语义交给 MapPanel。
 */
export default function MapViewport({ map, selectedId, busy, onSceneClick }: Props) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
    captured: boolean;
  } | null>(null);
  /** 拖拽后的 pointerup 会让 click 落到原点，用一次性的标记吞掉它，避免误触 travel */
  const suppressClickRef = useRef(false);

  const [viewport, setViewport] = useState<Size>({ w: 0, h: 0 });
  const [view, setView] = useState<ViewTransform>({ scale: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [imageBroken, setImageBroken] = useState(false);
  const fittedDimsRef = useRef("");

  const width = map.width > 0 ? map.width : 1000;
  const height = map.height > 0 ? map.height : 640;
  // 允许部署在子路径/反代前缀下：按 document.baseURI 解析，而不是写死站点根。
  const imgUrl = map.image
    ? new URL(
        map.image.replace(/^\//, ""),
        typeof document !== "undefined" ? document.baseURI : "http://localhost/",
      ).href
    : "";
  const showImage = imgUrl !== "" && !imageBroken;
  const fitScale = viewport.w > 0 && viewport.h > 0 ? fitScaleOf(width, height, viewport) : 1;
  const markerScale = 1 / view.scale;

  // 视口尺寸：ResizeObserver 覆盖窗口缩放、侧栏折叠等所有布局变化
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) setViewport({ w: rect.width, h: rect.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 底图换了（或重试加载）就清掉失败标记
  useEffect(() => {
    setImageBroken(false);
  }, [imgUrl]);

  // 首次（或底图原始尺寸变化时）fit 居中；之后只在视口变化时夹紧，不重置用户缩放
  useEffect(() => {
    if (viewport.w <= 0 || viewport.h <= 0) return;
    const key = `${width}x${height}`;
    if (fittedDimsRef.current !== key) {
      fittedDimsRef.current = key;
      setView(fitView(width, height, viewport));
      return;
    }
    setView((prev) => clampView(prev, width, height, viewport));
  }, [width, height, viewport]);

  // 滚轮缩放：以鼠标位置为不动点。必须用非 passive 的原生监听才能 preventDefault
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const vp: Size = { w: rect.width, h: rect.height };
      if (vp.w <= 0 || vp.h <= 0) return;
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      // 指数映射：滚轮一格约 6%，且每帧变化有上限，触控板也不会跳变
      const factor = Math.min(1.5, Math.max(1 / 1.5, Math.exp(-wheelPixels(e) * 0.0015)));
      setView((prev) => zoomAt(prev, factor, px, py, width, height, vp));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [width, height]);

  const zoomAroundCenter = useCallback(
    (factor: number) => {
      const el = viewportRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vp: Size = { w: rect.width, h: rect.height };
      if (vp.w <= 0 || vp.h <= 0) return;
      setView((prev) => zoomAt(prev, factor, vp.w / 2, vp.h / 2, width, height, vp));
    },
    [width, height],
  );

  const resetView = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    setView(fitView(width, height, { w: rect.width, h: rect.height }));
  }, [width, height]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    suppressClickRef.current = false;
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: view.x,
      originY: view.y,
      moved: false,
      captured: false,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      drag.captured = true;
      setDragging(true);
      // 超过阈值才捕获指针：拖出视口仍跟手，而「没拖动」的点击照常命中标记
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vp: Size = { w: rect.width, h: rect.height };
    const originX = drag.originX;
    const originY = drag.originY;
    setView((prev) => clampView({ scale: prev.scale, x: originX + dx, y: originY + dy }, width, height, vp));
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (!drag.moved) return;
    suppressClickRef.current = true;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handleSceneClick = (scene: MapScene) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (busy) return;
    onSceneClick(scene);
  };

  return (
    <div
      ref={viewportRef}
      className={`map-viewport${dragging ? " dragging" : ""}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        className="map-canvas"
        style={{
          width,
          height,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
        }}
      >
        {showImage && (
          <img
            key={imgUrl}
            className="map-base"
            src={imgUrl}
            alt="校园底图"
            draggable={false}
            loading="eager"
            decoding="async"
            onError={() => setImageBroken(true)}
          />
        )}

        {map.npcs.map((npc) => (
          <span
            key={npc.id}
            className="map-npc"
            style={{ left: npc.x, top: npc.y, transform: `translate(-50%,-50%) scale(${markerScale})` }}
            title={npc.name}
          />
        ))}

        {(map.chatter ?? [])
          .map((line) => ({ line, npc: map.npcs.find((n) => n.id === line.speakerId) }))
          .filter((x): x is { line: MapChatter; npc: MapNpc } => Boolean(x.npc))
          .slice(-3)
          .map(({ line, npc }) => (
            <span
              key={line.id}
              className="map-bubble"
              style={{ left: npc.x, top: npc.y, transform: `translate(-50%,-100%) scale(${markerScale})` }}
            >
              {line.text}
            </span>
          ))}

        {map.scenes.map((scene) => {
          const status = sceneStatus(scene);
          const present = scene.presentNpcIds
            .map((id) => map.npcs.find((n) => n.id === id)?.name)
            .filter((name): name is string => Boolean(name));
          const classes = [
            "map-scene",
            `status-${status}`,
            scene.id === map.player.locId ? "current" : "",
            scene.id === selectedId ? "selected" : "",
            scene.installed ? "" : "uninstalled",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={scene.id}
              type="button"
              className={classes}
              style={{
                left: scene.x,
                top: scene.y,
                transform: `translate(-50%,-50%) scale(${markerScale})`,
              }}
              aria-disabled={busy}
              title={`${scene.name}｜${sceneStatusLabel(scene)}${status === "built" ? "（点击前往）" : "（暂不可前往）"}`}
              onClick={() => handleSceneClick(scene)}
            >
              <span className="map-scene-name">{scene.name}</span>
              {present.length > 0 && <span className="map-scene-sub">{present.join("、")}</span>}
              {scene.id === map.player.locId && <span className="map-you">你</span>}
            </button>
          );
        })}
      </div>

      {!showImage && (
        <div className="map-empty-hint">
          <strong>{map.image ? "校园底图加载失败" : "暂无校园底图"}</strong>
          <span className="muted">
            {map.image ? `（${map.image}）` : "已按像素坐标回退为网格底"}
          </span>
        </div>
      )}

      <div className="map-zoom" onPointerDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="map-zoom-btn"
          aria-label="放大"
          onClick={() => zoomAroundCenter(1.5)}
          disabled={view.scale >= fitScale * MAX_ZOOM_MULTIPLIER * 0.999}
        >
          +
        </button>
        <button
          type="button"
          className="map-zoom-btn"
          aria-label="缩小"
          onClick={() => zoomAroundCenter(1 / 1.5)}
          disabled={view.scale <= fitScale * 1.001}
        >
          −
        </button>
        <button type="button" className="map-zoom-btn reset" onClick={resetView}>
          重置
        </button>
        <span className="map-zoom-value">{Math.round((view.scale / fitScale) * 100)}%</span>
      </div>

      <MapLegend />

      <div className="map-hint">滚轮缩放 · 拖拽平移 · Esc 取消选中</div>
    </div>
  );
}
