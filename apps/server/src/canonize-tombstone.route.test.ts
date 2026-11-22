/**
 * 世界层记忆撤回的错误语义（PR #149 审阅 P2-4）。
 *
 * 旧行为：任何失败都返回 409 `E_MEMORY_IMMUTABLE`「已撤回或不可变」，并发冲突被误报成
 * 不可恢复——运维看到 409 就不会重试。这里钉死两条：并发冲突 = 503 可重试；真不可变 = 409。
 */
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { tempDir } from "@galgame/testkit";
import { createApp } from "./bootstrap.ts";
import type { ServerConfig } from "./config.ts";
import { registerRoutes } from "./routes.ts";

const ORIGIN = { origin: "https://galgame.test" };
const ADMIN = { ...ORIGIN, "x-admin-token": "dev-admin" };

function testConfig(): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: tempDir("galgame-tombstone-"),
    contentDir: "content",
    adminToken: "dev-admin",
    trustUserHeader: true,
    llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
    audit: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1000 },
  };
}

type Outcome = { ok: boolean; code?: string };

async function appWithTombstone(outcome: Outcome) {
  const deps = await createApp(testConfig());
  // 只替换世界层记忆端口：撤回语义由路由决定，写入路径在本文件之外
  Object.assign(deps, {
    canonize: {
      retireRoom: async () => ({ written: [], candidates: 0 }),
      tombstone: async () => outcome.ok,
      tombstoneWithReason: async () => outcome,
      stats: () => ({ worldId: "w", version: 0, writtenToday: 0, writtenTotal: 0, circuitOpen: false, consecutiveJudgeFailures: 0 }),
      sample: () => [],
    },
  });
  // 让"记忆存在"成立：撤回失败时才走到 409 不可变分支
  Object.assign(deps.memory, { get: () => ({ id: "mem_x", ownerId: "mem_world", roomId: "world", content: "x", tags: [], salience: 1, visibility: "public", tier: "permanent", status: "active" }) });
  const app = Fastify();
  registerRoutes(app, deps);
  return app;
}

describe("世界层记忆撤回的错误语义", () => {
  it("并发写入冲突（E_SEQ_GAP）→ 503 可重试，不是不可变", async () => {
    const app = await appWithTombstone({ ok: false, code: "E_SEQ_GAP" });
    const res = await app.inject({ method: "POST", url: "/api/v1/admin/canonize/tombstone", headers: ADMIN, payload: { memoryId: "mem_x" } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, code: "E_SEQ_GAP", retryable: true });
    await app.close();
  });

  it("真正不可变（E_MEMORY_IMMUTABLE）仍是 409", async () => {
    const app = await appWithTombstone({ ok: false, code: "E_MEMORY_IMMUTABLE" });
    const res = await app.inject({ method: "POST", url: "/api/v1/admin/canonize/tombstone", headers: ADMIN, payload: { memoryId: "mem_x" } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ ok: false, code: "E_MEMORY_IMMUTABLE" });
    await app.close();
  });
});
