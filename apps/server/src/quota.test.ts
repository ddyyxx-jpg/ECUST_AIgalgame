/**
 * 行动额度账本（收敛稿 B1，docs/03 §5.2.10）：状态机 / 每日额度 / 幂等 / 对账 / 重启重建。
 * 断言状态与错误码，不断言文案。
 */
import { describe, expect, it, vi } from "vitest";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tempDir } from "@galgame/testkit";
import { LedgerUnreadableError, TurnLedger, dayKey } from "./quota.ts";

function ledger(): TurnLedger {
  return new TurnLedger(path.join(tempDir("galgame-quota-"), "ledger.jsonl"));
}

const base = { userId: "u_a", roomId: "room_x", dailyLimit: null as number | null, actionsEnabled: true };

describe("TurnLedger 状态机", () => {
  it("reserve → running → committed；todayTurns 计占用态", () => {
    const l = ledger();
    const r = l.reserve({ ...base, clientTurnId: "c1" });
    expect(r.ok).toBe(true);
    expect(l.get("c1")?.state).toBe("reserved");
    expect(l.todayTurns("u_a")).toBe(1);

    l.transition("c1", "running", { turnId: "t1" });
    expect(l.get("c1")?.state).toBe("running");
    l.transition("c1", "committed", { committedSeq: 7 });
    expect(l.get("c1")).toMatchObject({ state: "committed", committedSeq: 7 });
    expect(l.todayTurns("u_a")).toBe(1);
  });

  it("failed 释放额度，且允许同一逻辑 ID 重试", () => {
    const l = ledger();
    l.reserve({ ...base, clientTurnId: "c1" });
    l.transition("c1", "failed");
    expect(l.todayTurns("u_a")).toBe(0);
    const retry = l.reserve({ ...base, clientTurnId: "c1" });
    expect(retry.ok).toBe(true);
    expect(l.get("c1")?.state).toBe("reserved");
  });

  it("已提交重复提交 → E_PRECONDITION 带 committedSeq；running → E_TURN_BUSY", () => {
    const l = ledger();
    l.reserve({ ...base, clientTurnId: "c1" });
    l.transition("c1", "committed", { committedSeq: 9 });
    const dup = l.reserve({ ...base, clientTurnId: "c1" });
    expect(dup).toMatchObject({ ok: false, code: "E_PRECONDITION", committedSeq: 9 });

    l.reserve({ ...base, clientTurnId: "c2" });
    l.transition("c2", "running");
    expect(l.reserve({ ...base, clientTurnId: "c2" })).toMatchObject({ ok: false, code: "E_TURN_BUSY" });
    // 同一用户另有 running 时，新逻辑 ID 也被挡
    expect(l.reserve({ ...base, clientTurnId: "c3" })).toMatchObject({ ok: false, code: "E_TURN_BUSY" });
  });

  it("unconfirmed 保守占用额度；管理员仅可结案 unconfirmed，running/committed 不可覆盖", async () => {
    const l = ledger();
    l.reserve({ ...base, clientTurnId: "c1" });
    l.transition("c1", "unconfirmed");
    expect(l.todayTurns("u_a")).toBe(1);
    expect(l.reserve({ ...base, clientTurnId: "c1" })).toMatchObject({ ok: false, code: "E_PRECONDITION" });

    const resolved = await l.resolve("c1", "committed", 12);
    expect(resolved).toMatchObject({ ok: true, entry: { state: "committed", committedSeq: 12 } });
    // 已提交不可被再结案覆盖
    expect(await l.resolve("c1", "failed")).toMatchObject({ ok: false, code: "E_ILLEGAL_OP" });
    expect(l.get("c1")?.state).toBe("committed");

    l.reserve({ ...base, clientTurnId: "c2" });
    l.transition("c2", "running");
    expect(await l.resolve("c2", "failed")).toMatchObject({ ok: false, code: "E_ILLEGAL_OP" });
    expect(l.get("c2")?.state).toBe("running");

    expect(await l.resolve("missing", "failed")).toMatchObject({ ok: false, code: "E_REF_NOT_FOUND" });
  });

  it("人工结案写盘失败：返回 E_STORE_FAULT 且保持 unconfirmed，可重试", async () => {
    const dir = tempDir("galgame-quota-resolve-fail-");
    const blocker = path.join(dir, "blocker");
    await writeFile(blocker, "x", "utf8");
    const l = new TurnLedger(path.join(blocker, "ledger.jsonl"));
    l.reserve({ ...base, clientTurnId: "c1" });
    l.transition("c1", "unconfirmed");

    const failed = await l.resolve("c1", "committed", 9);
    expect(failed).toMatchObject({ ok: false, code: "E_STORE_FAULT" });
    expect(l.get("c1")?.state).toBe("unconfirmed");
  });

  it("每日额度上限 → E_RATE_LIMITED；null 不限；总开关关闭 → E_RATE_LIMITED", () => {
    const l = ledger();
    expect(l.reserve({ ...base, clientTurnId: "c1", dailyLimit: 1 }).ok).toBe(true);
    expect(l.reserve({ ...base, clientTurnId: "c2", dailyLimit: 1 })).toMatchObject({ ok: false, code: "E_RATE_LIMITED" });
    // 不同用户互不影响
    expect(l.reserve({ ...base, userId: "u_b", clientTurnId: "c3", dailyLimit: 1 }).ok).toBe(true);
    // 总开关
    expect(l.reserve({ ...base, userId: "u_c", clientTurnId: "c4", actionsEnabled: false })).toMatchObject({ ok: false, code: "E_RATE_LIMITED" });
  });

  it("按本地日界计数；跨天不占今日额度", () => {
    const l = ledger();
    const day1 = new Date("2026-11-18T10:00:00").getTime();
    const day2 = new Date("2026-11-19T10:00:00").getTime();
    l.reserve({ ...base, clientTurnId: "c1", dailyLimit: 1, now: day1 });
    expect(l.todayTurns("u_a", day1)).toBe(1);
    expect(l.todayTurns("u_a", day2)).toBe(0);
    expect(l.reserve({ ...base, clientTurnId: "c2", dailyLimit: 1, now: day2 }).ok).toBe(true);
    expect(dayKey(day1)).toBe("2026-11-18");
  });

  it("重启从 JSONL 重建：取每个逻辑 ID 的最后状态", async () => {
    const file = path.join(tempDir("galgame-quota-reload-"), "ledger.jsonl");
    const l1 = new TurnLedger(file);
    l1.reserve({ ...base, clientTurnId: "c1" });
    l1.transition("c1", "running");
    l1.transition("c1", "committed", { committedSeq: 3 });
    l1.reserve({ ...base, clientTurnId: "c2" });
    l1.transition("c2", "failed");
    // 等串行写盘落定（P1-2：用 flush 替代固定 sleep，消除首跑竞态）
    await l1.flush();

    const l2 = new TurnLedger(file);
    await l2.load();
    expect(l2.get("c1")).toMatchObject({ state: "committed", committedSeq: 3 });
    expect(l2.get("c2")?.state).toBe("failed");
    expect(l2.todayTurns("u_a")).toBe(1);
  });

  it("重启恢复（P1-2）：遗留 running → unconfirmed、reserved → failed，不永久阻塞", async () => {
    const file = path.join(tempDir("galgame-quota-recover-"), "ledger.jsonl");
    const l1 = new TurnLedger(file);
    l1.reserve({ ...base, clientTurnId: "run" });
    l1.reserve({ ...base, clientTurnId: "res" });
    l1.transition("run", "running");
    await l1.flush();

    const l2 = new TurnLedger(file);
    await l2.load();
    expect(l2.get("run")?.state).toBe("unconfirmed");
    expect(l2.get("res")?.state).toBe("failed");
    // 幽灵 running 不再挡住新行动
    expect(l2.reserve({ ...base, clientTurnId: "next" }).ok).toBe(true);
  });

  it("账本读取失败（非 ENOENT）→ 抛 LedgerUnreadableError，不静默当空账本", async () => {
    const dir = tempDir("galgame-quota-unreadable-");
    const file = path.join(dir, "ledger.jsonl");
    await mkdir(file); // 对目录 readFile → EISDIR（非 ENOENT 的读取失败）
    await expect(new TurnLedger(file).load()).rejects.toBeInstanceOf(LedgerUnreadableError);
  });

  it("作用域隔离（P1-1）：不同账号/房间用同一 clientTurnId 互不影响", () => {
    const l = ledger();
    expect(l.reserve({ ...base, userId: "u_a", roomId: "r1", actorId: "plr_1", clientTurnId: "same" }).ok).toBe(true);
    l.transition({ userId: "u_a", roomId: "r1", clientTurnId: "same" }, "committed", { committedSeq: 1 });
    // 另一账号同 ID = 全新请求
    expect(l.reserve({ ...base, userId: "u_b", roomId: "r2", actorId: "plr_2", clientTurnId: "same" }).ok).toBe(true);
    // 同账号不同房间同 ID 也不冲突
    expect(l.reserve({ ...base, userId: "u_a", roomId: "r2", actorId: "plr_1", clientTurnId: "same" }).ok).toBe(true);
  });

  it("同账号+房间+ID 换角色 → E_PRECONDITION", () => {
    const l = ledger();
    l.reserve({ ...base, actorId: "plr_1", clientTurnId: "c1" });
    l.transition({ userId: "u_a", roomId: "room_x", clientTurnId: "c1" }, "failed");
    expect(l.reserve({ ...base, actorId: "plr_2", clientTurnId: "c1" })).toMatchObject({ ok: false, code: "E_PRECONDITION" });
  });

  it("transitionDurable：写盘失败向调用方抛错（不假装已开跑）", async () => {
    const dir = tempDir("galgame-quota-durable-");
    const blocker = path.join(dir, "blocker");
    await writeFile(blocker, "x", "utf8");
    // 父路径是普通文件：mkdir/append 必失败
    const l = new TurnLedger(path.join(blocker, "ledger.jsonl"));
    expect(l.reserve({ ...base, clientTurnId: "c1" }).ok).toBe(true);
    await expect(l.transitionDurable({ userId: "u_a", roomId: "room_x", clientTurnId: "c1" }, "running")).rejects.toThrow();
    // flush 仍是"尽力而为"投影写；关键状态由调用方用 transitionDurable 判定
    await expect(l.flush()).resolves.toBeUndefined();
  });

  it("transitionDurable 返回即已落盘：不 flush 也能被下一进程读回（fsync 语义）", async () => {
    const file = path.join(tempDir("galgame-quota-durable-fsync-"), "ledger.jsonl");
    const l1 = new TurnLedger(file);
    l1.reserve({ ...base, clientTurnId: "c1" });
    await l1.flush();
    await l1.transitionDurable({ userId: "u_a", roomId: "room_x", clientTurnId: "c1" }, "committed", { committedSeq: 8 });

    const l2 = new TurnLedger(file);
    await l2.load();
    expect(l2.get("c1")).toMatchObject({ state: "committed", committedSeq: 8 });
  });

  it("坏行（崩溃留下的半截尾行/结构不符）加载时跳过、计数并告警", async () => {
    const file = path.join(tempDir("galgame-quota-tail-"), "ledger.jsonl");
    const good = JSON.stringify({ clientTurnId: "c1", roomId: "r1", userId: "u_a", state: "committed", day: "2026-11-18", reservedAt: 1 });
    await writeFile(file, `${good}\n{"clientTurnId":"c2","roomId":"r1"\n{"clientTurnId":1}\n`, "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const l = new TurnLedger(file);
      await l.load();
      expect(l.get("c1")?.state).toBe("committed");
      expect(l.skippedLines).toBe(2);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("无换行的半截尾行不会吞掉重启后的第一条追加记录", async () => {
    const file = path.join(tempDir("galgame-quota-tail-append-"), "ledger.jsonl");
    const good = JSON.stringify({ clientTurnId: "c1", roomId: "r1", userId: "u_a", state: "committed", day: "2026-11-18", reservedAt: 1 });
    // 模拟崩溃：最后一条 JSON 只写了一半，且没有换行
    await writeFile(file, `${good}\n{"clientTurnId":"broken","roomId":"r1"`, "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const l1 = new TurnLedger(file);
      await l1.load();
      expect(l1.skippedLines).toBe(1);
      l1.reserve({ ...base, clientTurnId: "c2" });
      await l1.transitionDurable({ userId: "u_a", roomId: "room_x", clientTurnId: "c2" }, "committed", { committedSeq: 5 });

      // 重启后新记录必须仍可解析：追加前若没补换行，它会和半截尾行粘成一条坏行
      const l2 = new TurnLedger(file);
      await l2.load();
      expect(l2.get("c2")).toMatchObject({ state: "committed", committedSeq: 5 });
    } finally {
      warn.mockRestore();
    }
  });

  it("进程内短写留下半截尾行后，下一条追加仍从新行开始", async () => {
    const file = path.join(tempDir("galgame-quota-short-write-"), "ledger.jsonl");
    const l1 = new TurnLedger(file);
    l1.reserve({ ...base, clientTurnId: "c1" });
    await l1.flush();
    // 模拟一次短写：只落了半截 JSON，且没有换行；进程内没有再 load 过
    await appendFile(file, '{"clientTurnId":"short"', "utf8");

    await l1.transitionDurable({ userId: "u_a", roomId: "room_x", clientTurnId: "c1" }, "committed", { committedSeq: 6 });
    const l2 = new TurnLedger(file);
    await l2.load();
    expect(l2.get("c1")).toMatchObject({ state: "committed", committedSeq: 6 });
  });

  it("list 按 userId/state 过滤", () => {
    const l = ledger();
    l.reserve({ ...base, clientTurnId: "c1" });
    l.reserve({ ...base, userId: "u_b", clientTurnId: "c2" });
    l.transition("c2", "failed");
    expect(l.list({ userId: "u_a" }).map((e) => e.clientTurnId)).toEqual(["c1"]);
    expect(l.list({ state: "failed" }).map((e) => e.clientTurnId)).toEqual(["c2"]);
  });
});