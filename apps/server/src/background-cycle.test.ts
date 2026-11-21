import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "@galgame/testkit";
import { BackgroundCycle, shutdownBackground } from "./background-cycle.ts";
import { JobLedger, type JobRecord } from "./job-ledger.ts";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 轮询直到条件成立（CI 高负载下比固定 sleep 稳，也不靠 sleep 本身当断言） */
async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error("waitUntil 超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function idSequence() {
  let n = 0;
  return () => `job_${++n}`;
}

async function records(dir: string, roomId: string): Promise<JobRecord[]> {
  const raw = await readFile(path.join(dir, `${roomId}.jsonl`), "utf8");
  return raw.trim().split("\n").map((l) => JSON.parse(l) as JobRecord);
}

/**
 * 终态 transition 可延迟的 JobLedger：把"投影写入中"的窗口拉长，用来复现 PR #125 复审 P3
 * 的慢 I/O 竞态（finished 已开始写、任务 settle / 看门狗在同一窗口内发生）。
 */
class SlowTerminalLedger extends JobLedger {
  private delayStatus: "done" | "failed" | null = null;
  private releaseDelay!: () => void;
  private readonly delayGate = new Promise<void>((resolve) => {
    this.releaseDelay = resolve;
  });
  private markDelayed!: () => void;
  private readonly delayedStarted = new Promise<void>((resolve) => {
    this.markDelayed = resolve;
  });

  /** 让下一次指定终态的 transition 卡住，直到 release() */
  holdNextTerminal(status: "done" | "failed"): void {
    this.delayStatus = status;
  }

  waitUntilDelayed(): Promise<void> {
    return this.delayedStarted;
  }

  release(): void {
    this.releaseDelay();
  }

  override async transition(
    roomId: string,
    id: string,
    patch: Partial<Pick<JobRecord, "status" | "attempts" | "lastError" | "receipt">>,
  ): Promise<JobRecord | null> {
    if (patch.status === this.delayStatus) {
      this.delayStatus = null;
      this.markDelayed();
      await this.delayGate;
    }
    return super.transition(roomId, id, patch);
  }
}

/** 终态 transition 抛错的 JobLedger：断言终态写失败的可观测性（计数 + 固定日志关键字） */
class FailingTerminalLedger extends JobLedger {
  override async transition(
    roomId: string,
    id: string,
    patch: Partial<Pick<JobRecord, "status" | "attempts" | "lastError" | "receipt">>,
  ): Promise<JobRecord | null> {
    if (patch.status === "done") throw new Error("disk full");
    return super.transition(roomId, id, patch);
  }
}

