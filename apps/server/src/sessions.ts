/**
 * 会话：随机 token 放 HttpOnly Cookie，服务端只存 token 的 sha256。
 *
 * MVP 用内存表：进程重启后所有人重新登录。单实例部署；不引入 Redis/依赖。
 */
import { createHash, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "ecust_sid";

export interface SessionUser {
  userId: string;
  username: string;
}

interface StoredSession extends SessionUser {
  expiresAt: number;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class SessionStore {
  private readonly map = new Map<string, StoredSession>();
  /** userId → tokenHash 集合：按用户全部撤销（封禁/重置/改密依赖） */
  private readonly byUser = new Map<string, Set<string>>();

  constructor(private readonly ttlMs: number = 7 * 24 * 60 * 60 * 1000) {
    // 定期清理过期项，避免长期运行 Map 只增不减（PR #19 建议8）；unref 不吊住进程
    const timer = setInterval(() => this.sweep(), 60 * 60 * 1000);
    timer.unref?.();
  }

  create(user: SessionUser): string {
    const token = randomBytes(32).toString("base64url");
    const key = tokenHash(token);
    this.map.set(key, { ...user, expiresAt: Date.now() + this.ttlMs });
    let set = this.byUser.get(user.userId);
    if (!set) {
      set = new Set();
      this.byUser.set(user.userId, set);
    }
    set.add(key);
    return token;
  }

  get(token: string | null | undefined): SessionUser | null {
    if (!token) return null;
    const key = tokenHash(token);
    const session = this.map.get(key);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.remove(key, session.userId);
      return null;
    }
    return { userId: session.userId, username: session.username };
  }

  destroy(token: string | null | undefined): void {
    if (!token) return;
    const key = tokenHash(token);
    const session = this.map.get(key);
    this.remove(key, session?.userId);
  }

  /** 撤销某用户全部会话；返回撤销条数 */
  revokeUser(userId: string): number {
    const set = this.byUser.get(userId);
    if (!set) return 0;
    const count = set.size;
    for (const key of set) this.map.delete(key);
    this.byUser.delete(userId);
    return count;
  }

  /** 撤销某用户除当前 token 外的其它会话（改密保留本设备） */
  revokeOthers(userId: string, keepToken: string | null | undefined): number {
    const keep = keepToken ? tokenHash(keepToken) : null;
    const set = this.byUser.get(userId);
    if (!set) return 0;
    let count = 0;
    for (const key of [...set]) {
      if (key === keep) continue;
      this.map.delete(key);
      set.delete(key);
      count += 1;
    }
    return count;
  }

  private remove(key: string, userId?: string): void {
    this.map.delete(key);
    if (!userId) return;
    const set = this.byUser.get(userId);
    if (set) {
      set.delete(key);
      if (set.size === 0) this.byUser.delete(userId);
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, session] of this.map) {
      if (session.expiresAt <= now) this.remove(key, session.userId);
    }
  }

  /** 从 Cookie 头取 ecust_sid（只依赖 header 字符串，不引入 cookie 依赖） */
  cookieToken(cookieHeader: string | undefined): string | null {
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === SESSION_COOKIE) return rest.join("=") || null;
    }
    return null;
  }

  userFromHeader(cookieHeader: string | undefined): SessionUser | null {
    return this.get(this.cookieToken(cookieHeader));
  }
}

export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  const attrs = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}
