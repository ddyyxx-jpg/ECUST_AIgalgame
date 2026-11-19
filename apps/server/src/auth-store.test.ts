/**
 * 单一 auth 域存储（收敛稿 B1 / PR #19 P1-3）：损坏 fail-fast 保留文件、旧 users.json 迁移、
 * 注册与邀请扣减原子性。断言状态/错误类型/文件内容，不断言文案。
 */
import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tempDir } from "@galgame/testkit";
import { AuthStore, AuthStoreCorruptError } from "./auth-store.ts";

function storeAt(dir: string): AuthStore {
  return new AuthStore(path.join(dir, "auth.json"));
}

describe("损坏 fail-fast（P1-3）", () => {
  it("非法 JSON：抛 AuthStoreCorruptError，且故障文件原样保留（不按空库覆盖）", async () => {
    const dir = tempDir("galgame-authstore-corrupt-");
    const file = path.join(dir, "auth.json");
    await writeFile(file, "{broken json", "utf8");
    const store = storeAt(dir);
    await expect(store.load()).rejects.toBeInstanceOf(AuthStoreCorruptError);
    expect(await readFile(file, "utf8")).toBe("{broken json");
  });

  it("合法 JSON 但 schema 不符：同样 fail-fast 保留文件", async () => {
    const dir = tempDir("galgame-authstore-schema-");
    const file = path.join(dir, "auth.json");
    const bad = JSON.stringify({ version: 2, users: [{ userId: "u1" }], invites: [], resets: [], settings: {} });
    await writeFile(file, bad, "utf8");
    await expect(storeAt(dir).load()).rejects.toBeInstanceOf(AuthStoreCorruptError);
    expect(await readFile(file, "utf8")).toBe(bad);
  });

  it("文件不存在（ENOENT）：按空库启动，可正常注册", async () => {
    const store = storeAt(tempDir("galgame-authstore-empty-"));
    await store.load();
    expect(store.listUsers()).toEqual([]);
    const r = await store.register("alice", "password123", { envCode: "invite-123", inviteCode: "invite-123", registrationOpen: true });
    expect(r.ok).toBe(true);
  });
});

describe("旧 users.json v1 迁移", () => {
  it("迁移到 auth.json v2：role=player，disabled→suspended；原文件保留", async () => {
    const dir = tempDir("galgame-authstore-migrate-");
    const legacy = {
      users: [
        { userId: "u1", username: "alice", passwordHash: "scrypt$16384$8$1$aa$bb", createdAt: 1, disabled: true },
        { userId: "u2", username: "bob", passwordHash: "scrypt$16384$8$1$cc$dd", createdAt: 2 },
      ],
    };
    await writeFile(path.join(dir, "users.json"), JSON.stringify(legacy), "utf8");
    const store = storeAt(dir);
    await store.load();
    expect(store.getUser("u1")).toMatchObject({ role: "player", state: "suspended" });
    expect(store.getUser("u2")).toMatchObject({ role: "player", state: "active" });
    // auth.json 已生成，旧文件保留
    const migrated = JSON.parse(await readFile(path.join(dir, "auth.json"), "utf8")) as { version: number };
    expect(migrated.version).toBe(2);
    expect(JSON.parse(await readFile(path.join(dir, "users.json"), "utf8"))).toEqual(legacy);
  });
});

describe("注册 / 邀请原子性", () => {
  it("一次性邀请：成功扣减一次，复用被拒且不重复扣减", async () => {
    const store = storeAt(tempDir("galgame-authstore-invite-"));
    await store.load();
    const { invite, code } = await store.createInvite({ maxUses: 1 }, "admin");
    const ok = await store.register("bob", "password123", { envCode: "", inviteCode: code, registrationOpen: true });
    expect(ok.ok).toBe(true);
    expect(store.listInvites().find((i) => i.id === invite.id)?.used).toBe(1);
    const reuse = await store.register("carol", "password123", { envCode: "", inviteCode: code, registrationOpen: true });
    expect(reuse).toMatchObject({ ok: false, code: "E_FORBIDDEN" });
    expect(store.listInvites().find((i) => i.id === invite.id)?.used).toBe(1);
  });

  it("重复用户名不消耗邀请（原子回滚）", async () => {
    const store = storeAt(tempDir("galgame-authstore-dup-"));
    await store.load();
    await store.register("bob", "password123", { envCode: "env", inviteCode: "env", registrationOpen: true });
    const { invite, code } = await store.createInvite({}, "admin");
    const dup = await store.register("bob", "password123", { envCode: "", inviteCode: code, registrationOpen: true });
    expect(dup).toMatchObject({ ok: false, code: "E_ID_TAKEN" });
    expect(store.listInvites().find((i) => i.id === invite.id)?.used).toBe(0);
  });

  it("registrationOpen=false 拒绝注册；envCode 共享码不限次数", async () => {
    const store = storeAt(tempDir("galgame-authstore-open-"));
    await store.load();
    const closed = await store.register("bob", "password123", { envCode: "env", inviteCode: "env", registrationOpen: false });
    expect(closed).toMatchObject({ ok: false, code: "E_FORBIDDEN" });
    for (const name of ["alice", "bob", "carol"]) {
      expect((await store.register(name, "password123", { envCode: "env", inviteCode: "env", registrationOpen: true })).ok).toBe(true);
    }
  });

  it("ensureAdmin 提权现有账号必须校验当前密码，避免裸提权", async () => {
    const store = storeAt(tempDir("galgame-authstore-admin-promote-"));
    await store.load();
    await store.register("alice", "password123", { envCode: "env", inviteCode: "env", registrationOpen: true });
    await expect(store.ensureAdmin("alice", "wrongpassword")).rejects.toThrow();
    expect(store.findUser("alice")?.role).toBe("player");
    const promoted = await store.ensureAdmin("alice", "password123");
    expect(promoted.role).toBe("admin");
  });

  it("在途注册以事务内最新开关为准：密码哈希期间关闭注册则不建号", async () => {
    const store = storeAt(tempDir("galgame-authstore-reg-race-"));
    await store.load();
    // register 先做 scrypt；这里在哈希期间排队关闭注册，事务必须看到最新值
    const pending = store.register("alice", "password123", { envCode: "env", inviteCode: "env", registrationOpen: true });
    await store.updateSettings({ registrationOpen: false });
    expect(await pending).toMatchObject({ ok: false, code: "E_FORBIDDEN" });
    expect(store.findUser("alice")).toBeUndefined();
  });

  it("重置凭证一次性：consumeReset 成功后复用失败", async () => {
    const store = storeAt(tempDir("galgame-authstore-reset-"));
    await store.load();
    const reg = await store.register("alice", "password123", { envCode: "env", inviteCode: "env", registrationOpen: true });
    if (!reg.ok) throw new Error("register failed");
    const issued = await store.issueReset(reg.user.userId, 60_000, "admin");
    if (!issued) throw new Error("issue failed");
    expect((await store.consumeReset("alice", issued.credential, "newpassword123")).ok).toBe(true);
    expect((await store.consumeReset("alice", issued.credential, "another12345")).ok).toBe(false);
    expect((await store.verify("alice", "newpassword123"))?.userId).toBe(reg.user.userId);
  });
});

