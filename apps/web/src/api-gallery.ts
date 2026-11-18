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
  /** 仅 met 时下发：地图头顶气泡台词（服务端从 NPC 档案取） */
  mutter?: string;
  stats: GalleryStat[];
}

export interface GalleryView {
  roomId: string;
  player: { actorId: string; locId: string };
  npcs: GalleryNpc[];
  counts: { met: number; total: number; locs: number };
}

/**
 * 地图气泡只认图鉴里已认识（met）的 NPC：未认识时服务端根本不下发 mutter。
 * 拉不到图鉴时调用方拿到空表 → 不出气泡（issue #54）。
 */
export function muttersByNpcId(npcs: GalleryNpc[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const npc of npcs) {
    if (npc.met && npc.mutter) out[npc.id] = npc.mutter;
  }
  return out;
}

export async function fetchGallery(roomId: string): Promise<GalleryView> {
  const res = await request<{ gallery: GalleryView }>("gallery", `/api/v1/rooms/${roomId}/gallery`);
  return unwrap(res).gallery;
}
