/**
 * 微信私信的 HTTP/SSE 传输层。只负责发请求与解析字节流，
 * 去重/可见性/防抖等规则都在 inbox.ts 的纯函数里。
 * 与 api.ts 分开，避免主入口继续膨胀（AGENTS.md §6：文件 ≤ 300 行）。
 */
import type { GossipEvent, MessageRecord } from "../../../packages/shared/src/contract/v2.ts";
import { apiFetch, GameError, httpErrorFrom, jsonHeaders } from "./http.ts";
import { parseGossipMessageEvent } from "./inbox.ts";
import { parseSsePart, splitSseBuffer } from "./sse.ts";

// #106：roomId 同 actorId 一样做 URI 编码，避免房间名里的 / ? # 破坏路径/查询串
const inboxPath = (roomId: string, actorId: string): string =>
  `/api/v1/rooms/${encodeURIComponent(roomId)}/messages?actorId=${encodeURIComponent(actorId)}`;

/** 403 会抛 HttpError(status=403)，由 UI 调 inboxLoadNotice 给降级提示，不当网络错误重试 */
export async function fetchInbox(roomId: string, actorId: string): Promise<MessageRecord[]> {
  const r = await apiFetch(inboxPath(roomId, actorId));
  if (!r.ok) throw await httpErrorFrom(r, "inbox");
  const d = (await r.json()) as { ok?: boolean; messages?: unknown; code?: string; message?: string };
  if (d.ok === false) throw new GameError(d.code ?? "E_UNKNOWN", d.message ?? "收件箱加载失败");
  return Array.isArray(d.messages) ? (d.messages as MessageRecord[]) : [];
}

export type SendOutcome =
  | { ok: true; events: GossipEvent[] }
  | { ok: false; code: string; message: string };

/**
 * 发一条私信。业务拒绝走 HTTP 200 + {ok:false, code}（gossip.error），
 * 这里返回判别的失败结果，让 UI 对 E_CONTENT_BLOCKED / E_AUDIT_UNAVAILABLE 给可见提示。
 * replyTo 随 body 下发：当前服务端路由尚未转发该字段，但前端交互必须先带它（待服务端补齐）。
 */
export async function postMessage(
  roomId: string,
  from: string,
  to: string,
  content: string,
  replyTo?: string,
): Promise<SendOutcome> {
  const r = await apiFetch(`/api/v1/rooms/${encodeURIComponent(roomId)}/messages`, {
    method: "POST",
    headers: { ...jsonHeaders },
    body: JSON.stringify({ from, to, content, ...(replyTo ? { replyTo } : {}) }),
  });
  if (!r.ok) {
    const err = await httpErrorFrom(r, "send message");
    return { ok: false, code: err.code ?? `HTTP_${err.status}`, message: err.message };
  }
  const d = (await r.json()) as { ok?: boolean; events?: unknown; code?: string; message?: string };
  if (d.ok === false) {
    return { ok: false, code: d.code ?? "E_UNKNOWN", message: d.message ?? "发送失败" };
  }
  return { ok: true, events: Array.isArray(d.events) ? (d.events as GossipEvent[]) : [] };
}

export interface InboxStreamHandlers {
  onMessage: (message: MessageRecord) => void;
  /** SSE 也做 actorId 鉴权：403 说明身份错了，UI 必须停止重连并降级 */
  onForbidden?: () => void;
}

/**
 * 单次 SSE 连接：读到 EOF/断流就返回，由调用方决定重连。
 * 断线重连的服务端重放由 inbox.ts 的 id 去重兜底，这里不做状态去重。
 */
export async function streamInbox(
  roomId: string,
  actorId: string,
  h: InboxStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const r = await apiFetch(`/api/v1/rooms/${encodeURIComponent(roomId)}/messages/stream?actorId=${encodeURIComponent(actorId)}`, {
    headers: { accept: "text/event-stream" },
    ...(signal ? { signal } : {}),
  });
  if (!r.ok) {
    if (r.status === 403) h.onForbidden?.();
    // 其它错误（含 5xx/断网）交给调用方按退避重连，不把 SSE 失败当致命错误
    return;
  }
  if (!r.body) return;
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const { parts, rest } = splitSseBuffer(buf);
      buf = rest;
      for (const part of parts) {
        const parsed = parseSsePart(part);
        // 心跳（": ping"）没有 data，parseSsePart 返回 null；只认 gossip.message
        if (!parsed || parsed.event !== "gossip.message") continue;
        const msg = parseGossipMessageEvent(parsed.data);
        if (msg) h.onMessage(msg);
      }
    }
  } catch {
    // 断流/主动 abort 都正常返回；由调用方按 signal 决定是否重连
  }
}
