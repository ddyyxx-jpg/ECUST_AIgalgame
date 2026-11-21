/**
 * 开局剧本与 NPC 公开字段的 HTTP 层（docs/03 §5.2.6）。
 *
 * 文案与身份都是内容数据（`content/scenarios/{openings,npcs}.json`），由服务端
 * `GET /api/v1/scenarios` 下发；这里只保留类型与请求，不在前端硬编码任何开局文本（issue #3）。
 * 该端点的 npcs 只含 id/appearance；完整档案走房间图鉴 /gallery（issue #54）。
 * 拉不到时调用方降级为「无预设开局」。
 */
import { request, unwrap } from "./http.ts";
import type { SuggestionInput } from "./candidates.ts";

export interface Scenario {
  id: string;
  name: string;
  /** 一句话身份，显示在剧情页与图鉴页头 */
  role: string;
  /** 一句话诱惑（标题页卡片上的副标题） */
  tagline: string;
  /** 开场正文，按段落 */
  opening: string[];
  /** 第一条建议行动（旧字段，保留兼容） */
  hint: string;
  /**
   * 开局的快捷行动建议：点一下就等于说出这句话（issue #139）。
   * 新内容是 `{text, kind}`；旧字符串仍可读，展示层回退到 action。
   */
  suggestions?: SuggestionInput[];
}

/**
 * `/api/v1/scenarios` 的 npcs 只有公开字段（id + appearance），够地图气泡/占位名用。
 * 完整档案（role/traits/line/mutter）只在房间图鉴 /gallery 且 met=true 时下发（issue #54），
 * 因此这里不再提供“拉 NPC 档案”的函数——标题页/开局页读不到档案。
 */
export interface PublicNpcEntry {
  id: string;
  appearance?: string;
}

/** 服务端同时下发开局列表与 NPC 公开字段 */
export async function fetchScenarios(): Promise<Scenario[]> {
  const res = await request<{ openings: Scenario[] }>("scenarios", "/api/v1/scenarios");
  return unwrap(res).openings;
}
