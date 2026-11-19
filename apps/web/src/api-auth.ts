/** 简易用户系统的 HTTP 层：登录态只在 HttpOnly Cookie 里，前端不存 token。 */
import { apiFetch, httpErrorFrom, jsonHeaders, request, unwrap } from "./http.ts";

export interface AuthUser {
  userId: string;
  username: string;
  role: "player" | "admin";
  state: "active" | "suspended" | "archived";
  nickname?: string;
}

/** 公开端点 /auth/status：是否强制登录、注册是否开放（本地访客入口据此显示） */
export interface AuthStatus {
  required: boolean;
  registrationOpen: boolean;
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  return unwrap(await request<AuthStatus>("auth status", "/api/v1/auth/status"));
}

export async function fetchMe(): Promise<AuthUser | null> {
  const res = await apiFetch("/api/v1/auth/me");
  if (res.status === 401) return null;
  if (!res.ok) throw await httpErrorFrom(res, "me");
  const body = (await res.json()) as { user: AuthUser };
  return body.user;
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const res = await apiFetch("/api/v1/auth/login", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw await httpErrorFrom(res, "login");
  return ((await res.json()) as { user: AuthUser }).user;
}

export async function register(username: string, password: string, inviteCode: string): Promise<AuthUser> {
  const res = await apiFetch("/api/v1/auth/register", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ username, password, inviteCode }),
  });
  if (!res.ok) throw await httpErrorFrom(res, "register");
  return ((await res.json()) as { user: AuthUser }).user;
}

/**
 * 退出必须等服务端确认（Cookie 写操作，浏览器自动带 Origin 过 CSRF）：
 * 返回 false = 网络失败/服务端拒绝，调用方不清本地会话，避免"界面退了、会话还在"。
 */
export async function logout(): Promise<boolean> {
  try {
    const res = await apiFetch("/api/v1/auth/logout", { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}

/** 改密：服务端会吊销其它会话、保留当前会话 */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const res = await apiFetch("/api/v1/auth/password", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (!res.ok) throw await httpErrorFrom(res, "password");
}

/** 忘记密码：用管理员签发的一次性重置凭证（公开端点） */
export async function resetPassword(username: string, credential: string, newPassword: string): Promise<void> {
  const res = await apiFetch("/api/v1/auth/reset-password", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ username, credential, newPassword }),
  });
  if (!res.ok) throw await httpErrorFrom(res, "reset password");
}