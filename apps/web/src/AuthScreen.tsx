/**
 * 登录 / 邀请注册入口。身份只在服务端 HttpOnly Cookie 里；
 * 这里不写 localStorage、不保存 token，登录成功只把用户对象交给 App。
 * AUTH_REQUIRED=0 的本地部署额外给"访客进入"；注册关闭时隐藏注册表单。
 */
import { useState, type FormEvent } from "react";
import { login, register } from "./api-auth.ts";
import type { AuthStatus, AuthUser } from "./api-auth.ts";
import { authFailMessage } from "./http.ts";

type Mode = "login" | "register";

export interface AuthScreenProps {
  status: AuthStatus;
  /** 会话失效（401）回到这里时的提示 */
  notice: string;
  onAuthed: (user: AuthUser) => void;
  /** 本地开发访客入口（仅 status.required === false 时显示） */
  onVisitor: () => void;
}

export default function AuthScreen({ status, notice, onAuthed, onVisitor }: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const name = username.trim();
    if (!name || !password) {
      setError("请填写用户名和密码");
      return;
    }
    if (mode === "register" && !inviteCode.trim()) {
      setError("请填写邀请码");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const user =
        mode === "login" ? await login(name, password) : await register(name, password, inviteCode.trim());
      onAuthed(user);
    } catch (err) {
      setError(authFailMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-mark" aria-hidden="true" />
      <div className="auth-card">
        <p className="title-mark">ECUST · 奉贤校区 · 九月</p>
        <h1 className="auth-title">
          登录 <span>AI 校园</span>
        </h1>
        <p className="auth-sub">开发内测 · 账号用于隔离存档与 NPC 记忆</p>

        {notice && <div className="err auth-err">{notice}</div>}

        {status.registrationOpen ? (
          <div className="auth-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "login"}
              className={`auth-tab${mode === "login" ? " active" : ""}`}
              onClick={() => {
                setMode("login");
                setError("");
              }}
            >
              登录
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "register"}
              className={`auth-tab${mode === "register" ? " active" : ""}`}
              onClick={() => {
                setMode("register");
                setError("");
              }}
            >
              邀请注册
            </button>
          </div>
        ) : (
          <p className="muted auth-note">注册已关闭，请联系管理员获取邀请。</p>
        )}

        <form className="auth-form" onSubmit={(e) => void submit(e)}>
          <label className="field">
            <span>用户名</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              maxLength={24}
              placeholder="3–24 位小写字母 / 数字 / _ / -"
              autoFocus
            />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              maxLength={128}
              placeholder="至少 8 位"
            />
          </label>
          {mode === "register" && status.registrationOpen && (
            <label className="field">
              <span>邀请码</span>
              <input
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                autoComplete="off"
                placeholder="向管理员索取"
              />
            </label>
          )}
          {error && <div className="err auth-err">{error}</div>}
          <button type="submit" className="btn primary auth-submit" disabled={busy}>
            {busy ? "请稍候…" : mode === "login" ? "登录" : "注册并进入"}
          </button>
        </form>

        {!status.required && (
          <button type="button" className="btn ghost auth-submit" onClick={onVisitor} disabled={busy}>
            以访客身份进入（本地开发）
          </button>
        )}

        <p className="muted auth-note">
          {mode === "login"
            ? status.registrationOpen
              ? "还没有账号？切到「邀请注册」。"
              : "忘记密码？联系管理员获取一次性重置凭证。"
            : "注册需要有效邀请码；用户名注册后不可改名。"}
        </p>
      </div>
    </div>
  );
}