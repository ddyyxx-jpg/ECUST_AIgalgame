import { describe, expect, it } from "vitest";
import { OpenAiCompatClient } from "./client.ts";

type Body = Record<string, unknown>;

function capture(): { bodies: Body[]; fetchImpl: typeof fetch } {
  const bodies: Body[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Body);
    return new Response(
      JSON.stringify({
        id: "trace-1",
        model: "served-model",
        choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

const base = { baseUrl: "http://llm.example/v1", model: "default-model", apiKey: "k" };

describe("按用途路由（LlmRequest.purpose）", () => {
  it("命中路由：换模型、温度、超时，extra 透传", async () => {
    const { bodies, fetchImpl } = capture();
    const client = new OpenAiCompatClient({
      ...base,
      timeoutMs: 5_000,
      routes: {
        decision: { model: "decision-model", temperature: 0.2, timeoutMs: 30_000, extra: { reasoning_effort: "low" } },
      },
      fetchImpl,
    });
    await client.chat({ purpose: "decision", json: true, messages: [{ role: "user", content: "hi" }] });
    const body = bodies[0]!;
    expect(body.model).toBe("decision-model");
    expect(body.temperature).toBe(0.2);
    expect(body.reasoning_effort).toBe("low");
  });

  it("maxTokens 是下限：调用方更大时保留调用方的值", async () => {
    const { bodies, fetchImpl } = capture();
    const client = new OpenAiCompatClient({ ...base, routes: { conversation: { maxTokens: 600 } }, fetchImpl });
    await client.chat({ purpose: "conversation", maxTokens: 1600, messages: [{ role: "user", content: "a" }] });
    await client.chat({ purpose: "conversation", maxTokens: 200, messages: [{ role: "user", content: "b" }] });
    expect(bodies[0]!.max_tokens).toBe(1600);
    expect(bodies[1]!.max_tokens).toBe(600);
  });

  it("没有 purpose 或没有路由时不改模型/预算", async () => {
    const { bodies, fetchImpl } = capture();
    const client = new OpenAiCompatClient({ ...base, routes: { turn: { model: "turn-model" } }, fetchImpl });
    await client.chat({ maxTokens: 900, messages: [{ role: "user", content: "x" }] });
    await client.chat({ purpose: "canonize", maxTokens: 700, messages: [{ role: "user", content: "y" }] });
    expect(bodies[0]!.model).toBe("default-model");
    expect(bodies[0]!.max_tokens).toBe(900);
    expect(bodies[1]!.model).toBe("default-model");
    expect(bodies[1]!.max_tokens).toBe(700);
  });

  it("路由的 model 为空串时回落到默认模型", async () => {
    const { bodies, fetchImpl } = capture();
    const client = new OpenAiCompatClient({ ...base, routes: { turn: { model: "  " } }, fetchImpl });
    await client.chat({ purpose: "turn", messages: [{ role: "user", content: "z" }] });
    expect(bodies[0]!.model).toBe("default-model");
  });
});
