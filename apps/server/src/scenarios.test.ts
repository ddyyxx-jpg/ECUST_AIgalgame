/**
 * 开局剧本端点 + 内容加载回归（issue #3：标题页文案不再硬编码在 web）。
 * - 内容文件真实可解析：3 个开局 / 3 个 NPC 公开档案，id 唯一且与 canon 的 NPC 对齐；
 * - 文件缺失 → 降级为空表（前端显示「无预设开局」），不抛错；
 * - GET /api/v1/scenarios 原样下发，空目录时返回空数组。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { JsonRegistry } from "../../../packages/engine/src/registry.ts";
import { EMPTY_SCENARIOS, loadScenarios } from "./scenarios.ts";
import { registerViewRoutes } from "./view.routes.ts";

const CONTENT_DIR = path.join(process.cwd(), "content", "scenarios");

describe("loadScenarios", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("读取 content/scenarios/*.json：3 个开局 + 3 个 NPC 档案", async () => {
    const catalog = await loadScenarios(CONTENT_DIR);
    expect(catalog.openings).toHaveLength(3);
    expect(catalog.npcs).toHaveLength(3);

    expect(new Set(catalog.openings.map((s) => s.id)).size).toBe(3);
    for (const s of catalog.openings) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.role.length).toBeGreaterThan(0);
      expect(s.opening.length).toBeGreaterThan(0);
      expect(s.hint.length).toBeGreaterThan(0);
    }

    // 档案 id 必须与房间里的 npc 实体 id 对齐（canon/world.json 的 npc ids）
    expect(catalog.npcs.map((n) => n.id).sort()).toEqual(["npc_lin", "npc_ma", "npc_zhou"]);
  });

  it("文件缺失/坏 JSON 时降级为空表，不抛错", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = await mkdtemp(path.join(tmpdir(), "galgame-scenarios-"));
    tmpDirs.push(dir);
    const catalog = await loadScenarios(dir);
    expect(catalog).toEqual(EMPTY_SCENARIOS);
  });
});

describe("GET /api/v1/scenarios", () => {
  it("原样下发开局与 NPC 档案；空目录时返回空数组", async () => {
    const scenarios = {
      openings: [{ id: "transfer", name: "转学生", role: "插班生", tagline: "t", opening: ["p1"], hint: "h" }],
      npcs: [{ id: "npc_zhou", role: "主席", traits: ["掌控欲强"], line: "l" }],
    };
    const app = Fastify();
    registerViewRoutes(app, {
      store: { snapshot: async () => Promise.reject(new Error("unused")) },
      registry: new JsonRegistry(),
      scenarios,
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/v1/scenarios" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, ...scenarios });

    const emptyApp = Fastify();
    registerViewRoutes(emptyApp, {
      store: { snapshot: async () => Promise.reject(new Error("unused")) },
      registry: new JsonRegistry(),
      scenarios: EMPTY_SCENARIOS,
    });
    await emptyApp.ready();
    const emptyRes = await emptyApp.inject({ method: "GET", url: "/api/v1/scenarios" });
    expect(emptyRes.statusCode).toBe(200);
    expect(emptyRes.json()).toEqual({ ok: true, openings: [], npcs: [] });

    await app.close();
    await emptyApp.close();
  });
});
