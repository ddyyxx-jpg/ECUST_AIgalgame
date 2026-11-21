/**
 * 群聊会话（v2）的 HTTP/SSE 客户端 + feature detect。
 *
 * 服务端（issue #89）把 ConversationHostV2 挂到 HTTP/SSE：进房时先探
 * GET /api/v1/rooms/:roomId/conversation；探不到（404/5xx/网络异常）一律退回 v1
 * /turns，保证老流程零回归。这里只做传输与事件分发，渲染决策在 conversation-view.ts。
 *
 * demo 追加两条（方案 A）：GET /conversation/modes 取说话类型清单给选择器；
 * runConversationUtterance 走规范端点 POST /conversation 提交完整 utterance（mode/target/content/action）。
 * 旧的 runConversationTurn（兼容别名）保留，老流程零回归。
 */
import type { ConversationEvent } from "../../../packages/shared/src/contract/v2.ts";
import { apiFetch, jsonHeaders } from "./http.ts";
import { parseSsePart, splitSseBuffer } from "./sse.ts";

export function conversationProbePath(roomId: string): string {
  return `/api/v1/rooms/${encodeURIComponent(roomId)}/conversation`;
}

export function conversationTurnPath(roomId: string): string {
  return `/api/v1/rooms/${encodeURIComponent(roomId)}/conversation/turns`;
}

export function conversationModesPath(roomId: string): string {
  return `/api/v1/rooms/${encodeURIComponent(roomId)}/conversation/modes`;
}

