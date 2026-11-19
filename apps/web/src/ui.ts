/** 纯前端展示辅助：只做格式化，不持有任何权威数据。 */
import { httpFailMessage } from "./http.ts";
import type { DraftStatus, MapScene, MapSceneStatus, Phase } from "./api.ts";

export type LineKind = "player" | "narrative" | "npc" | "system" | "fact";

export interface Line {
  id: number;
  kind: LineKind;
  text: string;
}

const PHASE_LABELS: Record<Phase, string> = {
  morning: "早上",
  noon: "中午",
  afternoon: "下午",
  evening: "傍晚",
  night: "夜晚",
};

export function phaseLabel(phase: Phase): string {
  return PHASE_LABELS[phase] ?? phase;
}

const DRAFT_STATUS_LABELS: Record<DraftStatus, string> = {
  pending_review: "待审核",
  approved: "已通过 · 待生成",
  generating: "生成中",
  generated_pending_review: "生成待审核",
  published: "已发布",
  rejected: "已拒绝",
};

export function draftStatusLabel(status: DraftStatus): string {
  return DRAFT_STATUS_LABELS[status] ?? status;
}

export function sceneName(scenes: MapScene[], id: string): string {
  return scenes.find((s) => s.id === id)?.name ?? id;
}

// ---------------------------------------------------------------- 地图状态 / 类别

const SCENE_STATUSES: readonly MapSceneStatus[] = ["built", "under_construction", "planned"];

/**
 * 服务端 MapScene.status 的防御性读取：老服务端（或字段缺失）一律按 built 处理，
 * 避免地图因为一个展示字段缺失就整片不可点。
 */
export function sceneStatus(scene: MapScene): MapSceneStatus {
  const raw = scene.status as unknown;
  return SCENE_STATUSES.includes(raw as MapSceneStatus) ? (raw as MapSceneStatus) : "built";
}

const SCENE_STATUS_LABELS: Record<MapSceneStatus, string> = {
  built: "已建成",
  under_construction: "在建",
  planned: "规划中",
};

export function sceneStatusLabel(scene: MapScene): string {
  return SCENE_STATUS_LABELS[sceneStatus(scene)];
}

/** 非 built 场景在详情里给一句人话解释，不只是灰按钮 */
const SCENE_STATUS_HINTS: Record<MapSceneStatus, string> = {
  built: "",
  under_construction: "在建，暂不可进入",
  planned: "规划中，尚未建成",
};

export function sceneStatusHint(scene: MapScene): string {
  return SCENE_STATUS_HINTS[sceneStatus(scene)];
}

/** 类别是数据侧的英文 key，中文名只属于展示层；未知 key 原样透出 */
const SCENE_CATEGORY_LABELS: Record<string, string> = {
  teaching: "教学",
  lab: "实验",
  dorm: "宿舍",
  food: "餐饮",
  sports: "体育",
  gate: "校门",
  landmark: "地标",
  life: "生活",
  study: "自习",
  admin: "行政",
};

export function categoryLabel(category: string): string {
  const key = (category ?? "").trim().toLowerCase();
  if (!key) return "";
  return SCENE_CATEGORY_LABELS[key] ?? category;
}

export function errorMessage(e: unknown): string {
  return httpFailMessage(e);
}

export function formatTime(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
