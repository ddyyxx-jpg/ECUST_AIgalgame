import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@galgame/testkit";
import { BackgroundCycle } from "./background-cycle.ts";
import { JobLedger } from "./job-ledger.ts";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function idSequence() {
  let n = 0;
  return () => `job_${++n}`;
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

  it("看门狗：stallMs=25ms 真实计时， abort signal + stalled + lastError 含 stalled", async () => {
    const dir = tempDir("bg-cycle-");
    const ledger = new JobLedger(dir);
    const cycle = new BackgroundCycle({ ledger, defaultStallMs: 25 });
    let seen: AbortSignal | undefined;
    const out = await cycle.run(
      "room_a",
      { kind: "canonize", basedOnSeq: 1, stallMs: 25 },
      async ({ signal }) => {
        seen = signal;
        return new Promise<never>(() => {}); // 故意忽略 abort，验证结果不靠 task 配合
      },
    );

    expect(out).toMatchObject({ ok: false, reason: "stalled" });
    expect(seen?.aborted).toBe(true);
    expect((await ledger.list("room_a"))[0]?.lastError).toContain("stalled");
    expect(cycle.isBusy("room_a")).toBe(false);
  });

  it("waitForIdle：超时 false，任务结束 true", async () => {
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

  it("abortAll：中止全部在途、标记 failed、已结束跳过", async () => {
    const dir = tempDir("bg-cycle-");
    const ledger = new JobLedger(dir);
    const cycle = new BackgroundCycle({ ledger });
    const g1 = deferred();
    const g2 = deferred();
    let s1: AbortSignal | undefined;
    let s2: AbortSignal | undefined;
    const r1 = cycle.run("room_a", { kind: "canonize", basedOnSeq: 1 }, async ({ signal }) => {
      s1 = signal;
      await g1.promise;
    });
    const r2 = cycle.run("room_b", { kind: "gossip", basedOnSeq: 1 }, async ({ signal }) => {
      s2 = signal;
      await g2.promise;
    });
    // 一个已结束的任务：abortAll 不应改它的最终状态
    await cycle.run("room_c", { kind: "gossip", basedOnSeq: 1 }, async () => ({ done: true }));

    await cycle.abortAll("shutdown");
    expect(s1?.aborted).toBe(true);
    expect(s2?.aborted).toBe(true);
    expect(s1?.reason).toBe("shutdown");
    expect(await r1).toMatchObject({ ok: false, reason: "error", error: "aborted" });
    expect(await r2).toMatchObject({ ok: false, error: "aborted" });
    expect(cycle.isBusy("room_a")).toBe(false);
    expect(cycle.isBusy("room_b")).toBe(false);
    for (const room of ["room_a", "room_b"]) {
      const last = (await ledger.list(room))[0];
      expect(["shutdown", "aborted"]).toContain(last?.lastError);
      expect(last?.status).toBe("failed");
    }
    expect((await ledger.list("room_c"))[0]).toMatchObject({ status: "done", receipt: { done: true } });

    // 幂等：没有在途任务时不再产生写入
    await cycle.abortAll();
  });
});
