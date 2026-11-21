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
import {
  EMPTY_SCENARIOS,
  ScenarioSchema,
  SuggestionSchema,
  loadScenarios,
  normalizeSuggestion,
} from "./scenarios.ts";
import { registerViewRoutes } from "./view.routes.ts";

const CONTENT_DIR = path.join(process.cwd(), "content", "scenarios");

describe("loadScenarios", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("读取 content/scenarios/*.json：4 个开局 + 7 个 NPC 档案", async () => {
    const catalog = await loadScenarios(CONTENT_DIR);
    expect(catalog.openings).toHaveLength(4);
    expect(catalog.npcs).toHaveLength(7);

    expect(new Set(catalog.openings.map((s) => s.id)).size).toBe(4);
    for (const s of catalog.openings) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.role.length).toBeGreaterThan(0);
      expect(s.opening.length).toBeGreaterThan(0);
      expect(s.hint.length).toBeGreaterThan(0);
    }

    // issue #139：每个建议项都带来源 kind，kind 枚举固定；两个误分级样例已被内容侧修正
    for (const s of catalog.openings) {
      expect(Array.isArray(s.suggestions)).toBe(true);
      for (const sug of s.suggestions ?? []) {
        expect(Object.keys(sug).sort()).toEqual(["kind", "text"]);
        expect(["move", "talk", "action"]).toContain(sug.kind);
      }
    }
    const kindsByText = new Map(
      catalog.openings.flatMap((s) => s.suggestions ?? []).map((sug) => [sug.text, sug.kind]),
    );
    expect(kindsByText.get("问室友监控的事")).toBe("talk");
    expect(kindsByText.get("去找校刊编辑部打听")).toBe("talk");

    // 档案 id 必须与房间里的 npc 实体 id 对齐（canon/world.json 的 npc ids）
    expect(catalog.npcs.map((n) => n.id).sort()).toEqual([
      "npc_bai",
      "npc_jin",
      "npc_lin",
      "npc_lu",
      "npc_ma",
      "npc_yan",
      "npc_zhou",
    ]);
  });

  it("文件缺失/坏 JSON 时降级为空表，不抛错", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = await mkdtemp(path.join(tmpdir(), "galgame-scenarios-"));
    tmpDirs.push(dir);
    const catalog = await loadScenarios(dir);
    expect(catalog).toEqual(EMPTY_SCENARIOS);
  });

  it("schema 兼容旧字符串；出口/loader 归一化回填 action（不猜中文前缀）", () => {
    const legacy = { text: "去图书馆", kind: "action" };
    expect(SuggestionSchema.safeParse("去图书馆").success).toBe(true);
    expect(SuggestionSchema.safeParse({ text: "去图书馆", kind: "move" }).success).toBe(true);
    expect(SuggestionSchema.safeParse({ text: "去图书馆", kind: "look" }).success).toBe(false);
    expect(normalizeSuggestion("去图书馆")).toEqual(legacy);
    expect(normalizeSuggestion("和林静说话")).toEqual({ text: "和林静说话", kind: "action" });
    expect(normalizeSuggestion({ text: "问室友监控的事", kind: "talk" })).toEqual({
      text: "问室友监控的事",
      kind: "talk",
    });
    expect(
      ScenarioSchema.safeParse({
        id: "legacy", name: "n", role: "r", tagline: "t",
        opening: ["p"], hint: "h", suggestions: ["问室友监控的事"],
      }).success,
    ).toBe(true);
  });
});

describe("GET /api/v1/scenarios", () => {
  it("下发开局与 NPC 公开字段（id/appearance）；空目录时返回空数组", async () => {
    const scenarios = {
      openings: [{
        id: "transfer", name: "转学生", role: "插班生", tagline: "t", opening: ["p1"], hint: "h",
        suggestions: [
          { text: "问室友监控的事", kind: "talk" as const },
          { text: "去找校刊编辑部打听", kind: "talk" as const },
        ],
      }],
      npcs: [{ id: "npc_zhou", role: "主席", traits: ["掌控欲强"], line: "l" }],
    };
    const app = Fastify();
    registerViewRoutes(app, {
      store: { snapshot: async () => Promise.reject(new Error("unused")), listRooms: async () => [] },
      registry: new JsonRegistry(),
      scenarios,
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/v1/scenarios" });
    expect(res.statusCode).toBe(200);
    // /scenarios 是公开端点：只收窄下发 id + appearance（issue #54），完整档案走 /gallery
    const body = res.json();
    expect(body.ok).toBe(true);
    // issue #139：suggestions 在 HTTP 出口是结构化 kind（结构断言，不断言文案）
    expect(body.openings[0].suggestions).toEqual(scenarios.openings[0].suggestions);
    expect(body.npcs).toEqual([{ id: "npc_zhou" }]);

    const emptyApp = Fastify();
    registerViewRoutes(emptyApp, {
      store: { snapshot: async () => Promise.reject(new Error("unused")), listRooms: async () => [] },
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
