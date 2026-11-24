/** @galgame/llm —— 唯一允许接触外部模型的服务端出口（模块只拿 ctx.llm 端口）。 */
export { OpenAiCompatClient, LlmError, isLlmError } from "./client.ts";
export type { LlmRoute, OpenAiCompatConfig } from "./client.ts";
export { withRetry, isRetryableError } from "./retry.ts";
export type { RetryOptions } from "./retry.ts";
export { MockLlm } from "./mock.ts";
export type { MockLlmOptions } from "./mock.ts";
export { safeParseJson } from "./json.ts";
export type { JsonParseResult, JsonParseSuccess, JsonParseFailure } from "./json.ts";
