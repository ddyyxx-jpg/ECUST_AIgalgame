/** 配置只从环境变量读；key 不进仓库、不进日志 */
import { randomBytes } from "node:crypto";

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  contentDir: string;
  /** 地图草案审核/发布/生成的管理员令牌；未配置时生成本次进程的临时令牌 */
  adminToken: string;
  /** 开发期兜底账号（GALGAME_DEV_USER）；上线接登录中间件后删掉 */
  devUser?: string;
  /**
   * 是否信任 `X-User-Id` 头（默认 true，**只适合本机/内网开发**）。
   * 生产必须置 GALGAME_TRUST_USER_HEADER=0，由前置登录中间件注入 userId（query/body），
   * 否则任何人改个头就能读别人的档案（审阅 P1）。
   */
  trustUserHeader: boolean;
  llm: { baseUrl: string; model: string; apiKey: string; timeoutMs: number };
  /**
   * 审核器：独立端点/独立模型，因为"被审模型"和"审它的模型"不能是同一个脑子。
   * 可选：不配就是放行态（NoopAudit）。做成可选是为了让"只要能叙事"的最小部署与
   * 测试 fixture 不必伪造审核器字段。
   */
  audit?: { baseUrl: string; model: string; apiKey: string; timeoutMs: number };
  /**
   * 世界层永久记忆的自动审核（canonize，docs/08 §7）：必须与叙事/内容审核模型不同家族。
   * 可选：不配 = `DenyAllJudge`（拒绝所有候选，fail-closed）。
   */
  canonize?: { enabled: boolean; baseUrl: string; model: string; apiKey: string; timeoutMs: number; dailyCap: number; scanMinutes: number };
  /** 世界印象的 TTL（天）；过期未投递直接丢弃 */
  impressionTtlDays?: number;
  /** true = 除公开端点外都要求登录（部署置 1；本地测试默认 0，保留 header 兼容） */
  authRequired?: boolean;
  /** 注册邀请码；空 = 关闭注册 */
  inviteCode?: string;
  /** HTTPS 部署时给会话 Cookie 加 Secure */
  secureCookies?: boolean;
  /** 会话有效期（天），默认 7 */
  sessionTtlDays?: number;
  /** 反向代理后按真实 IP 计数限流（GALGAME_TRUST_PROXY=1）；默认不信任转发头 */
  trustProxy?: boolean;
  /** Cookie 写请求 CSRF 校验允许的 Origin（authRequired=1 时建议配置，如 https://galgame.example.edu） */
  publicOrigin?: string;
  /** 一次性重置凭证有效期（分钟），默认 15 */
  resetTtlMin?: number;
}

function env(k: string, d: string): string {
  const v = process.env[k];
  return v && v.trim() ? v.trim() : d;
}

/** 经验熵（bit）：把令牌当独立字符样本，挡住 "admin123" / 重复字符这类可猜口令 */
function entropyBits(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  return bits * s.length;
}

/** 显式配置的令牌必须有足够熵：至少 16 字符且估算 ≥ 96 bit（约等于 24 位 base64url 随机串） */
function assertAdminTokenStrength(token: string): void {
  if (token.length < 16 || entropyBits(token) < 96) {
    throw new Error("GALGAME_ADMIN_TOKEN 强度不足：需 ≥16 字符且高熵随机值（建议 `openssl rand -base64 24`），拒绝启动");
  }
}

