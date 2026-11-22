import { describe, expect, it } from "vitest";
import { OpenAiCompatClient } from "./client.ts";

const okBody = (extra: Record<string, unknown> = {}) => JSON.stringify({
  id: "payload-id",
  model: "test-model",
  choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  ...extra,
});

describe("OpenAiCompatClient traceId（审阅 P3）", () => {
  it("两个响应头同时存在时优先 DeepSeek 的 x-ds-trace-id（#146）", async () => {
    const client = new OpenAiCompatClient({
      baseUrl: "https://example.invalid", model: "m", apiKey: "k",
      fetchImpl: async () => new Response(okBody(), {
        status: 200,
        headers: { "x-request-id": "req-123", "x-ds-trace-id": "ds-456" },
      }),
    });
    const r = await client.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(r.traceId).toBe("ds-456");
  });

  it("只有响应头 x-request-id 时用它兜底", async () => {
    const client = new OpenAiCompatClient({
      baseUrl: "https://example.invalid", model: "m", apiKey: "k",
      fetchImpl: async () => new Response(okBody(), { status: 200, headers: { "x-request-id": "req-123" } }),
    });
    const r = await client.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(r.traceId).toBe("req-123");
  });

  it("支持 DeepSeek 网关的 x-ds-trace-id", async () => {
    const client = new OpenAiCompatClient({
      baseUrl: "https://example.invalid", model: "m", apiKey: "k",
      fetchImpl: async () => new Response(okBody(), { status: 200, headers: { "x-ds-trace-id": "ds-456" } }),
    });
    const r = await client.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(r.traceId).toBe("ds-456");
  });

  it("没有响应头时退回 payload.id", async () => {
    const client = new OpenAiCompatClient({
      baseUrl: "https://example.invalid", model: "m", apiKey: "k",
      fetchImpl: async () => new Response(okBody(), { status: 200 }),
    });
    const r = await client.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(r.traceId).toBe("payload-id");
  });
});
