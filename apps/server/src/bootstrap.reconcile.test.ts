/**
 * 重启对账的端到端探针（PR #125 P1-2）。
 *
 * 这里刻意用真实 `createApp`（而不是手工调 `JobLedger.reconcile`）：
 * 审阅指出「恢复/对账零端到端证据」，要验证装配层启动时真的把遗留 inflight 标成 failed、
 * prepared 留 backlog 不自动重放、坏行不拖垮启动。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@galgame/testkit";
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

function job(roomId: string, patch: Partial<JobRecord>): JobRecord {
  const ts = 1_700_000_000_000;
  return {
    id: "job_seed",
    kind: "canonize",
    roomId,
    basedOnSeq: 1,
    status: "prepared",
    attempts: 0,
    createdAt: ts,
    updatedAt: ts,
    ...patch,
  };
}

describe("bootstrap 启动对账（端到端）", () => {
  it("预置的遗留 inflight 被标 failed、prepared 留 backlog、计数正确且不抛", async () => {
    const dataDir = tempDir("galgame-reconcile-");
    const cfg = testConfig(dataDir);

    // ① 先用真实装配建一个房间：对账只遍历真实房间（FileStore.listRooms 读 data/rooms/*.jsonl）
    const first = await createApp(cfg);
    const { roomId } = await first.createRoom("solo");

    // ② 手工预置"上个进程崩溃时的投影"：一条 inflight、一条 prepared、一条 done，外加一行坏数据
    const jobsDir = path.join(dataDir, "jobs");
    await mkdir(jobsDir, { recursive: true });
    const jobsFile = path.join(jobsDir, `${roomId}.jsonl`);
    const seed = [
      job(roomId, { id: "job_old_inflight", status: "inflight", attempts: 1, updatedAt: 1_700_000_001_000 }),
      job(roomId, { id: "job_backlog", kind: "gossip", status: "prepared" }),
      job(roomId, { id: "job_done", status: "done", receipt: { retired: true } }),
      "{broken json",
    ];
    await writeFile(jobsFile, seed.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n", "utf8");

    // ③ 模拟进程重启：再次 createApp，启动对账应把 inflight 转 failed
    const second = await createApp(cfg);
    expect(second.jobReconcile).toMatchObject({
      rooms: 1,
      orphaned: 1,
      failed: 1,
      runnable: 1,
    });

    const projected = await second.jobLedger.list(roomId);
    expect(projected.find((r) => r.id === "job_old_inflight")).toMatchObject({
      status: "failed",
      attempts: 1,
    });
    expect(projected.find((r) => r.id === "job_old_inflight")?.lastError).toBeTruthy();
    // prepared 不自动重放：对账只计数，状态原样保留
    expect(projected.find((r) => r.id === "job_backlog")).toMatchObject({ status: "prepared" });
    expect(projected.find((r) => r.id === "job_done")).toMatchObject({ status: "done", receipt: { retired: true } });

    // ④ 再重启一次：failed 已落盘，不应重复写（也是"inflight→failed 只写一次"的跨进程证据）
    const linesAfterFirstReconcile = (await readFile(jobsFile, "utf8")).trim().split("\n").length;
    const third = await createApp(cfg);
    expect(third.jobReconcile).toMatchObject({ rooms: 1, orphaned: 0, failed: 0, runnable: 1 });
    expect((await readFile(jobsFile, "utf8")).trim().split("\n").length).toBe(linesAfterFirstReconcile);
  });
});
