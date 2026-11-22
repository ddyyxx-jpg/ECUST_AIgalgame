/**
 * OpenAI 兼容网关（URL: {baseUrl}/chat/completions）。
 *
 * 只依赖 Node 22 内置 fetch，不引 SDK：换 provider 只改 baseUrl/model 即可。
 * 错误约定见 docs/03-接口总表.md §7：可重试的码都在 shared 的 RETRYABLE 里。
 */
import {
  RETRYABLE,
  type ErrorCode,
  type LlmMessage,
  type LlmPort,
  type LlmRequest,
  type LlmResult,
  type Usage,
} from "../../shared/src/index.ts";
import { safeParseJson } from "./json.ts";

export class LlmError extends Error {
  readonly code: ErrorCode;
  /** 由 shared 的 RETRYABLE 派生，避免两处各写一份白名单 */
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    this.retryable = RETRYABLE.includes(code);
  }
}

export function isLlmError(err: unknown): err is LlmError {
  return err instanceof LlmError;
}

export interface OpenAiCompatConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  /** 默认 15s；单回合 LLM 调用超过它就没有体验价值了 */
  timeoutMs?: number;
  /** 测试注入口；默认 globalThis.fetch，保证不联网也能测 */
  fetchImpl?: typeof fetch;
}

const ENV_KEYS = {
  baseUrl: "GALGAME_LLM_BASE_URL",
  model: "GALGAME_LLM_MODEL",
  apiKey: "GALGAME_LLM_API_KEY",
} as const;

const DEFAULT_TIMEOUT_MS = 15_000;
const JSON_NUDGE = "只输出 JSON（json），不要输出任何解释、前后缀或 Markdown 围栏。";

export class OpenAiCompatClient implements LlmPort {
  private readonly baseUrl: string | undefined;
  private readonly model: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenAiCompatConfig = {}) {
    this.baseUrl = trimSlash(config.baseUrl ?? process.env[ENV_KEYS.baseUrl]);
    this.model = config.model ?? process.env[ENV_KEYS.model];
    this.apiKey = config.apiKey ?? process.env[ENV_KEYS.apiKey];
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  async chat(req: LlmRequest): Promise<LlmResult> {
    const baseUrl = this.requireConfig(this.baseUrl, ENV_KEYS.baseUrl);
    const model = this.requireConfig(this.model, ENV_KEYS.model);
    const apiKey = this.requireConfig(this.apiKey, ENV_KEYS.apiKey);
    const wantJson = req.json === true;

    const body: Record<string, unknown> = {
      model,
      messages: withJsonInstruction(req.messages, wantJson),
      stream: false,
    };
    if (wantJson) body.response_format = { type: "json_object" };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let payload: unknown = undefined;
    let headerTraceId: string | undefined;
    try {
      const res = await this.fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (res.status === 429) {
        throw new LlmError("E_RATE_LIMITED", `LLM 限流（HTTP 429）：${await snippet(res)}`);
      }
      // 响应头优先：网关会回 x-request-id / DeepSeek 的 x-ds-trace-id，拿它串日志比 payload.id 可靠
      headerTraceId = res.headers.get("x-request-id") ?? res.headers.get("x-ds-trace-id")
        ?? res.headers.get("x-trace-id") ?? res.headers.get("trace-id") ?? undefined;
      if (!res.ok) {
        // 非 2xx 统一归入可重试的格式错误：网关层没有更细的错误码（见 03 §7）
        throw new LlmError("E_LLM_FORMAT", `LLM 请求失败（HTTP ${res.status}）：${await snippet(res)}`);
      }
      payload = await res.json();
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (controller.signal.aborted) {
        throw new LlmError("E_LLM_TIMEOUT", `LLM 请求超时（${this.timeoutMs}ms）`);
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new LlmError("E_LLM_FORMAT", `LLM 网络错误：${detail}`);
    } finally {
      clearTimeout(timer);
    }

    const content = readContent(payload);
    const usage = readUsage(payload);
    const finishReason = readFinishReason(payload);
    const result: LlmResult = {
      raw: content,
      usage,
      model: readModel(payload) ?? model,
      latencyMs: Date.now() - startedAt,
      finishReason,
      traceId: headerTraceId ?? readTraceId(payload),
    };

    if (wantJson) {
      const parsed = safeParseJson(content);
      if (!parsed.ok) {
        // 先区分"被截断"和"格式不合法"：截断要重试更大的 max_tokens，不能当格式错误
        if (finishReason === "length") {
          throw new LlmError("E_LLM_TRUNCATED", "LLM 输出被 max_tokens 截断");
        }
        // 解析失败也走可重试路径：空 content（U+0020 坑）与半截 JSON 都能靠重试救回
        throw new LlmError(parsed.code, `LLM 未返回合法 JSON：${parsed.message}`);
      }
      result.json = parsed.value;
    }
    return result;
  }

  private requireConfig(value: string | undefined, envKey: string): string {
    if (value === undefined || value.trim() === "") {
      throw new LlmError("E_FORBIDDEN", `LLM 未配置：请设置构造参数或环境变量 ${envKey}`);
    }
    return value;
  }
}

/** json 模式：DeepSeek 要求 prompt 里出现 "json" 并给样例，system 末尾自动补一句。 */
function withJsonInstruction(messages: LlmMessage[], json: boolean): LlmMessage[] {
  if (!json) return messages;
  const copy = messages.map((m) => ({ ...m }));
  const system = copy.find((m) => m.role === "system");
  if (system) {
    system.content = `${system.content}\n${JSON_NUDGE}`;
  } else {
    copy.unshift({ role: "system", content: JSON_NUDGE });
  }
  return copy;
}

function trimSlash(url: string | undefined): string | undefined {
  return url === undefined ? undefined : url.replace(/\/+$/, "");
}

async function snippet(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "<无法读取响应体>";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readContent(payload: unknown): string {
  const data = asRecord(payload);
  const choices = data?.choices;
  const first = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
  const message = asRecord(first?.message);
  const content = message?.content;
  if (typeof content !== "string") {
    throw new LlmError("E_LLM_FORMAT", "LLM 响应缺少 choices[0].message.content");
  }
  return content;
}

function readFinishReason(payload: unknown): string | undefined {
  const choices = asRecord(payload)?.choices;
  const first = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
  const reason = first?.finish_reason;
  return typeof reason === "string" && reason !== "" ? reason : undefined;
}

function readTraceId(payload: unknown): string | undefined {
  const id = asRecord(payload)?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

function readModel(payload: unknown): string | undefined {
  const model = asRecord(payload)?.model;
  return typeof model === "string" && model !== "" ? model : undefined;
}

/** DeepSeek 用 prompt_cache_hit_tokens，OpenAI 风格用 prompt_tokens_details.cached_tokens。 */
function readUsage(payload: unknown): Usage {
  const usage = asRecord(asRecord(payload)?.usage);
  const details = asRecord(usage?.prompt_tokens_details);
  return {
    promptTokens: asNumber(usage?.prompt_tokens) ?? 0,
    completionTokens: asNumber(usage?.completion_tokens) ?? 0,
    cachedTokens: asNumber(usage?.prompt_cache_hit_tokens) ?? asNumber(details?.cached_tokens) ?? undefined,
    calls: 1,
  };
}
