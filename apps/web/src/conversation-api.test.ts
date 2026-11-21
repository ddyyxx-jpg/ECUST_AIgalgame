import { afterEach, describe, expect, it, vi } from "vitest";
import {
  conversationModesPath,
  conversationProbePath,
  conversationTurnPath,
  convModeAfterProbe,
  detectConversation,
  dispatchConversationEvent,
  fetchUtteranceModes,
  isConversationAvailable,
  runConversationTurn,
  runConversationUtterance,
  validateUtteranceDraft,
} from "./conversation-api.ts";
import type { ConversationStreamHandlers } from "./conversation-api.ts";

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

describe("feature detect（纯判定 + 探测退化）", () => {
  it("只有 2xx 算可用；404/405/401/403/5xx 一律退化", () => {
    expect(isConversationAvailable(200)).toBe(true);
    expect(isConversationAvailable(204)).toBe(true);
    for (const s of [301, 401, 403, 404, 405, 500, 501]) expect(isConversationAvailable(s)).toBe(false);
  });

  it("路径不猜错：探 conversation，回合走 conversation/turns", () => {
    expect(conversationProbePath("room 1")).toBe("/api/v1/rooms/room%201/conversation");
    expect(conversationTurnPath("room_1")).toBe("/api/v1/rooms/room_1/conversation/turns");
    expect(conversationModesPath("room_1")).toBe("/api/v1/rooms/room_1/conversation/modes");
  });

  it("探测三态：2xx→true；404/405→false（明确非 v2）；网络异常/5xx/401→null（无法判定）", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockRejectedValueOnce(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await detectConversation("r1")).toBe(true);
    expect(await detectConversation("r1")).toBe(false);
    expect(await detectConversation("r1")).toBe(false);
    expect(await detectConversation("r1")).toBeNull();
    expect(await detectConversation("r1")).toBeNull();
    expect(await detectConversation("r1")).toBeNull();
  });

  it("convModeAfterProbe：null 保持现有模式，不把 v2 误打回 v1", () => {
    expect(convModeAfterProbe(true)).toBe("v2");
    expect(convModeAfterProbe(false)).toBe("v1");
    expect(convModeAfterProbe(null)).toBeNull();
  });
});

describe("dispatchConversationEvent", () => {
  it("正常事件进 onEvent；error 事件额外触发 onError 并带 retryable", () => {
    const events: string[] = [];
    const errors: string[] = [];
    const h: ConversationStreamHandlers = {
      onEvent: (ev) => events.push(ev.type),
      onError: (code, _msg, retryable) => errors.push(`${code}:${retryable}`),
    };
    expect(dispatchConversationEvent('{"type":"conversation.utterance"}', h)).toBe(true);
    expect(dispatchConversationEvent('{"type":"conversation.error","code":"E_STORE_FAULT","message":"m","retryable":true}', h)).toBe(true);
    expect(events).toEqual(["conversation.utterance", "conversation.error"]);
    expect(errors).toEqual(["E_STORE_FAULT:true"]);
  });

  it("坏 JSON / 非 conversation 事件被忽略，不抛错", () => {
    const h: ConversationStreamHandlers = { onEvent: () => { throw new Error("should not fire"); } };
    expect(dispatchConversationEvent("not json", h)).toBe(false);
    expect(dispatchConversationEvent('{"type":"turn.commit"}', h)).toBe(false);
  });
});

describe("runConversationTurn 结局判定", () => {
  it("committed：不触发 onUnconfirmed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      'event: conversation.committed\ndata: {"type":"conversation.committed","sessionId":"s","turn":1,"proposals":[],"state":{}}\n\n',
    ])));
    const calls: string[] = [];
    await runConversationTurn("r", "plr", "hi", "ct1", {
      onEvent: (ev) => calls.push(ev.type),
      onUnconfirmed: () => calls.push("unconfirmed"),
    });
    expect(calls).toEqual(["conversation.committed"]);
  });

  it("error：透传 code 与 retryable，不触发 onUnconfirmed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      'event: conversation.error\ndata: {"type":"conversation.error","sessionId":"s","code":"E_LLM_TIMEOUT","message":"慢","retryable":true}\n\n',
    ])));
    const calls: string[] = [];
    await runConversationTurn("r", "plr", "hi", "ct2", {
      onError: (code, _m, retryable) => calls.push(`${code}:${retryable}`),
      onUnconfirmed: () => calls.push("unconfirmed"),
    });
    expect(calls).toEqual(["E_LLM_TIMEOUT:true"]);
  });

  it("EOF 无 committed/error → onUnconfirmed（交给上层核对，不盲目重发）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      'event: conversation.utterance\ndata: {"type":"conversation.utterance","delivery":{"to":"plr"}}\n\n',
    ])));
    const calls: string[] = [];
    await runConversationTurn("r", "plr", "hi", "ct3", {
      onEvent: (ev) => calls.push(ev.type),
      onUnconfirmed: () => calls.push("unconfirmed"),
    });
    expect(calls).toEqual(["conversation.utterance", "unconfirmed"]);
  });

  it("HTTP 404 拒绝：onError 带服务端 code（探测之外的运行时兜底）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ ok: false, code: "E_CONV_NOT_FOUND", message: "无会话" }),
      { status: 404, headers: { "content-type": "application/json" } },
    )));
    const calls: string[] = [];
    await runConversationTurn("r", "plr", "hi", "ct4", {
      onError: (code, message) => calls.push(`${code}:${message}`),
    });
    expect(calls).toEqual(["E_CONV_NOT_FOUND:无会话"]);
  });
});

