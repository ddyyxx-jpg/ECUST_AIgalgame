/**
 * 全屏地图层：对话页里点小地图后展开，选完地点就回到对话。
 *
 * 复用的是原来「地图」标签页的 MapPanel —— 缩放、拖拽、选点、详情、前往、时段推进
 * 全都在里面，这里只负责一层遮罩和一个关闭入口，不再复制一套地图逻辑。
 */
import { useEffect } from "react";
import MapPanel from "./MapPanel.tsx";
import type { LineKind } from "./ui.ts";

export interface MapOverlayProps {
  open: boolean;
  onClose: () => void;
  roomId: string;
  actorId: string;
  push: (kind: LineKind, text: string) => void;
  onRefreshState: () => void;
  /** 世界状态版本号：认识/改名后地图标注要立刻刷新 */
  version?: number;
}

export default function MapOverlay({ open, onClose, roomId, actorId, push, onRefreshState, version }: MapOverlayProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="map-overlay" role="dialog" aria-modal="true" aria-label="校园地图">
      <div className="map-overlay-bar">
        <div>
          <strong>校园地图</strong>
          <span className="muted"> 点标记看详情，再点「前往此处」过去</span>
        </div>
        <button type="button" className="btn ghost" onClick={onClose}>
          关闭（Esc）
        </button>
      </div>
      <div className="map-overlay-body">
        <MapPanel
          roomId={roomId}
          actorId={actorId}
          push={push}
          onRefreshState={onRefreshState}
          onStory={onClose}
          version={version}
        />
      </div>
    </div>
  );
}
