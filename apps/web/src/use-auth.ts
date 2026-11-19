/**
 * 登录态 / 本地访客入口（P1-2）：身份只问服务端（HttpOnly Cookie）。
 * 访客 id 只在 AUTH_REQUIRED=0 时作为 X-User-Id（记忆档案键，不是凭据）；
 * 会话失效（401）统一走 expireSession，回登录页而不是渲染坏掉的游戏。
 */
import { useCallback, useEffect, useState } from "react";
import { fetchAuthStatus, fetchMe, logout as logoutRequest } from "./api-auth.ts";
import type { AuthStatus, AuthUser } from "./api-auth.ts";
import { setVisitorId } from "./http.ts";
import { enterVisitorStorage, signOutVisitorStorage, visitorIdForRestore } from "./visitor-storage.ts";

export interface AuthGate {
  user: AuthUser | null;
  authReady: boolean;
  authStatus: AuthStatus;
  /** 会话失效回登录页时的提示（多标签页改密/被吊销） */
  notice: string;
  onAuthed: (user: AuthUser) => void;
  enterVisitor: () => void;
  /** 服务端确认退出才返回 true；网络失败时调用方保留本地会话并提示 */
  logout: () => Promise<boolean>;
  expireSession: () => void;
}

function loadVisitorId(): string {
  try {
    return enterVisitorStorage(localStorage, () => `visitor_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  } catch {
    // 隐私模式写不了本地记录：本次会话内仍可用，只是不持久
    return `visitor_${Date.now().toString(36)}`;
  }
}

function visitorUser(id: string): AuthUser {
  return { userId: id, username: "访客（本地开发）", role: "player", state: "active" };
}

export function useAuth(): AuthGate {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [visitor, setVisitor] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  // 服务端不可达时按"需要登录"处理：不放开访客入口
  const [authStatus, setAuthStatus] = useState<AuthStatus>({ required: true, registrationOpen: false });
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let alive = true;
    void (async () => {
      let status: AuthStatus = { required: true, registrationOpen: false };
      try {
        status = await fetchAuthStatus();
      } catch {
        // 保持默认（需要登录）
      }
      let me: AuthUser | null = null;
      try {
        me = await fetchMe();
      } catch {
        me = null;
      }
      if (!alive) return;
      setAuthStatus(status);
      if (me) {
        setUser(me);
      } else if (!status.required) {
        // 本地开发模式：有访客记录就直接恢复，不用每次重新点
        try {
          const saved = visitorIdForRestore(localStorage);
          if (saved) {
            setVisitorId(saved);
            setVisitor(true);
            setUser(visitorUser(saved));
          }
        } catch {
          // 读不了本地记录：停在登录页，用户可手动点访客进入
        }
      }
      setAuthReady(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const onAuthed = useCallback((u: AuthUser) => {
    setVisitorId(null);
    setVisitor(false);
    setNotice("");
    setUser(u);
  }, []);

  const enterVisitor = useCallback(() => {
    const id = loadVisitorId();
    setVisitorId(id);
    setVisitor(true);
    setNotice("");
    setUser(visitorUser(id));
  }, []);

  const clearLocal = useCallback(() => {
    setVisitorId(null);
    setVisitor(false);
    setUser(null);
  }, []);

  const logout = useCallback(async (): Promise<boolean> => {
    // 访客退出只停止自动进入，保留关联存档的持久 ID。
    if (visitor) {
      try {
        signOutVisitorStorage(localStorage);
      } catch {
        // 忽略
      }
      clearLocal();
      return true;
    }
    const ok = await logoutRequest();
    if (ok) clearLocal();
    return ok;
  }, [visitor, clearLocal]);

  const expireSession = useCallback(() => {
    clearLocal();
    setNotice("登录已失效，请重新登录");
  }, [clearLocal]);

  return { user, authReady, authStatus, notice, onAuthed, enterVisitor, logout, expireSession };
}
