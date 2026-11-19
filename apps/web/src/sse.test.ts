import { afterEach, describe, expect, it, vi } from "vitest";
import { runTurn } from "./api.ts";
import type { TurnStreamHandlers } from "./api.ts";
import { parseSsePart, splitSseBuffer } from "./sse.ts";

afterEach(() => vi.unstubAllGlobals());

const enc = new TextEncoder();

function sseResponse(chunks: string[], opts: { errorAfter?: boolean } = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      if (opts.errorAfter) controller.error(new Error("connection reset"));
      else controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function stubFetch(res: Response): void {
  vi.stubGlobal("fetch", vi.fn(async () => res));
}

function handlers(): TurnStreamHandlers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    onCommit: (seq) => calls.push(`commit:${seq}`),
    onError: (code) => calls.push(`error:${code}`),
    onUnconfirmed: (id) => calls.push(`unconfirmed:${id}`),
  };
}

describe("SSE 解析（纯函数）", () => {
  it("按空行切块，不完整段留回缓冲", () => {
    const { parts, rest } = splitSseBuffer("event: a\ndata: 1\n\nevent: b\ndata: 2");
    expect(parts).toEqual(["event: a\ndata: 1"]);
    expect(rest).toBe("event: b\ndata: 2");
  });

  it("多行 data 合并；无 data 的块返回 null", () => {
    expect(parseSsePart("event: turn.delta\ndata: {\"a\":\ndata: 1}")).toEqual({
      event: "turn.delta",
      data: '{"a":\n1}',
    });
    expect(parseSsePart(": heartbeat")).toBeNull();
  });
});

describe("runTurn 结局判定（commit / error / unconfirmed）", () => {
  it("有 turn.commit：不触发 onUnconfirmed", async () => {
    stubFetch(sseResponse(['event: turn.commit\ndata: {"type":"turn.commit","turnId":"t1","seq":5}\n\n']));
    const h = handlers();
    await runTurn("room_x", "plr_x", "输入", "ct1", h);
    expect(h.calls).toEqual(["commit:5"]);
  });

  it("有 turn.error：不触发 onUnconfirmed", async () => {
    stubFetch(sseResponse(['event: turn.error\ndata: {"type":"turn.error","code":"E_LLM_FORMAT","message":"m"}\n\n']));
    const h = handlers();
    await runTurn("room_x", "plr_x", "输入", "ct1", h);
    expect(h.calls).toEqual(["error:E_LLM_FORMAT"]);
  });

  it("EOF 只有 delta（无 commit/error）：onUnconfirmed 带 clientTurnId", async () => {
    stubFetch(sseResponse(['event: turn.delta\ndata: {"type":"turn.delta","field":"narrative","text":"半截"}\n\n']));
    const h = handlers();
    await runTurn("room_x", "plr_x", "输入", "ct9", h);
    expect(h.calls).toEqual(["unconfirmed:ct9"]);
  });

  it("中途断流（reader 抛错）：同样按未确认处理", async () => {
    stubFetch(sseResponse(['event: turn.accepted\ndata: {"type":"turn.accepted","turnId":"t1"}\n\n'], { errorAfter: true }));
    const h = handlers();
    await runTurn("room_x", "plr_x", "输入", "ct2", h);
    expect(h.calls).toEqual(["unconfirmed:ct2"]);
  });

  it("主动中止（切房间）：不再上报未确认", async () => {
    stubFetch(sseResponse(["event: turn.accepted\ndata: {\"type\":\"turn.accepted\",\"turnId\":\"t1\"}\n\n"], { errorAfter: true }));
    const h = handlers();
    const controller = new AbortController();
    controller.abort();
    await runTurn("room_x", "plr_x", "输入", "ct3", h, controller.signal);
    expect(h.calls).toEqual([]);
  });

  it("HTTP 429 拒绝：透传服务端错误码 E_RATE_LIMITED", async () => {
    stubFetch(new Response(JSON.stringify({ ok: false, code: "E_RATE_LIMITED", message: "今日额度已用完" }), { status: 429 }));
    const h = handlers();
    await runTurn("room_x", "plr_x", "输入", "ct4", h);
    expect(h.calls).toEqual(["error:E_RATE_LIMITED"]);
  });

  it("HTTP 409 已提交冲突：透传 E_PRECONDITION（由调用方核对）", async () => {
    stubFetch(new Response(JSON.stringify({ ok: false, code: "E_PRECONDITION", message: "已提交", committedSeq: 7 }), { status: 409 }));
    const h = handlers();
    await runTurn("room_x", "plr_x", "输入", "ct5", h);
    expect(h.calls).toEqual(["error:E_PRECONDITION"]);
  });
});