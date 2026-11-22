import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageRecord } from "../../../packages/shared/src/contract/v2.ts";
import { fetchInbox, postMessage, streamInbox } from "./api-messages.ts";
import { HttpError } from "./http.ts";

afterEach(() => vi.unstubAllGlobals());

function rec(id: string, seq: number): MessageRecord {
  return {
    id,
    roomId: "room_1",
    from: "plr_me",
    to: "npc_lin",
    kind: "player",
    content: "你好",
    hop: 0,
    confidence: 1,
    visibility: "private",
    createdAt: 1_700_000_000_000 + seq,
    seq,
  };
}

function sseResponse(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(new TextEncoder().encode(c));
      ctrl.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

describe("收件箱 HTTP 层", () => {
  it("GET 403 抛 HttpError(403)，UI 据此降级而不是当网络错误重试", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: false, code: "E_FORBIDDEN", message: "forbidden" }), { status: 403 })),
    );
    await expect(fetchInbox("room_1", "plr_other")).rejects.toMatchObject({ status: 403 });
  });

  it("GET 正常返回 messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, messages: [rec("m1", 1)] }), { status: 200 })));
    expect((await fetchInbox("room_1", "plr_me")).map((m) => m.id)).toEqual(["m1"]);
  });

  it("#106：roomId 含 / ? # 等字符时三条路径均被 URI 编码", async () => {
    const spy = vi.fn(async (_path: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", spy);
    const room = "room/a?b#c";
    await fetchInbox(room, "plr_me");
    expect(spy.mock.calls[0]![0]).toBe(`/api/v1/rooms/${encodeURIComponent(room)}/messages?actorId=plr_me`);
    await postMessage(room, "plr_me", "npc_lin", "你好");
    expect(spy.mock.calls[1]![0]).toBe(`/api/v1/rooms/${encodeURIComponent(room)}/messages`);
    await streamInbox(room, "plr_me", { onMessage: () => undefined });
    expect(spy.mock.calls[2]![0]).toBe(`/api/v1/rooms/${encodeURIComponent(room)}/messages/stream?actorId=plr_me`);
  });

  it("POST 200 + ok:false 透传 E_CONTENT_BLOCKED，不当成功", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: false, code: "E_CONTENT_BLOCKED", message: "blocked" }), { status: 200 })),
    );
    expect(await postMessage("room_1", "plr_me", "npc_lin", "坏内容")).toMatchObject({ ok: false, code: "E_CONTENT_BLOCKED" });
  });

  it("POST 成功返回事件，并把 replyTo 放进请求体", async () => {
    const spy = vi.fn(async (_path: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, events: [{ type: "gossip.committed", ids: [] }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", spy);
    const outcome = await postMessage("room_1", "plr_me", "npc_lin", "你好", "m0");
    expect(outcome.ok).toBe(true);
    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string) as { replyTo?: string };
    expect(body.replyTo).toBe("m0");
  });
});

describe("收件箱 SSE 层", () => {
  it("只分发 gossip.message，忽略心跳和其它事件", async () => {
    const chunks = [
      ": ping\n\n",
      'event: gossip.committed\ndata: {"type":"gossip.committed","ids":[]}\n\n',
      `event: gossip.message\ndata: ${JSON.stringify({ type: "gossip.message", message: rec("m1", 1) })}\n\n`,
    ];
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(chunks)));
    const got: string[] = [];
    await streamInbox("room_1", "plr_me", { onMessage: (m) => got.push(m.id) });
    expect(got).toEqual(["m1"]);
  });

  it("SSE 403 调用 onForbidden，不抛错（UI 停止重连并降级）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("forbidden", { status: 403 })));
    const onForbidden = vi.fn();
    await expect(streamInbox("room_1", "plr_other", { onMessage: () => undefined, onForbidden })).resolves.toBeUndefined();
    expect(onForbidden).toHaveBeenCalledOnce();
  });

  it("SSE 5xx 静默返回，交给调用方退避重连", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("oops", { status: 500 })));
    const onForbidden = vi.fn();
    await streamInbox("room_1", "plr_me", { onMessage: () => undefined, onForbidden });
    expect(onForbidden).not.toHaveBeenCalled();
  });

  it("非 403 的 GET 错误仍是普通 HttpError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("oops", { status: 500 })));
    await expect(fetchInbox("room_1", "plr_me")).rejects.toBeInstanceOf(HttpError);
  });
});
