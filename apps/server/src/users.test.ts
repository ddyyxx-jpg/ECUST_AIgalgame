/**
 * 账号/密码工具：用户名归一化、密码长度、scrypt 哈希往返、verifyPassword 上界（PR #19 建议9）。
 * 断言布尔/归一化结果，不断言文案。
 */
import { describe, expect, it } from "vitest";
import { hashPassword, isAccount, normalizeUsername, validatePassword, verifyPassword } from "./users.ts";

describe("用户名 / 密码校验", () => {
  it("normalizeUsername 统一小写并拒绝非法形状", () => {
    expect(normalizeUsername("Alice")).toBe("alice");
    expect(normalizeUsername("  user_name-1  ")).toBe("user_name-1");
    expect(normalizeUsername("ab")).toBeNull();
    expect(normalizeUsername("a b")).toBeNull();
    expect(normalizeUsername("中文")).toBeNull();
    expect(normalizeUsername(123)).toBeNull();
  });

  it("validatePassword 限制 8–128 位", () => {
    expect(validatePassword("12345678")).toBe("12345678");
    expect(validatePassword("1234567")).toBeNull();
    expect(validatePassword("x".repeat(129))).toBeNull();
    expect(validatePassword(undefined)).toBeNull();
  });

  it("isAccount 只校基础形状（role/state 可缺省）", () => {
    expect(isAccount({ userId: "u", username: "a", passwordHash: "h", createdAt: 1 })).toBe(true);
    expect(isAccount({ userId: "u" })).toBe(false);
    expect(isAccount(null)).toBe(false);
  });
});

describe("scrypt 哈希", () => {
  it("哈希往返：正确密码通过，错误密码拒绝", async () => {
    const stored = await hashPassword("password123");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("password123", stored)).toBe(true);
    expect(await verifyPassword("wrongpass", stored)).toBe(false);
  });

  it("建议9：超大 N/r/p 直接拒绝（不触发 scrypt OOM）", async () => {
    const salt = "aa".repeat(16);
    const hash = "bb".repeat(32);
    expect(await verifyPassword("x", `scrypt$${1 << 21}$8$1$${salt}$${hash}`)).toBe(false);
    expect(await verifyPassword("x", `scrypt$16384$17$1$${salt}$${hash}`)).toBe(false);
    expect(await verifyPassword("x", `scrypt$16384$8$5$${salt}$${hash}`)).toBe(false);
    expect(await verifyPassword("x", `scrypt$0$8$1$${salt}$${hash}`)).toBe(false);
    expect(await verifyPassword("x", `scrypt$abc$8$1$${salt}$${hash}`)).toBe(false);
  });

  it("畸形/非 scrypt 存储一律拒绝", async () => {
    expect(await verifyPassword("x", "plaintext")).toBe(false);
    expect(await verifyPassword("x", "scrypt$16384$8$1")).toBe(false);
    expect(await verifyPassword("x", "scrypt$16384$8$1$$")).toBe(false);
    expect(await verifyPassword("x", `bcrypt$16384$8$1$aa$bb`)).toBe(false);
  });
});