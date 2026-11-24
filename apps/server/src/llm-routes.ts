/**
 * 按用途的模型/预算配置（`content/llm/routes.json`）。
 *
 * 为什么放内容目录而不是塞进环境变量：一个部署经常是「叙事用 A 模型、后台总结用 B 模型、
 * 思考型模型要给更长的超时」，这是运营决策，改完不该重新编译；baseURL / key 仍然是环境变量
 * （不进仓库、不进日志）。路由只调参：解析失败一律降级为「不覆盖」并告警，不让叙事链路起不来。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LlmPurpose } from "../../../packages/shared/src/index.ts";
import type { LlmRoute } from "../../../packages/llm/src/index.ts";

const RouteSchema = z
  .object({
    model: z.string().min(1).optional(),
    /** max_tokens 下限：调用方传得更大时保留调用方的值（截断重试要靠它放大） */
    maxTokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    timeoutMs: z.number().int().positive().optional(),
    /** 透传给厂商的额外请求字段（如 reasoning_effort） */
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const FileSchema = z
  .object({
    schemaVersion: z.literal(1),
    routes: z
      .object({
        turn: RouteSchema.optional(),
        conversation: RouteSchema.optional(),
        decision: RouteSchema.optional(),
        canonize: RouteSchema.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export type LlmRoutes = Partial<Record<LlmPurpose, LlmRoute>>;

export interface LlmRoutesDeps {
  warn?: (message: string) => void;
  log?: (message: string) => void;
}

/** 缺文件 = 不覆盖；坏数据 = 告警 + 不覆盖（路由只调参，坏配置不值得让服务起不来） */
export async function loadLlmRoutes(
  contentDir: string,
  deps: LlmRoutesDeps = {},
): Promise<LlmRoutes | undefined> {
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const log = deps.log ?? ((message: string) => console.log(message));
  const file = path.join(contentDir, "llm", "routes.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      warn(`[llm] 读取 ${file} 失败：${errorText(err)}，本次使用默认模型/预算`);
    }
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn(`[llm] ${file} 不是合法 JSON：${errorText(err)}，本次使用默认模型/预算`);
    return undefined;
  }
  const result = FileSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    warn(
      `[llm] ${file} 校验失败（${issue?.path.join(".") || "?"}）：${issue?.message ?? "未知错误"}，本次使用默认模型/预算`,
    );
    return undefined;
  }
  const routes = result.data.routes as LlmRoutes;
  const active = Object.entries(routes).filter(([, value]) => Object.keys(value ?? {}).length > 0);
  if (active.length === 0) return undefined;
  log(
    `[llm] 按用途路由已加载：${active
      .map(([purpose, route]) => `${purpose}→${route?.model ?? "默认模型"}/max_tokens≥${route?.maxTokens ?? "-"}`)
      .join("，")}`,
  );
  return routes;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
