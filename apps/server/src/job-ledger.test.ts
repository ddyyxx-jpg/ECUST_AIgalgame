import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "@galgame/testkit";
import { JobLedger, type JobRecord } from "./job-ledger.ts";

function rec(id: string, patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id,
    kind: "canonize",
    roomId: "room_a",
    basedOnSeq: 7,
    status: "prepared",
    attempts: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...patch,
  };
}

describe("JobLedger", () => {
  it("追加后 list 取每个 id 的最后状态", async () => {
    const dir = tempDir("job-ledger-");
    const ledger = new JobLedger(dir);
    await ledger.append(rec("j1"));
    await ledger.append(rec("j1", { status: "inflight", attempts: 1 }));
    await ledger.append(rec("j2", { kind: "gossip" }));

    const list = await ledger.list("room_a");
    expect(list).toHaveLength(2);
    expect(list.find((r) => r.id === "j1")).toMatchObject({ status: "inflight", attempts: 1 });
    expect(list.find((r) => r.id === "j2")).toMatchObject({ kind: "gossip", status: "prepared" });
  });

  it("transition 合并 patch、保留未给字段并刷新 updatedAt", async () => {
    const dir = tempDir("job-ledger-");
    const ledger = new JobLedger(dir);
    await ledger.append(rec("j1", { attempts: 2, receipt: { old: true } }));
    const next = await ledger.transition("room_a", "j1", { status: "failed", lastError: "boom" });

    expect(next).toMatchObject({
      id: "j1",
      kind: "canonize",
      basedOnSeq: 7,
      status: "failed",
      attempts: 2,
      lastError: "boom",
      receipt: { old: true },
    });
    expect(next!.updatedAt).toBeGreaterThanOrEqual(1000);
    expect(await ledger.transition("room_a", "missing", { status: "done" })).toBeNull();
  });

  it("坏行跳过并 warn，不影响好记录", async () => {
    const dir = tempDir("job-ledger-");
    await mkdir(path.join(dir), { recursive: true });
    await appendFile(path.join(dir, "room_a.jsonl"), [
      JSON.stringify(rec("j1")),
      "{not json",
      "123",
      JSON.stringify({ id: "bad", status: "unknown" }),
      "",
      JSON.stringify(rec("j2")),
    ].join("\n") + "\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const list = await new JobLedger(dir).list("room_a");
      expect(list.map((r) => r.id)).toEqual(["j1", "j2"]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("reconcile 把 prepared/deferred 归 runnable，inflight 归 orphaned", async () => {
    const dir = tempDir("job-ledger-");
    const ledger = new JobLedger(dir);
    await ledger.append(rec("p", { status: "prepared" }));
    await ledger.append(rec("d", { status: "deferred" }));
    await ledger.append(rec("f", { status: "inflight" }));
    await ledger.append(rec("x", { status: "done" }));

    const { runnable, orphaned } = await ledger.reconcile("room_a");
    expect(runnable.map((r) => r.id).sort()).toEqual(["d", "p"]);
    expect(orphaned.map((r) => r.id)).toEqual(["f"]);
  });

  it("拒绝路径穿越式 roomId", async () => {
    const ledger = new JobLedger(tempDir("job-ledger-"));
    await expect(ledger.list("../escape")).rejects.toThrow(/非法 roomId/);
    await expect(ledger.append(rec("j1", { roomId: "a/b" }))).rejects.toThrow(/非法 roomId/);
    await expect(ledger.transition("../escape", "j1", { status: "done" })).rejects.toThrow(/非法 roomId/);
  });

  it("新建同 dir 的实例（模拟重启）仍能读回投影", async () => {
    const dir = tempDir("job-ledger-");
    await new JobLedger(dir).append(rec("j1", { status: "done", receipt: { retired: true } }));

    const reopened = new JobLedger(dir);
    expect(await reopened.list("room_a")).toMatchObject([
      { id: "j1", status: "done", receipt: { retired: true } },
    ]);
    // 重启后追加不会覆盖旧内容
    await reopened.append(rec("j2", { status: "prepared" }));
    expect((await new JobLedger(dir).list("room_a")).map((r) => r.id)).toEqual(["j1", "j2"]);
  });

  it("文件不存在时 list 返回空数组（而非抛错）", async () => {
    expect(await new JobLedger(tempDir("job-ledger-")).list("room_never")).toEqual([]);
  });

  it("同文件并发 append 不丢行", async () => {
    const dir = tempDir("job-ledger-");
    const ledger = new JobLedger(dir);
    await Promise.all(Array.from({ length: 20 }, (_, i) => ledger.append(rec(`j${i}`))));
    const raw = await readFile(path.join(dir, "room_a.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(20);
  });
});
