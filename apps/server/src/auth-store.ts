/**
 * 单一 auth 域存储（收敛稿 B1）：users / invites / resetCredentials / settings 合并为
 * `data/auth/auth.json`，单进程统一串行写入。副本上修改 → 写盘成功才更新内存，失败不留半修改。
 *
 * 损坏 fail-fast（#35 / PR #19 P1-3）：解析/校验失败抛 AuthStoreCorruptError，保留故障文件，
 * **不按空库覆盖**；仅 ENOENT 按空库启动（并尝试从旧 users.json v1 迁移）。
 * 不引入依赖：zod 校验边界，crypto 自带 scrypt/sha256。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { hashPassword, isAccount, verifyPassword, type Account, type AccountState, type Role } from "./users.ts";

export class AuthStoreCorruptError extends Error {
  constructor(file: string, cause: unknown) {
    super(`auth 域文件损坏，拒绝启动以免覆盖：${file}（${cause instanceof Error ? cause.message : String(cause)}）`);
    this.name = "AuthStoreCorruptError";
  }
}

export interface Invite {
  id: string;
  codeHash: string;
  note: string;
  maxUses: number;
  used: number;
  expiresAt: number;
  revoked: boolean;
  createdBy: string;
  createdAt: number;
}

export interface ResetCredential {
  id: string;
  userId: string;
  codeHash: string;
  expiresAt: number;
  used: boolean;
  createdBy: string;
  createdAt: number;
}

export interface AuthSettings {
  registrationOpen: boolean;
  actionsEnabled: boolean;
  /** null = 不限（量级由负责人后续给定，代码不硬编码数值） */
  defaultDailyTurns: number | null;
  perUserDailyTurns: Record<string, number | null>;
}

/**
 * 额度解析的唯一口径：个人键存在时**即使值为 null（不限）也算显式设置**，不能回退全局默认。
 * 回合入口与管理列表必须共用本函数，否则同一个账号会看到两个不同额度（复审 P2）。
 */
export function dailyLimitFor(settings: AuthSettings, userId: string): number | null {
  return Object.prototype.hasOwnProperty.call(settings.perUserDailyTurns, userId)
    ? (settings.perUserDailyTurns[userId] ?? null)
    : settings.defaultDailyTurns;
}

interface AuthFile {
  version: 2;
  users: Account[];
  invites: Invite[];
  resets: ResetCredential[];
  settings: AuthSettings;
}

export type RegisterResult =
  | { ok: true; user: Account }
  | { ok: false; code: "E_ID_TAKEN" | "E_FORBIDDEN" | "E_STORE_FAULT"; message: string };

const DEFAULT_SETTINGS: AuthSettings = {
  registrationOpen: true,
  actionsEnabled: true,
  defaultDailyTurns: null,
  perUserDailyTurns: {},
};

