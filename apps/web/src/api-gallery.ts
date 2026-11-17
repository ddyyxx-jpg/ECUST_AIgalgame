/**
 * 图鉴的 HTTP 层（docs/03 §5.2.5）：读数由服务端按 registry 算好，前端只渲染。
 * 前端不碰属性键、不碰分档阈值、不碰可见性口径（I2 / issue #3）。
 */
import { request, unwrap } from "./http.ts";

export type Band = "低" | "中" | "高";

export interface GalleryStat {
  key: string;
  label: string;
  type: "number" | "string" | "boolean";
  visibility: "public" | "self" | "secret";
  unit?: string;
  display: "exact" | "band" | "text" | "masked";
  value?: number;
  ratio?: number;
  band?: Band;
  text?: string;
}

export interface GalleryNpc {
  id: string;
  name: string;
  met: boolean;
  present: boolean;
  locName?: string;
  role?: string;
  traits?: string[];
  line?: string;
  stats: GalleryStat[];
}

export interface GalleryView {
  roomId: string;
  player: { actorId: string; locId: string };
  npcs: GalleryNpc[];
  counts: { met: number; total: number; locs: number };
}

export async function fetchGallery(roomId: string): Promise<GalleryView> {
  const res = await request<{ gallery: GalleryView }>("gallery", `/api/v1/rooms/${roomId}/gallery`);
  return unwrap(res).gallery;
}
