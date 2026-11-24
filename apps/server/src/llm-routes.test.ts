import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadLlmRoutes } from "./llm-routes.ts";

async function dirWith(routesJson: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "llm-routes-"));
  await mkdir(path.join(dir, "llm"), { recursive: true });
  await writeFile(path.join(dir, "llm", "routes.json"), routesJson, "utf8");
  return dir;
}

const deps = (warnings: string[], logs: string[] = []) => ({
  warn: (m: string) => warnings.push(m),
  log: (m: string) => logs.push(m),
});

describe("content/llm/routes.json 加载", () => {
  it("合法配置返回路由并按用途打印", async () => {
    const dir = await dirWith(
      JSON.stringify({
        schemaVersion: 1,
        routes: { turn: { maxTokens: 4000, timeoutMs: 60000 }, decision: { model: "cheap" } },
      }),
    );
    const warnings: string[] = [];
    const logs: string[] = [];
    const routes = await loadLlmRoutes(dir, deps(warnings, logs));
    expect(routes).toEqual({ turn: { maxTokens: 4000, timeoutMs: 60000 }, decision: { model: "cheap" } });
    expect(warnings).toHaveLength(0);
    expect(logs[0]).toContain("turn→默认模型");
  });

  it("缺文件时不覆盖、不告警", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "llm-routes-"));
    const warnings: string[] = [];
    expect(await loadLlmRoutes(dir, deps(warnings))).toBeUndefined();
    expect(warnings).toHaveLength(0);
  });

  it("坏 JSON 告警并降级", async () => {
    const dir = await dirWith("{ not json");
    const warnings: string[] = [];
    expect(await loadLlmRoutes(dir, deps(warnings))).toBeUndefined();
    expect(warnings[0]).toContain("不是合法 JSON");
  });

  it("拼错用途键时告警（strict 校验），不会静默忽略", async () => {
    const dir = await dirWith(JSON.stringify({ schemaVersion: 1, routes: { tuns: { maxTokens: 4000 } } }));
    const warnings: string[] = [];
    expect(await loadLlmRoutes(dir, deps(warnings))).toBeUndefined();
    expect(warnings[0]).toContain("校验失败");
  });

  it("空 routes 视为未配置", async () => {
    const dir = await dirWith(JSON.stringify({ schemaVersion: 1, routes: {} }));
    const warnings: string[] = [];
    expect(await loadLlmRoutes(dir, deps(warnings))).toBeUndefined();
    expect(warnings).toHaveLength(0);
  });
});