const AccountSchema = z.object({
  userId: z.string(),
  username: z.string(),
  passwordHash: z.string(),
  createdAt: z.number(),
  role: z.enum(["player", "admin"]),
  state: z.enum(["active", "suspended", "archived"]),
  nickname: z.string().optional(),
});
const InviteSchema = z.object({
  id: z.string(), codeHash: z.string(), note: z.string(), maxUses: z.number(),
  used: z.number(), expiresAt: z.number(), revoked: z.boolean(), createdBy: z.string(), createdAt: z.number(),
});
const ResetSchema = z.object({
  id: z.string(), userId: z.string(), codeHash: z.string(), expiresAt: z.number(),
  used: z.boolean(), createdBy: z.string(), createdAt: z.number(),
});
const SettingsSchema = z.object({
  registrationOpen: z.boolean(),
  actionsEnabled: z.boolean(),
  defaultDailyTurns: z.number().nullable(),
  perUserDailyTurns: z.record(z.string(), z.number().nullable()),
});
const FileSchema = z.object({
  version: z.literal(2),
  users: z.array(AccountSchema),
  invites: z.array(InviteSchema),
  resets: z.array(ResetSchema),
  settings: SettingsSchema,
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function codeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function emptyFile(): AuthFile {
  return { version: 2, users: [], invites: [], resets: [], settings: { ...DEFAULT_SETTINGS, perUserDailyTurns: {} } };
}

export class AuthStore {
  private doc: AuthFile = emptyFile();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new AuthStoreCorruptError(this.filePath, e);
      this.doc = await this.migrateLegacy();
      return;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (e) {
      throw new AuthStoreCorruptError(this.filePath, e);
    }
    const parsed = FileSchema.safeParse(parsedJson);
    if (!parsed.success) throw new AuthStoreCorruptError(this.filePath, parsed.error);
    this.doc = parsed.data;
  }

  /**
   * 旧 users.json v1 → auth.json v2：role=player，disabled→suspended；原文件保留不删。
   * P1-3：只有确实不存在（ENOENT）才建空库；读取/解析/结构校验任一失败都中止迁移、不落盘，
   * 绝不把「异常结构」静默变成空库或丢掉坏记录（否则新版文件优先生效，受影响账号再也登不上）。
   */
  private async migrateLegacy(): Promise<AuthFile> {
    const legacyPath = path.join(path.dirname(this.filePath), "users.json");
    let raw: string;
    try {
      raw = await readFile(legacyPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
      throw new AuthStoreCorruptError(legacyPath, e);
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (e) {
      throw new AuthStoreCorruptError(legacyPath, e);
    }
    const legacy = parsedJson as { users?: unknown };
    if (!legacy || typeof legacy !== "object" || !Array.isArray(legacy.users)) {
      throw new AuthStoreCorruptError(legacyPath, "旧库结构异常：users 不是数组");
    }
    const accounts: Account[] = [];
    legacy.users.forEach((u, i) => {
      if (!isAccount(u)) throw new AuthStoreCorruptError(legacyPath, `旧库第 ${i} 条账号结构非法，已中止迁移`);
      const old = u as Account & { disabled?: boolean };
      accounts.push({
        userId: old.userId, username: old.username, passwordHash: old.passwordHash, createdAt: old.createdAt,
        role: old.role === "admin" ? "admin" : "player",
        state: old.state ?? (old.disabled ? "suspended" : "active"),
        ...(old.nickname ? { nickname: old.nickname } : {}),
      });
    });
    const doc: AuthFile = { ...emptyFile(), users: accounts };
    // 写盘前用正式 v2 schema 校验：isAccount 只查必备字段，nickname 类型错误等会在下次启动才炸，
    // 造成「迁移成功一次、再启动即坏库」。校验不过按旧库损坏处理，不落盘。
    const checked = FileSchema.safeParse(doc);
    if (!checked.success) throw new AuthStoreCorruptError(legacyPath, checked.error);
    await this.persist(checked.data);
    console.log(`[auth] 已从旧 users.json 迁移 ${accounts.length} 个账号到 auth.json（原文件保留）`);
    return checked.data;
  }

  findUser(username: string): Account | undefined {
    return this.doc.users.find((u) => u.username === username);
  }

  getUser(userId: string): Account | undefined {
    return this.doc.users.find((u) => u.userId === userId);
  }

  listUsers(q?: string): Account[] {
    const needle = q?.trim().toLowerCase();
    if (!needle) return [...this.doc.users];
    return this.doc.users.filter(
      (u) => u.username.includes(needle) || (u.nickname ?? "").toLowerCase().includes(needle),
    );
  }

  getSettings(): AuthSettings {
    return structuredClone(this.doc.settings);
  }

  listInvites(): Invite[] {
    return structuredClone(this.doc.invites);
  }

  async verify(username: string, password: string): Promise<Account | null> {
    const user = this.findUser(username);
    if (!user || user.state !== "active") return null;
    const userId = user.userId;
    const usedHash = user.passwordHash;
    if (!(await verifyPassword(password, usedHash))) return null;
    // P1-4：scrypt 期间账号可能被暂停/改密/重置。签发会话前复核当前状态与凭据版本，
    // 避免「旧密码校验还在跑、重置已完成」时仍签发新会话。
    const fresh = this.getUser(userId);
    if (!fresh || fresh.state !== "active" || fresh.passwordHash !== usedHash) return null;
    return fresh;
  }

  /** 账号创建 + 邀请扣减在同一串行写内原子完成；写盘失败回滚内存、不消耗邀请 */
  async register(username: string, password: string, opts: { inviteCode?: string; envCode: string; registrationOpen: boolean }): Promise<RegisterResult> {
    const hash = await hashPassword(password);
    return this.mutate((doc) => {
      if (!opts.registrationOpen) return { ok: false, code: "E_FORBIDDEN", message: "注册未开放" } as const;
      if (doc.users.some((u) => u.username === username)) {
        return { ok: false, code: "E_ID_TAKEN", message: "用户名已被占用" } as const;
      }
      const code = opts.inviteCode ?? "";
      let invite: Invite | undefined;
      if (opts.envCode && codeEqual(sha256(code), sha256(opts.envCode))) {
        // 开发兼容共享码：不限次数
      } else {
        const codeHash = sha256(code);
        invite = doc.invites.find(
          (i) => !i.revoked && i.used < i.maxUses && i.expiresAt > Date.now() && codeEqual(i.codeHash, codeHash),
        );
        if (!invite) return { ok: false, code: "E_FORBIDDEN", message: "邀请码不正确或已失效" } as const;
      }
      const user: Account = {
        userId: `usr_${randomBytes(8).toString("hex")}`,
        username,
        passwordHash: hash,
        createdAt: Date.now(),
        role: "player",
        state: "active",
      };
      doc.users.push(user);
      if (invite) invite.used += 1;
      return { ok: true, user } as const;
    });
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<{ ok: boolean; code?: string; message?: string }> {
    const user = this.getUser(userId);
    if (!user) return { ok: false, code: "E_REF_NOT_FOUND", message: "账号不存在" };
    const verifiedHash = user.passwordHash;
    if (!(await verifyPassword(currentPassword, verifiedHash))) {
      return { ok: false, code: "E_UNAUTHORIZED", message: "当前密码不正确" };
    }
    const hash = await hashPassword(newPassword);
    return this.mutate((doc) => {
      const u = doc.users.find((x) => x.userId === userId);
      if (!u) return { ok: false, code: "E_REF_NOT_FOUND", message: "账号不存在" };
      // P1-4：并发改密/重置会更新 passwordHash；落盘前复核，防止用旧密码覆盖新凭据
      if (u.passwordHash !== verifiedHash) {
        return { ok: false, code: "E_PRECONDITION", message: "凭据已变更，请重新登录后重试" };
      }
      u.passwordHash = hash;
      return { ok: true };
    });
  }

  setUserState(userId: string, state: AccountState): Promise<Account | null> {
    return this.mutate((doc) => {
      const u = doc.users.find((x) => x.userId === userId);
      if (!u) return null;
      u.state = state;
      return u;
    });
  }

  setUserRole(userId: string, role: Role): Promise<Account | null> {
    return this.mutate((doc) => {
      const u = doc.users.find((x) => x.userId === userId);
      if (!u) return null;
      u.role = role;
      return u;
    });
  }

  /** 本地初始化首个管理员（scripts/admin-init.ts，停服后运行）：存在则提权，不存在则创建 */
  async ensureAdmin(username: string, password?: string): Promise<Account> {
    const existing = this.findUser(username);
    if (existing) {
      const promoted = await this.setUserRole(existing.userId, "admin");
      return promoted ?? existing;
    }
    if (!password) throw new Error("创建新管理员需要密码");
    const hash = await hashPassword(password);
    return this.mutate((doc) => {
      const user: Account = {
        userId: `usr_${randomBytes(8).toString("hex")}`,
        username, passwordHash: hash, createdAt: Date.now(), role: "admin", state: "active",
      };
      doc.users.push(user);
      return user;
    });
  }

  issueReset(userId: string, ttlMs: number, createdBy: string): Promise<{ credential: string; expiresAt: number } | null> {
    const credential = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + ttlMs;
    return this.mutate((doc) => {
      if (!doc.users.some((u) => u.userId === userId)) return null;
      doc.resets.push({
        id: `rst_${randomBytes(6).toString("hex")}`, userId, codeHash: sha256(credential),
        expiresAt, used: false, createdBy, createdAt: Date.now(),
      });
      return { credential, expiresAt };
    });
  }

  async consumeReset(username: string, credential: string, newPassword: string): Promise<{ ok: boolean; code?: string; message?: string }> {
    const codeHash = sha256(credential);
    const pwHash = await hashPassword(newPassword);
    return this.mutate((doc) => {
      const user = doc.users.find((u) => u.username === username);
      if (!user) return { ok: false, code: "E_UNAUTHORIZED", message: "用户名或凭证不正确" };
      const reset = doc.resets.find(
        (r) => r.userId === user.userId && !r.used && r.expiresAt > Date.now() && codeEqual(r.codeHash, codeHash),
      );
      if (!reset) return { ok: false, code: "E_UNAUTHORIZED", message: "用户名或凭证不正确" };
      reset.used = true;
      user.passwordHash = pwHash;
      return { ok: true };
    });
  }

  createInvite(opts: { note?: string; maxUses?: number; ttlHours?: number }, createdBy: string): Promise<{ invite: Invite; code: string }> {
    const code = randomBytes(12).toString("base64url");
    const invite: Invite = {
      id: `inv_${randomBytes(6).toString("hex")}`,
      codeHash: sha256(code),
      note: (opts.note ?? "").slice(0, 120),
      maxUses: Math.max(1, Math.floor(opts.maxUses ?? 1)),
      used: 0,
      expiresAt: Date.now() + Math.max(1, opts.ttlHours ?? 168) * 3600_000,
      revoked: false,
      createdBy,
      createdAt: Date.now(),
    };
    return this.mutate((doc) => {
      doc.invites.push(invite);
      return { invite, code };
    });
  }

  revokeInvite(id: string): Promise<boolean> {
    return this.mutate((doc) => {
      const invite = doc.invites.find((i) => i.id === id);
      if (!invite) return false;
      invite.revoked = true;
      return true;
    });
  }

  updateSettings(patch: Partial<AuthSettings>): Promise<AuthSettings> {
    return this.mutate((doc) => {
      doc.settings = { ...doc.settings, ...patch, perUserDailyTurns: { ...doc.settings.perUserDailyTurns, ...(patch.perUserDailyTurns ?? {}) } };
      return structuredClone(doc.settings);
    });
  }

  /** 串行 + 副本修改：写盘成功才替换内存；失败抛出且内存不变（不留半修改） */
  private mutate<T>(fn: (doc: AuthFile) => T): Promise<T> {
    const run = this.chain.then(async () => {
      const draft = structuredClone(this.doc);
      const result = fn(draft);
      await this.persist(draft);
      this.doc = draft;
      return result;
    });
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async persist(doc: AuthFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, JSON.stringify(doc, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.filePath);
  }
}