/** 只有 2xx 算「v2 可用」；404/405/401/403/5xx 都退回 v1（保守，宁可不接也不坏老流程）。 */
export function isConversationAvailable(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * 探测 v2 会话端点，返回三态（PR #126 三轮复审必做 1）：
 * - true：2xx，v2 可用；
 * - false：404/405，端点明确不存在，明确非 v2；
 * - null：无法判定（网络异常、5xx、401/403 等）——调用方必须保持现有模式，
 *   不能因为一次抖动把已探测/已恢复的 v2 房间误打回 v1。
 */
export async function detectConversation(roomId: string, signal?: AbortSignal): Promise<boolean | null> {
  try {
    const r = await apiFetch(conversationProbePath(roomId), signal ? { signal } : undefined);
    if (r.status >= 200 && r.status < 300) return true;
    if (r.status === 404 || r.status === 405) return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * 探测结果 → 要切换的模式；null = 保持现有模式。
 * 单独成纯函数，是为了让「探测失败不误伤 v2」这条调用点语义可被测试钉住。
 */
export function convModeAfterProbe(probe: boolean | null): "v1" | "v2" | null {
  if (probe === null) return null;
  return probe ? "v2" : "v1";
}

/** 说话类型清单的一条（与 GET /conversation/modes 的返回结构对齐）。 */
export interface UtteranceModeInfo {
  id: string;
  label: string;
  requiresTarget: boolean;
  requiresAction: boolean;
  contentless: boolean;
  targetPresence: "present" | "any";
}

/** 取说话类型清单；失败返回空数组（选择器退化成"无类型"，不阻断聊天）。 */
export async function fetchUtteranceModes(roomId: string, signal?: AbortSignal): Promise<UtteranceModeInfo[]> {
  try {
    const r = await apiFetch(conversationModesPath(roomId), signal ? { signal } : undefined);
    if (!r.ok) return [];
    const body = (await r.json()) as { ok?: boolean; modes?: UtteranceModeInfo[] };
    return Array.isArray(body.modes) ? body.modes : [];
  } catch {
    return [];
  }
}

/**
 * 提交前的本地校验（规则与引擎 delivery.ts 的 validateUtterance 对齐，避免用户第一次点就收到 E_SCHEMA_INVALID）。
 * - requiresTarget：未 @ 到目标 → 拦
 * - requiresAction：whisper/signal 的动作必填 → 拦
 * - contentless：正文会被服务端丢弃，UI 应隐藏正文框；这里不因正文为空而拦
 * - 其余模式：正文与动作都空 → 拦（空 broadcast 是语义空洞的 utterance）
 */
export function validateUtteranceDraft(
  draft: { mode: string; target?: string; content?: string; action?: string },
  modes: UtteranceModeInfo[],
): { ok: boolean; reason?: string } {
  const m = modes.find((x) => x.id === draft.mode);
  if (!m) return { ok: false, reason: "说话类型未就绪，请稍候" };
  const content = (draft.content ?? "").trim();
  const action = (draft.action ?? "").trim();
  if (m.requiresTarget && !draft.target) return { ok: false, reason: "先点一位在场 NPC（此方式需要 @ 目标）" };
  if (m.requiresAction && !action) return { ok: false, reason: "请填写伴随动作" };
  if (!m.contentless && !content && !action) return { ok: false, reason: "请填写说话内容或动作" };
  return { ok: true };
}

export interface ConversationStreamHandlers {
  onEvent?: (ev: ConversationEvent) => void;
  onError?: (code: string, message: string, retryable?: boolean) => void;
  /** 流结束但既没 committed 也没 error：交给调用方按"未确认"处理，不盲目重发 */
  onUnconfirmed?: () => void;
}

/** SSE 事件块 → ConversationEvent；坏 JSON / 未知类型直接忽略，不让一条坏事件断流。 */
export function dispatchConversationEvent(data: string, h: ConversationStreamHandlers): boolean {
  let ev: ConversationEvent;
  try {
    ev = JSON.parse(data) as ConversationEvent;
  } catch {
    return false;
  }
  if (!ev || typeof ev.type !== "string" || !ev.type.startsWith("conversation.")) return false;
  if (ev.type === "conversation.error") h.onError?.(ev.code, ev.message, ev.retryable);
  h.onEvent?.(ev);
  return true;
}

/** POST + 读 SSE 的共用实现：一条会话回合一条流；结局与 v1 runTurn 对齐（commit/error/unconfirmed）。 */
async function postConversationStream(
  path: string,
  body: unknown,
  h: ConversationStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const r = await apiFetch(path, {
    method: "POST",
    headers: { ...jsonHeaders, accept: "text/event-stream" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!r.ok || !r.body) {
    let code = `HTTP_${r.status}`;
    let message = `conversation ${r.status}`;
    try {
      const err = (await r.json()) as { code?: string; message?: string };
      if (err.code) code = err.code;
      if (err.message) message = err.message;
    } catch {
      // 非 JSON 错误体：保留状态码
    }
    h.onError?.(code, message);
    return;
  }

  let settled = false;
  const tracked: ConversationStreamHandlers = {
    ...h,
    onEvent: (ev) => {
      if (ev.type === "conversation.committed" || ev.type === "conversation.error") settled = true;
      h.onEvent?.(ev);
    },
  };
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const { parts, rest } = splitSseBuffer(buf);
      buf = rest;
      for (const part of parts) {
        const parsed = parseSsePart(part);
        if (parsed) dispatchConversationEvent(parsed.data, tracked);
      }
    }
  } catch {
    if (settled || signal?.aborted) return;
    h.onUnconfirmed?.();
    return;
  }
  if (!settled) h.onUnconfirmed?.();
}

/** 兼容别名提交（旧前端/老流程）：{actorId, input, clientTurnId, targetNpcId}。 */
export async function runConversationTurn(
  roomId: string,
  actorId: string,
  input: string,
  clientTurnId: string,
  h: ConversationStreamHandlers,
  signal?: AbortSignal,
  targetNpcId?: string,
): Promise<void> {
  await postConversationStream(
    conversationTurnPath(roomId),
    { actorId, input, clientTurnId, ...(targetNpcId ? { targetNpcId } : {}) },
    h,
    signal,
  );
}

/** 用户在选择器里填的一条说话/行动内容（mode 来自 GET /conversation/modes）。 */
export interface UtteranceDraft {
  mode: string;
  target?: string;
  content?: string;
  action?: string;
}

/**
 * 规范端点提交：把完整 utterance（mode/target/content/action）发给 POST /conversation。
 * speaker 由服务端按 guardRoom 绑定的 actorId 覆盖，客户端不传；id 缺省由服务端补。
 */
export async function runConversationUtterance(
  roomId: string,
  actorId: string,
  draft: UtteranceDraft,
  clientTurnId: string,
  h: ConversationStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const utterance: Record<string, string | string[]> = { mode: draft.mode };
  if (draft.target) utterance.target = draft.target;
  if (draft.content) utterance.content = draft.content;
  if (draft.action) utterance.action = draft.action;
  await postConversationStream(
    `/api/v1/rooms/${encodeURIComponent(roomId)}/conversation`,
    { actorId, clientTurnId, utterance },
    h,
    signal,
  );
}
