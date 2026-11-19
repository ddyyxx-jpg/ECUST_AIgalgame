/** 地图与场景草案的 HTTP 层（docs/06 §4）；只解析服务端返回，不做任何推演。 */
import type { GameClock } from "../../../packages/shared/src/contract/types.ts";
import { jsonHeaders, request, unwrap } from "./http.ts";

// ---------------------------------------------------------------- 地图视图

export interface MapLink {
  kind: "module" | "npc" | "dialogue" | "scene";
  id: string;
  label?: string;
  available: boolean;
}

/** 场景建成状态：只有 built 可 travel；planned / under_construction 只在地图上展示 */
export type MapSceneStatus = "built" | "under_construction" | "planned";

export interface MapScene {
  id: string;
  name: string;
  desc: string;
  tags: string[];
  /** 底图像素坐标（与 MapView.width/height 同一坐标系） */
  x: number;
  y: number;
  /** 建成状态（服务端字段；老服务端缺省时展示层按 built 兜底） */
  status: MapSceneStatus;
  /** 场景类别英文 key（teaching/lab/dorm/food/...），中文名由展示层映射 */
  category: string;
  origin: "canon" | "user";
  /** 本房间世界是否已有该 loc 实体；false 时服务端会在 travel 时懒安装 */
  installed: boolean;
  /** 实时在场 NPC（located_in） */
  presentNpcIds: string[];
  /** 数据里 links kind=npc 的固定 NPC */
  residentNpcIds: string[];
  links: MapLink[];
}

export interface MapNpc {
  id: string;
  name: string;
  locId: string;
  x: number;
  y: number;
}

export interface MapView {
  worldId: string;
  /** 底图 URL（public 下静态资源，如 "/map/ecust-campus.jpg"）；null = 无底图 */
  image: string | null;
  /** 底图原始像素宽高；场景 x/y 与 NPC x/y 都在这个坐标系里 */
  width: number;
  height: number;
  clock: GameClock;
  player: { actorId: string; locId: string };
  scenes: MapScene[];
  npcs: MapNpc[];
  published: string[];
}

export interface TravelResult {
  scene: MapScene;
  events: unknown[];
  map: MapView;
}

/** tick 的 moved：server-api 约定固定为数组（from/to 是 locId） */
export interface MovedActor {
  actorId: string;
  name: string;
  from: string;
  to: string;
}

export interface TickResult {
  events: unknown[];
  moved: MovedActor[];
  map: MapView;
}

export interface DialogueResult {
  npc: { id: string; name: string };
  lines: string[];
  sessionId: string;
}

export async function getMap(roomId: string): Promise<MapView> {
  return unwrap(await request<{ map: MapView }>("map", `/api/v1/rooms/${roomId}/map`)).map;
}

export async function travel(roomId: string, actorId: string, locId: string): Promise<TravelResult> {
  const res = await request<TravelResult>("travel", `/api/v1/rooms/${roomId}/map/travel`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ locId, actorId }),
  });
  return unwrap(res);
}

export async function tick(roomId: string, advance: boolean): Promise<TickResult> {
  const res = await request<TickResult>("tick", `/api/v1/rooms/${roomId}/map/tick`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ advance }),
  });
  return unwrap(res);
}

export async function openDialogue(
  roomId: string,
  actorId: string,
  sceneId: string,
  dialogueId: string,
): Promise<DialogueResult> {
  const res = await request<DialogueResult>("dialogue", `/api/v1/rooms/${roomId}/map/dialogue`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ sceneId, dialogueId, actorId }),
  });
  return unwrap(res);
}

// ---------------------------------------------------------------- 场景草案（docs/06 §5）

export type DraftStatus =
  | "pending_review"
  | "approved"
  | "generating"
  | "generated_pending_review"
  | "published"
  | "rejected";

export interface GeneratedSceneLink {
  kind: string;
  id: string;
  label?: string;
}

export interface GeneratedSceneDialogue {
  /** 服务端生成的对话 id，发布后可直接用来调 /map/dialogue */
  id: string;
  title: string;
  npcId: string;
  lines: string[];
}

export interface GeneratedScene {
  name: string;
  desc: string;
  tags: string[];
  links: GeneratedSceneLink[];
  dialogues: GeneratedSceneDialogue[];
}

export interface DraftHistoryEntry {
  at: number;
  action: string;
  actor: "player" | "admin" | "ai";
  note?: string;
}

export interface SceneDraft {
  id: string;
  status: DraftStatus;
  name: string;
  idea: string;
  anchorLocId: string;
  coords: { x: number; y: number };
  generated?: GeneratedScene;
  error?: string;
  history: DraftHistoryEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateDraftBody {
  name: string;
  idea: string;
  anchorLocId: string;
  x?: number;
  y?: number;
}

export async function createDraft(body: CreateDraftBody): Promise<SceneDraft> {
  const res = await request<{ draft: SceneDraft }>("create draft", "/api/v1/map/drafts", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
  return unwrap(res).draft;
}

export async function getDraft(id: string): Promise<SceneDraft> {
  const res = await request<{ draft: SceneDraft }>("get draft", `/api/v1/map/drafts/${encodeURIComponent(id)}`);
  return unwrap(res).draft;
}