export function loadConfig(): ServerConfig {
  const configuredAdminToken = env("GALGAME_ADMIN_TOKEN", "");
  if (configuredAdminToken) assertAdminTokenStrength(configuredAdminToken);
  const adminToken = configuredAdminToken || randomBytes(18).toString("base64url");
  if (!configuredAdminToken) {
    // 没有默认口令：每次启动随机生成，只打印到服务端控制台，避免同网段默认 token 可被滥用
    console.warn(`[config] GALGAME_ADMIN_TOKEN 未设置，本次启动使用临时管理员令牌：${adminToken}`);
  }
  return {
    port: Number(env("GALGAME_PORT", "8787")),
    host: env("GALGAME_HOST", "127.0.0.1"),
    dataDir: env("GALGAME_DATA_DIR", "data"),
    contentDir: env("GALGAME_CONTENT_DIR", "content"),
    adminToken,
    devUser: env("GALGAME_DEV_USER", "") || undefined,
    trustUserHeader: env("GALGAME_TRUST_USER_HEADER", "1") !== "0",
    llm: {
      baseUrl: env("GALGAME_LLM_BASE_URL", ""),
      model: env("GALGAME_LLM_MODEL", "deepseek-v4.1-flash"),
      apiKey: env("GALGAME_LLM_API_KEY", ""),
      timeoutMs: Number(env("GALGAME_LLM_TIMEOUT_MS", "20000")),
    },
    canonize: {
      // 默认开：闸门本身 fail-closed（judge 未配置 = 拒绝一切），开着不会写坏数据；
      // 关掉只用于"完全不想跑这条链路"的部署（比如纯单机试玩）
      enabled: env("GALGAME_CANONIZE_ENABLED", "1") !== "0",
      // 与叙事/审核模型分开配置：世界层写错一次所有玩家都受影响，不能同一家模型自己判自己
      baseUrl: env("GALGAME_CANONIZE_BASE_URL", ""),
      model: env("GALGAME_CANONIZE_MODEL", ""),
      apiKey: env("GALGAME_CANONIZE_API_KEY", ""),
      timeoutMs: Number(env("GALGAME_CANONIZE_TIMEOUT_MS", "20000")),
      dailyCap: Number(env("GALGAME_CANONIZE_DAILY_CAP", "200")),
      // 0 = 不自动跑（只留管理员手动触发）；>0 = 每 N 分钟扫一遍已加载房间
      scanMinutes: Number(env("GALGAME_CANONIZE_SCAN_MINUTES", "0")),
    },
    impressionTtlDays: Number(env("GALGAME_IMPRESSION_TTL_DAYS", "30")),
    authRequired: env("GALGAME_AUTH_REQUIRED", "0") === "1",
    inviteCode: env("GALGAME_INVITE_CODE", ""),
    secureCookies: env("GALGAME_SECURE_COOKIES", "0") === "1",
    sessionTtlDays: Math.max(1, Number(env("GALGAME_SESSION_TTL_DAYS", "7")) || 7),
    trustProxy: env("GALGAME_TRUST_PROXY", "0") === "1",
    publicOrigin: env("GALGAME_PUBLIC_ORIGIN", "") || undefined,
    resetTtlMin: Math.max(1, Number(env("GALGAME_RESET_TTL_MIN", "15")) || 15),
    audit: {
      // 审核器必须独立配置：不继承主模型端点/key（否则等于同一家模型自己审自己），
      // 也不写死模型名（代码里不许出现具体模型）。三项齐全才算配好，缺一 → 放行态 + 启动告警。
      baseUrl: env("GALGAME_AUDIT_BASE_URL", ""),
      model: env("GALGAME_AUDIT_MODEL", ""),
      apiKey: env("GALGAME_AUDIT_API_KEY", ""),
      timeoutMs: Number(env("GALGAME_AUDIT_TIMEOUT_MS", "20000")),
    },
  };
}

export function hasLlm(cfg: ServerConfig): boolean {
  return cfg.llm.baseUrl !== "" && cfg.llm.apiKey !== "";
}

/** 没有独立的审核端点/模型时，审核层退化为 NoopAudit（开发/测试态；线上必须配） */
export function hasAudit(cfg: ServerConfig): boolean {
  const a = cfg.audit;
  return !!a && a.baseUrl !== "" && a.apiKey !== "" && a.model !== "";
}

/** 只有"启用 + 三项齐全"才算配好；未配好一律 DenyAllJudge（没有"默认放行"这条路） */
export function hasCanonize(cfg: ServerConfig): boolean {
  const c = cfg.canonize;
  return !!c && c.enabled && c.baseUrl !== "" && c.apiKey !== "" && c.model !== "";
}
