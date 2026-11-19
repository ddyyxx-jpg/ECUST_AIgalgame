/**
 * roomId 路径穿越回归：HTTP 参数在进入 Store/文件路径前必须被拒绝。
 * 这里从真实路由注入编码后的 `..%2F`，断言 400 且数据目录之外没有落盘。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { tempDir } from "@galgame/testkit";
import { createApp } from "./bootstrap.ts";
import { registerRoutes } from "./routes.ts";
import type { ServerConfig } from "./config.ts";

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

describe("roomId 路径穿越", () => {
  it("编码后的 ../.. 不会写出数据目录；合法 roomId 不受影响", async () => {
    const dataDir = tempDir("galgame-room-id-");
    const deps = await createApp(testConfig(dataDir));
    const app = Fastify();
    registerRoutes(app, deps);

    const escaped = `../../escaped_${process.pid}`;
    const encoded = escaped.replaceAll("/", "%2F");
    const outside = join(dataDir, "..", `escaped_${process.pid}.jsonl`);
    expect(existsSync(outside)).toBe(false);

    for (const url of [
      `/api/v1/rooms/${encoded}/state`,
      `/api/v1/rooms/${encoded}/map/tick`,
    ]) {
      const res = await app.inject({
        method: url.endsWith("/map/tick") ? "POST" : "GET",
        url,
        ...(url.endsWith("/map/tick") ? { payload: { advance: true } } : {}),
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { code: string }).code).toBe("E_SCHEMA_INVALID");
    }
    expect(existsSync(outside)).toBe(false);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      headers: { "x-user-id": "u_safe" },
      payload: { mode: "solo" },
    });
    expect(created.statusCode).toBe(200);
    const { roomId } = created.json() as { roomId: string };
    expect((await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/state`, headers: { "x-user-id": "u_safe" } })).statusCode).toBe(200);
    await app.close();
  });
});
