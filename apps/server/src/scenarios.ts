/**
 * 开局剧本与 NPC 公开档案 —— 内容数据（content/scenarios/*.json），不是代码。
 *
 * 为什么放 content：开局文案/身份/NPC 档案都是"内容"，改它们不该动前端代码（AGENTS I3 / issue #3）。
 * 文件缺失或校验失败时降级为空表：前端显示「无预设开局」，但不能因为内容文件坏了把服务拖死。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const ScenarioSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** 一句话身份，显示在剧情页与图鉴页头 */
  role: z.string().min(1),
  /** 一句话诱惑（标题页卡片上的副标题） */
  tagline: z.string(),
  /** 开场正文，按段落 */
  opening: z.array(z.string().min(1)).min(1),
  /** 第一条建议行动 */
  hint: z.string(),
  /** 开局的快捷行动建议（可选）：点一下等于说出这句话；缺省时前端退回 hint */
  suggestions: z.array(z.string().min(1)).optional(),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

/** 图鉴用的公开人物档案；id 与房间内 npc 实体 id 对齐 */
export const NpcProfileSchema = z.object({
  id: z.string().min(1),
  role: z.string(),
  traits: z.array(z.string()),
  line: z.string(),
  /** 大地图头顶气泡的一句台词（可选）：够读出这个人此刻的态度 */
  mutter: z.string().optional(),
  /**
   * 外貌描述（可选）：玩家还不知道名字时，地图/对话里的占位名用它
   * （"穿白衬衫、袖口别着校徽的男生"）。只允许写外观，不要写身份/姓名，否则等于泄露档案。
   */
  appearance: z.string().optional(),
});
export type NpcProfile = z.infer<typeof NpcProfileSchema>;

/**
 * `GET /api/v1/scenarios` 对外只暴露公开字段（地图气泡/占位名够用，issue #54）。
 * 完整档案（role/traits/line/mutter）只在房间图鉴 `/gallery` 且 met=true 时下发。
 */
export interface PublicNpcEntry {
  id: string;
  appearance?: string;
}

/** 下发前收窄为公开字段：绝不把角色档案带出这个全局公开端点 */
export function toPublicNpcEntries(npcs: NpcProfile[]): PublicNpcEntry[] {
  return npcs.map((npc) => ({
    id: npc.id,
    ...(npc.appearance !== undefined ? { appearance: npc.appearance } : {}),
  }));
}

export interface ScenarioCatalog {
  openings: Scenario[];
  npcs: NpcProfile[];
}

export const EMPTY_SCENARIOS: ScenarioCatalog = { openings: [], npcs: [] };

/** npcId → 外貌描述（未认识时的占位名用；缺省则由视图层退回「第N位陌生的同学」） */
export function appearanceById(catalog: ScenarioCatalog): Map<string, string> {
  const map = new Map<string, string>();
  for (const npc of catalog.npcs) {
    const text = npc.appearance?.trim();
    if (text) map.set(npc.id, text);
  }
  return map;
}

/** 可选 JSON：不存在/解析失败都当"没有"（与 bootstrap 的 readOptionalJson 同口径） */
async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 读 <contentDir>/scenarios/{openings,npcs}.json。
 * 校验失败不抛错（内容坏了只是没预设，服务仍然可玩），但要在日志里留下原因。
 */
export async function loadScenarios(dir: string): Promise<ScenarioCatalog> {
  const [openingsRaw, npcsRaw] = await Promise.all([
    readJson(path.join(dir, "openings.json")),
    readJson(path.join(dir, "npcs.json")),
  ]);
  const openings = z.array(ScenarioSchema).safeParse(openingsRaw);
  const npcs = z.array(NpcProfileSchema).safeParse(npcsRaw);
  if (!openings.success) console.warn(`[scenarios] openings.json 校验失败，降级为空：${openings.error.message}`);
  if (!npcs.success) console.warn(`[scenarios] npcs.json 校验失败，降级为空：${npcs.error.message}`);
  return {
    openings: openings.success ? openings.data : [],
    npcs: npcs.success ? npcs.data : [],
  };
}
