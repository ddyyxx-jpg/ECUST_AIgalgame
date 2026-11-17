/**
 * 开局剧本的 HTTP 层（docs/03 §5.2.6）。
 *
 * 文案与身份都是内容数据（`content/scenarios/openings.json`），由服务端 `GET /api/v1/scenarios` 下发；
 * 这里只保留类型与请求，不在前端硬编码任何开局文本（issue #3）。拉不到时调用方降级为「无预设开局」。
 */
import { request, unwrap } from "./http.ts";

export interface Scenario {
  id: string;
  name: string;
  /** 一句话身份，显示在剧情页与图鉴页头 */
  role: string;
  /** 一句话诱惑（标题页卡片上的副标题） */
  tagline: string;
  /** 开场正文，按段落 */
  opening: string[];
  /** 第一条建议行动 */
  hint: string;
}

/** 服务端同时下发 NPC 公开档案（图鉴端点自己拼装），标题页只需要开局列表 */
export async function fetchScenarios(): Promise<Scenario[]> {
  const res = await request<{ openings: Scenario[] }>("scenarios", "/api/v1/scenarios");
  return unwrap(res).openings;
}