describe("BackgroundCycle", () => {
  it("成功：done + receipt，锁释放，投影走完 prepared→inflight→done", async () => {
    const dir = tempDir("bg-cycle-");
    const ledger = new JobLedger(dir);
    const cycle = new BackgroundCycle({ ledger, now: () => 1000, idFactory: idSequence() });
    const out = await cycle.run("room_a", { kind: "canonize", basedOnSeq: 5 }, async ({ signal, jobId }) => {
      expect(signal.aborted).toBe(false);
      expect(jobId).toBe("job_1");
      return { retired: true };
    });

    expect(out).toMatchObject({ ok: true, jobId: "job_1" });
    expect(cycle.isBusy("room_a")).toBe(false);
    expect(cycle.inflight("room_a")).toBeNull();
    const raw = await readFile(path.join(dir, "room_a.jsonl"), "utf8");
    expect(raw.trim().split("\n").map((l) => (JSON.parse(l) as { status: string }).status))
      .toEqual(["prepared", "inflight", "done"]);
    expect((await ledger.list("room_a"))[0]).toMatchObject({
      status: "done", attempts: 1, basedOnSeq: 5, createdAt: 1000, receipt: { retired: true },
    });
  });

  it("同房并发直接 busy（不排队、不抛错），异房可并行", async () => {
    const cycle = new BackgroundCycle();
    const gate = deferred();
    const first = cycle.run("room_a", { kind: "canonize", basedOnSeq: 1 }, async () => {
      await gate.promise;
    });
    expect(cycle.isBusy("room_a")).toBe(true);
    expect(cycle.inflight("room_a")).toMatchObject({ kind: "canonize", jobId: expect.any(String), startedAt: expect.any(Number) });

    expect(await cycle.run("room_a", { kind: "gossip", basedOnSeq: 2 }, async () => ({ x: 1 })))
      .toEqual({ ok: false, reason: "busy" });
    expect(await cycle.run("room_b", { kind: "gossip", basedOnSeq: 2 }, async () => ({ x: 1 })))
      .toMatchObject({ ok: true });

    gate.resolve();
    await first;
    expect(cycle.isBusy("room_a")).toBe(false);
  });

  it("task 抛错 → error + ledger failed(lastError=message)，锁释放", async () => {
    const dir = tempDir("bg-cycle-");
    const ledger = new JobLedger(dir);
    const cycle = new BackgroundCycle({ ledger });
    const out = await cycle.run("room_a", { kind: "gossip", basedOnSeq: 3 }, async () => {
      throw new Error("boom");
    });

    expect(out).toMatchObject({ ok: false, reason: "error", error: "boom" });
    expect((await ledger.list("room_a"))[0]).toMatchObject({ status: "failed", lastError: "boom", attempts: 1 });
    expect(cycle.isBusy("room_a")).toBe(false);
  });

  it("看门狗：超时只结束本次结果；锁跟任务体 settle，同房再 run 返回 busy", async () => {
    const dir = tempDir("bg-cycle-");
    const ledger = new JobLedger(dir);
    const cycle = new BackgroundCycle({ ledger, defaultStallMs: 25 });
    const taskGate = deferred();
    let seen: AbortSignal | undefined;
    let jobId = "";
    const first = cycle.run(
      "room_a",
      { kind: "canonize", basedOnSeq: 1, stallMs: 25 },
      async ({ signal, jobId: id }) => {
        seen = signal;
        jobId = id;
        // 任务体签名不接 signal：abort 之后它照常继续跑（真实的 retireRoom/step 就是这样）
        await taskGate.promise;
        return { late: true };
      },
    );

    const out = await first;
    expect(out).toMatchObject({ ok: false, reason: "stalled" });
    expect(seen?.aborted).toBe(true);
    expect((await ledger.list("room_a")).find((r) => r.id === jobId)).toMatchObject({ status: "failed" });

    // 回归 PR #125 P1-1：stall 后任务体还在跑，锁不许放
    expect(cycle.isBusy("room_a")).toBe(true);
    expect(await cycle.run("room_a", { kind: "gossip", basedOnSeq: 2 }, async () => ({ x: 1 })))
      .toEqual({ ok: false, reason: "busy" });

    // 旧任务体真正 resolve 后才放锁、waitForIdle 才为 true，下一拍才能进
    taskGate.resolve();
    expect(await cycle.waitForIdle("room_a", 1000)).toBe(true);
    expect(cycle.isBusy("room_a")).toBe(false);
    const next = await cycle.run("room_a", { kind: "gossip", basedOnSeq: 2 }, async () => ({ x: 1 }));
    expect(next).toMatchObject({ ok: true });

    // 迟到的任务体不得把 failed 覆盖成 done
    const recs = await ledger.list("room_a");
    expect(recs.find((r) => r.id === jobId)).toMatchObject({ status: "failed" });
    expect(recs).toHaveLength(2);
  });

  // PR #125 复审 P3（background-cycle.ts:111）：旧闸门先置 written 再 await，慢 I/O 下
  // finished 占位后卡住、aborted 赢 race → run 返回 stalled 但最终落盘 done。
  it("慢终态写入 + 看门狗：任务已完成时以任务为准，不出现 stalled 却落盘 done", async () => {
    const dir = tempDir("bg-cycle-");
    const ledger = new SlowTerminalLedger(dir);
    const cycle = new BackgroundCycle({ ledger, defaultStallMs: 20, idFactory: idSequence() });
    const taskGate = deferred();
    ledger.holdNextTerminal("done");
    const running = cycle.run("room_a", { kind: "canonize", basedOnSeq: 1, stallMs: 20 }, async () => {
      await taskGate.promise;
      return { late: true };
    });

    taskGate.resolve();
    await ledger.waitUntilDelayed(); // done 写入已开始，但卡在慢 I/O
    // 轮询等看门狗触发（它必须在写入窗口内触发过；旧实现会在这里被 aborted 抢走 race）
    await waitUntil(() => cycle.telemetry.watchdogFires >= 1, 2000);
    expect(cycle.isBusy("room_a")).toBe(true);
    ledger.release();

    const out = await running;
    // 任务体已完成 → run 结果必须与落盘一致；不允许被迟到的看门狗改写成 stalled
    expect(out).toMatchObject({ ok: true, jobId: "job_1" });
    const terminals = (await records(dir, "room_a")).filter(
      (r) => r.status === "done" || r.status === "failed",
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ status: "done" });
    expect(cycle.isBusy("room_a")).toBe(false);
  });

  it("abort 收尾的 failed 写入延迟 + 任务在该窗口内完成：终态仍只有 failed、结果一致", async () => {
    const dir = tempDir("bg-cycle-");
    const ledger = new SlowTerminalLedger(dir);
    const cycle = new BackgroundCycle({ ledger, defaultStallMs: 20, idFactory: idSequence() });
    const taskGate = deferred();
    ledger.holdNextTerminal("failed");
    const running = cycle.run("room_a", { kind: "gossip", basedOnSeq: 1, stallMs: 20 }, async () => {
      await taskGate.promise;
      return { late: true };
    });

    await ledger.waitUntilDelayed(); // 看门狗已触发，abort 分支正在写 failed（慢 I/O）
    taskGate.resolve(); // 任务体在这个写入窗口内完成
    // 轮询等 finished 跳过写入并放锁（它看到 gate.writing 后直接收尾）
    await waitUntil(() => !cycle.isBusy("room_a"), 2000);
    ledger.release();

    const out = await running;
    expect(out).toMatchObject({ ok: false, reason: "stalled" });
    const terminals = (await records(dir, "room_a")).filter(
      (r) => r.status === "done" || r.status === "failed",
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ status: "failed" });
  });

  it("waitForIdle：超时 false，任务体结束（而不是 run 返回）才 true", async () => {
    const cycle = new BackgroundCycle();
    const gate = deferred();
    const running = cycle.run("room_a", { kind: "gossip", basedOnSeq: 1 }, async () => {
      await gate.promise;
    });
    expect(await cycle.waitForIdle("room_a", 20)).toBe(false);

    const waiter = cycle.waitForIdle("room_a", 1000);
    gate.resolve();
    expect(await waiter).toBe(true);
    await running;
    expect(await cycle.waitForIdle("room_a", 10)).toBe(true);
  });

  it("abortAll：abort 在途、终态只写一次；任务体未 settle 前仍 busy", async () => {
    const dir = tempDir("bg-cycle-");
    const ledger = new JobLedger(dir);
    const cycle = new BackgroundCycle({ ledger });
    const g1 = deferred();
    const g2 = deferred();
    let s1: AbortSignal | undefined;
    let s2: AbortSignal | undefined;
    let jobA = "";
    let jobB = "";
    const r1 = cycle.run("room_a", { kind: "canonize", basedOnSeq: 1 }, async ({ signal, jobId }) => {
      s1 = signal;
      jobA = jobId;
      await g1.promise;
    });
    const r2 = cycle.run("room_b", { kind: "gossip", basedOnSeq: 1 }, async ({ signal, jobId }) => {
      s2 = signal;
      jobB = jobId;
      await g2.promise;
    });
    // 一个已结束的任务：abortAll 不应改它的最终状态
    await cycle.run("room_c", { kind: "gossip", basedOnSeq: 1 }, async () => ({ done: true }));

    await cycle.abortAll("shutdown");
    expect(s1?.aborted).toBe(true);
    expect(s2?.aborted).toBe(true);
    expect(s1?.reason).toBe("shutdown");
    expect(await r1).toMatchObject({ ok: false, reason: "error" });
    expect(await r2).toMatchObject({ ok: false, reason: "error" });

    // PR #125 P1-1：run 已经返回，但任务体还在跑 → 锁还在
    expect(cycle.isBusy("room_a")).toBe(true);
    expect(cycle.isBusy("room_b")).toBe(true);
    expect(await cycle.run("room_a", { kind: "gossip", basedOnSeq: 2 }, async () => ({ x: 1 })))
      .toEqual({ ok: false, reason: "busy" });

    // 每个 job 的 failed 只写一次：prepared / inflight / failed 三行，没有 abortAll 的第二条 failed
    for (const [room, jobId] of [["room_a", jobA], ["room_b", jobB]] as const) {
      const lines = (await records(dir, room)).filter((r) => r.id === jobId);
      expect(lines.map((r) => r.status)).toEqual(["prepared", "inflight", "failed"]);
      expect(lines.filter((r) => r.status === "failed")).toHaveLength(1);
      expect(lines.find((r) => r.status === "failed")?.lastError).toContain("shutdown");
    }

    // 任务体 settle 后才放锁
    g1.resolve();
    g2.resolve();
    expect(await cycle.waitForIdle("room_a", 1000)).toBe(true);
    expect(cycle.isBusy("room_b")).toBe(false);
    expect(await cycle.run("room_a", { kind: "gossip", basedOnSeq: 2 }, async () => ({ x: 1 })))
      .toMatchObject({ ok: true });

    // 已结束的 room_c 不受影响
    expect((await ledger.list("room_c"))[0]).toMatchObject({ status: "done", receipt: { done: true } });

    // 幂等：没有在途任务时再 abortAll 不产生写入
    const before = await readFile(path.join(dir, "room_a.jsonl"), "utf8");
    await cycle.abortAll();
    expect(await readFile(path.join(dir, "room_a.jsonl"), "utf8")).toBe(before);
  });

  it("shutdownBackground：终态先落盘再关闭资源；锁仍跟随任务体", async () => {
    const dir = tempDir("bg-cycle-");
    const ledger = new JobLedger(dir);
    const cycle = new BackgroundCycle({ ledger });
    let signalSeen: AbortSignal | undefined;
    let jobId = "";
    const never = new Promise<never>(() => {});
    const running = cycle.run("room_a", { kind: "gossip", basedOnSeq: 1 }, async (ctx) => {
      signalSeen = ctx.signal;
      jobId = ctx.jobId;
      await never;
    });

    const duringClose: string[] = [];
    await shutdownBackground(cycle, async () => {
      const rec = (await ledger.list("room_a")).find((r) => r.id === jobId);
      duringClose.push(`${rec?.status}:${rec?.lastError ?? ""}`);
    }, "SIGTERM");

    expect(signalSeen?.aborted).toBe(true);
    // close 被调用时 failed 终态已经写完（abortAll 等 run 收尾，不等任务体）
    expect(duringClose).toHaveLength(1);
    expect(duringClose[0]).toContain("failed");
    expect(duringClose[0]).toContain("shutdown");
    // 任务体没 settle，锁不释放
    expect(cycle.isBusy("room_a")).toBe(true);
    expect(await running).toMatchObject({ ok: false, reason: "error" });
  });

  it("终态投影写失败：固定日志关键字 + 进程内计数，不重试也不改 run 结果", async () => {
    const dir = tempDir("bg-cycle-");
    const ledger = new FailingTerminalLedger(dir);
    const cycle = new BackgroundCycle({ ledger, idFactory: idSequence() });
    const warns: unknown[][] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warns.push(args);
    });
    try {
      const out = await cycle.run("room_a", { kind: "canonize", basedOnSeq: 1 }, async () => ({ retired: true }));
      // 投影写失败不阻断任务：run 仍报 done，锁释放
      expect(out).toMatchObject({ ok: true, jobId: "job_1" });
      expect(cycle.isBusy("room_a")).toBe(false);

      // 可观测性：进程内计数 +1，且留下固定日志关键字（不重试，所以只 +1 次）
      expect(cycle.telemetry.terminalPersistFailures).toBe(1);
      expect(warns.some((args) => String(args[0]).includes("[bg] terminal persist failed"))).toBe(true);

      // 写失败不重试：磁盘上停在 prepared/inflight 两行，没有第三条终态
      expect((await records(dir, "room_a")).map((r) => r.status)).toEqual(["prepared", "inflight"]);
    } finally {
      spy.mockRestore();
    }
  });
});
