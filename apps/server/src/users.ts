/**
 * 账号与密码工具：scrypt 哈希（Node 自带，不引入依赖）、用户名/密码校验。
 * 存储与邀请/重置/设置见 auth-store.ts（单一 auth 域文件，单进程串行写）。
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

const USERNAME_RE = /^[a-z0-9_-]{3,24}$/;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export type Role = "player" | "admin";
export type AccountState = "active" | "suspended" | "archived";

export interface Account {
  userId: string;
  username: string;
  passwordHash: string;
  createdAt: number;
  role: Role;
  state: AccountState;
  nickname?: string;
}

/** 统一小写；用户名只允许 [a-z0-9_-]，避免大小写导致两个“同名”账号 */
export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const username = value.trim().toLowerCase();
  return USERNAME_RE.test(username) ? username : null;
}

export function validatePassword(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length < 8 || value.length > 128) return null;
  return value;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = (await scrypt(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  })) as Buffer;
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  // 上界校验（PR #19 建议9）：坏文件里的超大 N/r/p 会让 scrypt 吃满内存（OOM DoS）
  if (![N, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;
  if (N > 1 << 20 || r > 16 || p > 4) return false;
  const salt = Buffer.from(saltHex ?? "", "hex");
  const expected = Buffer.from(hashHex ?? "", "hex");
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = (await scrypt(password, salt, expected.length, { N, r, p })) as Buffer;
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 基础形状校验（role/state 可缺省：旧 users.json v1 迁移时补齐） */
export function isAccount(value: unknown): value is Account {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.userId === "string" &&
    typeof a.username === "string" &&
    typeof a.passwordHash === "string" &&
    typeof a.createdAt === "number"
  );
}