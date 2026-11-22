/** 共享的 HTTP 小工具：统一错误分类与响应拆包（见 docs/06 §4）。 */

export const jsonHeaders = { "content-type": "application/json" };

/** 游戏层拒绝：HTTP 200 + `{ok:false, code, message}`（见 docs/06 §4） */
export class GameError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GameError";
    this.code = code;
  }
}

/** 传输层错误：非 2xx 状态 + 服务端错误码（响应体里有就带上），供 UI 分类提示 */
export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

type ApiFail = { ok: false; code: string; message: string };
export type Resp<T> = ({ ok: true } & T) | ApiFail;

/**
 * 本地访客身份（仅 AUTH_REQUIRED=0 的开发部署）：X-User-Id 是"哪份记忆档案"的键，
 * 不是凭据——强制登录模式下服务端只认 Cookie，会忽略这个头。
 */
let visitorId: string | null = null;
export function setVisitorId(id: string | null): void {
  visitorId = id;
}

import { TimeoutError } from "./timeout.ts";

type ApiInit = Omit<RequestInit, "headers"> & { headers?: Record<string, string> };

/**
 * 所有请求统一入口：同源 Cookie（CSRF 靠浏览器自动带 Origin）+ 访客头。
 * signal 直接透传给 fetch（ApiInit 本来就是 RequestInit 的子集）：进房整体 deadline
 * 超时/切房时中止底层请求，避免半开连接把 busy 永久挂住；旧调用不传 signal 行为不变。
 * fetch 在 abort 时不同运行时抛的对象不一致，若 deadline 已因超时 abort，统一换成
 * TimeoutError，让 UI 能给出「装载超时，请重试」而不是含糊的网络异常。
 */
export function apiFetch(path: string, init?: ApiInit): Promise<Response> {
  const headers = { ...(visitorId ? { "x-user-id": visitorId } : {}), ...init?.headers };
  return fetch(path, { credentials: "same-origin", ...init, headers, ...(init?.signal ? { signal: init.signal } : {}) }).catch((e: unknown) => {
    const signal = init?.signal;
    if (signal?.aborted && signal.reason instanceof TimeoutError) throw signal.reason;
    throw e;
  });
}

/** 非 2xx 响应 → HttpError：尽量解析 `{code,message}`，解析不了只留状态信息 */
export async function httpErrorFrom(res: Response, label: string): Promise<HttpError> {
  const text = await res.text().catch(() => "");
  let code: string | undefined;
  let message = "";
  try {
    const body = JSON.parse(text) as { code?: unknown; message?: unknown };
    if (typeof body.code === "string") code = body.code;
    if (typeof body.message === "string") message = body.message;
  } catch {
    // 非 JSON 体（代理错误页等）：不吞状态码
  }
  return new HttpError(res.status, message || `${label} ${res.status}`, code);
}

export async function request<T>(label: string, path: string, init?: ApiInit): Promise<Resp<T>> {
  const r = await apiFetch(path, init);
  if (!r.ok) {
    const err = await httpErrorFrom(r, label);
    // 受保护端点的 401 统一通知会话失效（登录/注册自身的 401 不走这里，避免误清）
    if (err.status === 401 && !path.startsWith("/api/v1/auth/")) unauthorizedHandler?.();
    throw err;
  }
  return (await r.json()) as Resp<T>;
}

let unauthorizedHandler: (() => void) | null = null;
/** App 注册会话失效回调：任何受保护请求 401（含图鉴/地图面板）都回登录页 */
export function onUnauthorized(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

export function unwrap<T>(res: Resp<T>): T {
  if (!res.ok) throw new GameError(res.code, res.message);
  return res;
}

/** 状态码 → 人话（数据驱动；未收录的状态走 code/message 原样透出） */
const STATUS_HINTS: Record<number, string> = {
  401: "登录已失效，请重新登录",
  403: "没有权限",
  429: "请求太频繁/今日额度已用完，稍后再试",
};

/** 会话失效判定：多标签页改密/被吊销后，任何受保护请求的 401 都走这里 */
export function isUnauthorized(e: unknown): boolean {
  if (e instanceof HttpError) return e.status === 401 || e.code === "E_UNAUTHORIZED";
  if (e instanceof GameError) return e.code === "E_UNAUTHORIZED";
  return false;
}

/**
 * 登录/注册页专用：服务端已经给了"用户名或密码错误/注册未开放/尝试过于频繁"这类人话，
 * 优先原样展示；只有 5xx 才折叠成统一提示，避免 401 被误写成"登录已失效"。
 */
export function authFailMessage(e: unknown): string {
  if (e instanceof HttpError) {
    if (e.status >= 500) return "服务端暂时不可用";
    const message = e.message.trim();
    if (message) return message;
  }
  return httpFailMessage(e);
}

/** 任意异常 → 用户可读提示；网络异常（fetch 抛 TypeError）单独归类 */
export function httpFailMessage(e: unknown): string {
  if (isUnauthorized(e)) return STATUS_HINTS[401];
  if (e instanceof HttpError) {
    const hint = STATUS_HINTS[e.status];
    if (hint) return hint;
    if (e.status >= 500) return "服务端暂时不可用";
    return e.code ? `${e.code}: ${e.message}` : e.message;
  }
  if (e instanceof GameError) return `${e.code}: ${e.message}`;
  if (e instanceof TypeError) return "网络异常，请检查连接后重试";
  if (e instanceof Error && e.name === "TimeoutError") return e.message || "装载超时，请重试";
  return e instanceof Error ? e.message : String(e);
}