describe("validateUtteranceDraft（提交前本地校验，对齐引擎 delivery.ts）", () => {
  const modes = [
    { id: "broadcast", label: "公开说", requiresTarget: false, requiresAction: false, contentless: false, targetPresence: "present" as const },
    { id: "addressed", label: "对某人说", requiresTarget: true, requiresAction: false, contentless: false, targetPresence: "present" as const },
    { id: "whisper", label: "悄悄话", requiresTarget: true, requiresAction: true, contentless: false, targetPresence: "present" as const },
    { id: "signal", label: "不动声色", requiresTarget: true, requiresAction: true, contentless: true, targetPresence: "present" as const },
  ];

  it("P2-1 requiresTarget：没 @ 到目标就拦，有目标则放行", () => {
    expect(validateUtteranceDraft({ mode: "addressed", content: "你好" }, modes).ok).toBe(false);
    expect(validateUtteranceDraft({ mode: "addressed", target: "npc_lin", content: "你好" }, modes).ok).toBe(true);
  });

  it("P2-2 requiresAction：whisper/signal 动作必填，纯空白也拦", () => {
    expect(validateUtteranceDraft({ mode: "whisper", target: "npc_lin", content: "悄悄话" }, modes).ok).toBe(false);
    expect(validateUtteranceDraft({ mode: "whisper", target: "npc_lin", content: "悄悄话", action: "   " }, modes).ok).toBe(false);
    expect(validateUtteranceDraft({ mode: "whisper", target: "npc_lin", content: "悄悄话", action: "凑近压低声音" }, modes).ok).toBe(true);
  });

  it("P2-3 contentless：正文空不拦、只靠动作即可；有动作才通过", () => {
    expect(validateUtteranceDraft({ mode: "signal", target: "npc_lin" }, modes).ok).toBe(false); // 动作仍必填
    expect(validateUtteranceDraft({ mode: "signal", target: "npc_lin", action: "目光扫过桌面" }, modes).ok).toBe(true);
  });

  it("空 broadcast（正文与动作都空）被拦；仅动作也接受（引擎不强制正文）", () => {
    expect(validateUtteranceDraft({ mode: "broadcast" }, modes).ok).toBe(false);
    expect(validateUtteranceDraft({ mode: "broadcast", action: "点点头" }, modes).ok).toBe(true);
    expect(validateUtteranceDraft({ mode: "broadcast", content: "大家好" }, modes).ok).toBe(true);
  });

  it("未知模式 / 清单未就绪 → 拦，不让它带着坏 mode 发出去", () => {
    expect(validateUtteranceDraft({ mode: "nope", content: "x" }, modes).ok).toBe(false);
    expect(validateUtteranceDraft({ mode: "broadcast", content: "x" }, []).ok).toBe(false);
  });
});

describe("fetchUtteranceModes（说话类型清单）", () => {
  it("200 → 返回 modes 数组；坏结构/失败 → 空数组（不阻断聊天）", async () => {
    const modes = [
      { id: "broadcast", label: "公开说", requiresTarget: false, requiresAction: false, contentless: false, targetPresence: "present" },
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, modes }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockRejectedValueOnce(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchUtteranceModes("r")).toEqual(modes);
    expect(await fetchUtteranceModes("r")).toEqual([]);
    expect(await fetchUtteranceModes("r")).toEqual([]);
  });
});

describe("runConversationUtterance（规范端点 POST body 形状）", () => {
  it("POST 到规范路径，body 带完整 utterance，speaker 由服务端覆盖故客户端不传", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (u: string, init: RequestInit) => {
      url = u;
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return sseResponse([
        'event: conversation.committed\ndata: {"type":"conversation.committed","sessionId":"s","turn":1,"proposals":[],"state":{}}\n\n',
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);
    await runConversationUtterance("r1", "plr", {
      mode: "whisper", target: "npc_lin", content: "你叫什么", action: "凑近压低声音",
    }, "ct-u1", {});
    expect(url).toBe("/api/v1/rooms/r1/conversation");
    expect(body).toEqual({
      actorId: "plr",
      clientTurnId: "ct-u1",
      utterance: { mode: "whisper", target: "npc_lin", content: "你叫什么", action: "凑近压低声音" },
    });
    expect((body.utterance as Record<string, unknown>).speaker).toBeUndefined();
  });
});
