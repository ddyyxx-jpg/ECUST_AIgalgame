/**
 * 本地部署冒烟（issue #84）：本机直跑真服务（Fastify + 临时 dataDir），覆盖可离线验证的部署面。
 *
 * 用法：npx tsx scripts/deploy-smoke.ts
 * 覆盖：health 200、AUTH_REQUIRED=1 下未登录 401、CSRF Origin 校验、邀请码注册一次成功且不可重复、
 *       正确密码登录 + Cookie 会话、连续失败 429、普通用户访问 admin/users 被拒、
 *       同 dataDir 重建 app 后账号仍在（=挂载卷重启后数据不丢）。
 * 不覆盖（需目标机实测）：Docker compose up、Nginx TLS/域名隔离、自签证书、备份恢复演练——
 *       按 deploy/README.md §3–§5 在目标机执行；本脚本只验证应用层可离线部分。
 * 不联网、不花钱、不启外部进程；退出码 0 = 全部通过。
 */
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../apps/server/src/bootstrap.ts";
import { loadConfig } from "../apps/server/src/config.ts";
import { registerRoutes } from "../apps/server/src/routes.ts";
import type { ServerConfig } from "../apps/server/src/config.ts";

const ORIGIN = "http://127.0.0.1";
const dataDir = mkdtempSync(join(tmpdir(), "galgame-deploy-smoke-"));
const base = {
  ...loadConfig(),
  dataDir,
  port: 0,
  host: "127.0.0.1",
  adminToken: "smoke-admin-token",
  authRequired: true,
  // 不配 env 共享码（它不限次数），走真实部署路径：由 admin 创建 maxUses=1 的应用内邀请码
  inviteCode: "",
  secureCookies: false,
  trustUserHeader: false,
  trustProxy: false,
  publicOrigin: ORIGIN,
  llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
} satisfies ServerConfig;

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function start(cfg: ServerConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerRoutes(app, await createApp(cfg));
  await app.ready();
  return app;
}

interface Res { status: number; cookie?: string; body: unknown }
async function call(app: FastifyInstance, method: string, path: string, body?: unknown, cookie?: string, origin = true): Promise<Res> {
  const res = await app.inject({
    method,
    url: path,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(origin && ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? { origin: ORIGIN } : {}),
    },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  const setCookie = res.headers["set-cookie"];
  return { status: res.statusCode, cookie: Array.isArray(setCookie) ? setCookie[0] : setCookie, body: res.json() };
}

const app = await start(base);
const ADMIN_HEADERS = { "x-admin-token": "smoke-admin-token" };

// 真实部署路径：管理员用令牌创建一次性邀请码（env GALGAME_INVITE_CODE 是不限次数的开发共享码）
async function adminPost(path: string, body: unknown): Promise<Res> {
  const res = await app.inject({
    method: "POST",
    url: path,
    headers: { ...ADMIN_HEADERS, origin: ORIGIN },
    payload: body as object,
  });
  return { status: res.statusCode, body: res.json() };
}
const inviteRes = await adminPost("/api/v1/admin/invites", { note: "smoke", maxUses: 1 });
const inviteCode = (inviteRes.body as { code?: string })?.code ?? "";
check("admin 创建一次性邀请码", inviteRes.status === 200 && Boolean(inviteCode), `status=${inviteRes.status}`);
const adminUsers = await call(app, "GET", "/api/v1/admin/users", undefined, undefined);
check("无令牌访问 admin/users 被登录门拒", adminUsers.status === 401, `status=${adminUsers.status}`);

const health = await call(app, "GET", "/api/v1/health");
check("health 200（公开端点）", health.status === 200, `status=${health.status}`);

const settings = await call(app, "GET", "/api/v1/settings/llm");
check("settings 未登录被登录门拒（401）", settings.status === 401, `status=${settings.status}`);

const register = await call(app, "POST", "/api/v1/auth/register", { username: "smoke_user", password: "SmokePass123!", inviteCode });
check("邀请码注册成功", register.status === 200 && (register.body as { ok?: boolean })?.ok === true, `status=${register.status}`);

// CSRF：写请求缺 Origin 必须被拒（authRequired=1 的正向验证）
const noOrigin = await call(app, "POST", "/api/v1/auth/login", { username: "smoke_user", password: "SmokePass123!" }, undefined, false);
check("写请求缺 Origin 被 CSRF 拒绝（403）", noOrigin.status === 403, `status=${noOrigin.status}`);

// 邀请码一次性（默认 maxUses=1）
const register2 = await call(app, "POST", "/api/v1/auth/register", { username: "smoke_user2", password: "SmokePass123!", inviteCode });
check("邀请码不可重复使用", register2.status !== 200, `status=${register2.status}`);

// 正确密码登录（在限流测试前，避免 limiter 误伤）
const login = await call(app, "POST", "/api/v1/auth/login", { username: "smoke_user", password: "SmokePass123!" });
check("正确密码登录 200 + cookie", login.status === 200 && Boolean(login.cookie), `status=${login.status}`);

if (login.cookie) {
  const cookie = login.cookie.split(";")[0]!;
  const me = await call(app, "GET", "/api/v1/auth/me", undefined, cookie);
  check("Cookie 会话可用", me.status === 200, `status=${me.status}`);
  const normalUsers = await call(app, "GET", "/api/v1/admin/users", undefined, cookie);
  check("普通用户访问 admin/users 被拒", normalUsers.status === 403, `status=${normalUsers.status}`);
} else {
  check("Cookie 会话可用", false, "无 cookie");
  check("普通用户访问 admin/users 被拒", false, "无 cookie");
}

// 登录限流：连错 5 次/分钟 → 第 5 次起 429（限流键为 ip:username）
let last = 0;
for (let i = 0; i < 6; i++) {
  last = (await call(app, "POST", "/api/v1/auth/login", { username: "smoke_user", password: "WrongPass123!" })).status;
}
check("登录连续失败触发 429", last === 429, `last=${last}`);

await app.close();

// 数据卷持久化：同 dataDir 重建 app + 新邀请码（原已用尽），账号仍可登录
const persisted = await start(base);
const relogin = await call(persisted, "POST", "/api/v1/auth/login", { username: "smoke_user", password: "SmokePass123!" });
check("同 dataDir 重建后账号仍在（卷持久化）", relogin.status === 200, `status=${relogin.status}`);
await persisted.close();

rmSync(dataDir, { recursive: true, force: true });
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) process.exit(1);
