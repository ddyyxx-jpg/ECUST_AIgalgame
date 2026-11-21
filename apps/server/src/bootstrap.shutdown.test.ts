/**
 * 关停的端到端探针（PR #125 第三轮复审）。
 *
 * 真进程 smoke（`main.shutdown.test.ts`）只能确定性验证 health/SIGTERM，无法稳定制造"在途 job"
 * （后台任务只由定时器触发，等它恰好卡在 inflight 再发信号是碰运气）。所以这里退到装配层：
 * 用真实 `createApp` + 真实 `JobLedger`（写真实 `data/jobs/<roomId>.jsonl`）+ 注入一个慢任务，
 * 调 `shutdownBackground`，然后**读文件内容**断言在途 job 恰一条 failed、lastError 含 shutdown。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@galgame/testkit";
import { shutdownBackground } from "./background-cycle.ts";
import { createApp } from "./bootstrap.ts";
import type { ServerConfig } from "./config.ts";
import type { JobRecord } from "./job-ledger.ts";

function testConfig(dataDir: string): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir,
    contentDir: "content",
    adminToken: "dev-admin",
    trustUserHeader: true,
    llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
    audit: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1000 },
  };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function readJobs(dataDir: string, roomId: string): Promise<JobRecord[]> {
  const raw = await readFile(path.join(dataDir, "jobs", `${roomId}.jsonl`), "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JobRecord);
}

/** 轮询直到条件成立（文件还没出现时继续轮询，不靠固定 sleep） */
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await predicate()) return;
    } catch {
      // data/jobs/<roomId>.jsonl 还没被创建，继续轮询
    }
    if (Date.now() >= deadline) throw new Error("waitUntil 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("bootstrap 关停（端到端）", () => {
  it("关停时在途 job 的 failed 终态真的落盘（读 JSONL 而非内存对象）", async () => {
    const dataDir = tempDir("galgame-shutdown-e2e-");
    const app = await createApp(testConfig(dataDir));
    expect(app.backgroundTelemetry.terminalPersistFailures).toBe(0);

    const { roomId } = await app.createRoom("solo");
    const taskGate = deferred();
    let jobId = "";
    // 慢任务：不接 signal（与 canonize.retireRoom / gossip.step 的真实签名一致），只能靠释放 gate 结束
    const running = app.background.run(
      roomId,
      { kind: "gossip", basedOnSeq: 1, stallMs: 30_000 },
      async (ctx) => {
        jobId = ctx.jobId;
        await taskGate.promise;
        return { stepped: true };
      },
    );

    // 轮询真实文件直到投影进入 inflight：确保关停时确实有"在途"job
    await waitUntil(async () => (await readJobs(dataDir, roomId)).some((r) => r.id === jobId && r.status === "inflight"));

    const atClose: JobRecord[][] = [];
    await shutdownBackground(app.background, async () => {
      // close 被调用时终态应已落盘：这里读的是磁盘文件，不是 JobLedger 内存
      atClose.push(await readJobs(dataDir, roomId));
    });

    const terminals = atClose[0].filter((r) => r.status === "failed" || r.status === "done");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ id: jobId, status: "failed" });
    expect(terminals[0].lastError).toContain("shutdown");

    // 文件内容与 JobLedger 投影一致，且只写一次 failed
    const onDisk = await readJobs(dataDir, roomId);
    expect(onDisk.filter((r) => r.status === "failed")).toHaveLength(1);
    expect((await app.jobLedger.list(roomId)).find((r) => r.id === jobId)?.status).toBe("failed");

    // run 已返回，但任务体没 settle → 单飞锁仍持有，同房再 run 返回 busy
    expect(await running).toMatchObject({ ok: false, reason: "error" });
    expect(app.background.isBusy(roomId)).toBe(true);
    expect(await app.background.run(roomId, { kind: "gossip", basedOnSeq: 2 }, async () => ({ x: 1 })))
      .toMatchObject({ ok: false, reason: "busy" });

    // 释放任务体后锁才释放
    taskGate.resolve();
    expect(await app.background.waitForIdle(roomId, 1000)).toBe(true);
    expect(app.background.isBusy(roomId)).toBe(false);
  }, 30_000);
});