describe("旧库迁移失败即中止（P1-3）", () => {
  it("users 非数组：抛错、不生成 auth.json、旧文件保留", async () => {
    const dir = tempDir("galgame-authstore-migrate-bad1-");
    const legacy = JSON.stringify({ users: { not: "array" } });
    await writeFile(path.join(dir, "users.json"), legacy, "utf8");
    await expect(storeAt(dir).load()).rejects.toBeInstanceOf(AuthStoreCorruptError);
    await expect(readFile(path.join(dir, "auth.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(dir, "users.json"), "utf8")).toBe(legacy);
  });

  it("任一条账号结构非法：整体中止，不静默丢记录", async () => {
    const dir = tempDir("galgame-authstore-migrate-bad2-");
    const legacy = JSON.stringify({
      users: [
        { userId: "u1", username: "alice", passwordHash: "h", createdAt: 1 },
        { userId: 42 },
      ],
    });
    await writeFile(path.join(dir, "users.json"), legacy, "utf8");
    await expect(storeAt(dir).load()).rejects.toBeInstanceOf(AuthStoreCorruptError);
    await expect(readFile(path.join(dir, "auth.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(dir, "users.json"), "utf8")).toBe(legacy);
  });

  it("字段类型不符合 v2（nickname 为数字）：首次加载即中止，不写出下次启动读不了的文件", async () => {
    const dir = tempDir("galgame-authstore-migrate-bad3-");
    const legacy = JSON.stringify({ users: [{ userId: "u1", username: "alice", passwordHash: "h", createdAt: 1, nickname: 42 }] });
    await writeFile(path.join(dir, "users.json"), legacy, "utf8");
    await expect(storeAt(dir).load()).rejects.toBeInstanceOf(AuthStoreCorruptError);
    await expect(readFile(path.join(dir, "auth.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(dir, "users.json"), "utf8")).toBe(legacy);
  });
});

describe("凭据版本复核（P1-4）", () => {
  it("verify 期间凭据被改：不签发（返回 null）", async () => {
    const store = storeAt(tempDir("galgame-authstore-verify-race-"));
    await store.load();
    const reg = await store.register("alice", "password123", { envCode: "env", inviteCode: "env", registrationOpen: true });
    if (!reg.ok) throw new Error("register failed");
    const live = store.getUser(reg.user.userId);
    if (!live) throw new Error("user missing");
    const pending = store.verify("alice", "password123");
    // 校验（scrypt）尚未返回时，另一路重置改了凭据
    live.passwordHash = `${live.passwordHash}-changed`;
    expect(await pending).toBeNull();
  });

  it("verify 期间账号被暂停：不签发", async () => {
    const store = storeAt(tempDir("galgame-authstore-verify-suspend-"));
    await store.load();
    const reg = await store.register("alice", "password123", { envCode: "env", inviteCode: "env", registrationOpen: true });
    if (!reg.ok) throw new Error("register failed");
    const live = store.getUser(reg.user.userId);
    if (!live) throw new Error("user missing");
    const pending = store.verify("alice", "password123");
    live.state = "suspended";
    expect(await pending).toBeNull();
  });

  it("并发改密：仅一次成功，另一次 E_PRECONDITION", async () => {
    const store = storeAt(tempDir("galgame-authstore-pw-race-"));
    await store.load();
    const reg = await store.register("alice", "password123", { envCode: "env", inviteCode: "env", registrationOpen: true });
    if (!reg.ok) throw new Error("register failed");
    const [a, b] = await Promise.all([
      store.changePassword(reg.user.userId, "password123", "newpasswordA1"),
      store.changePassword(reg.user.userId, "password123", "newpasswordB1"),
    ]);
    expect([a, b].filter((o) => o.ok).length).toBe(1);
    expect([a, b].filter((o) => o.code === "E_PRECONDITION").length).toBe(1);
  });
});