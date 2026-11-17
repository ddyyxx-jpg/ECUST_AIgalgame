/**
 * 图鉴端点回归（issue #3：前端不碰属性键/分档阈值，读数由服务端按 registry 生成）。
 *
 * 断言的是结构（visibility 口径），不是文案：
 * - public → 精确值 + label/unit + 进度条；
 * - secret → 只给分档，**不得出现精确数值/ratio**；
 * - self 对他人 → 只给分档（文本 → masked），不下发精确值；
 * - display.hidden → 不出现；未遇见的人不返回档案与读数；
 * - world room / 未知房间 → 404。
 */
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { AttrDef, Entity, EntityKind, WorldState } from "../../../packages/shared/src/contract/types.ts";
import { JsonRegistry } from "../../../packages/engine/src/registry.ts";
import type { GalleryView } from "./gallery.ts";
import { registerViewRoutes } from "./view.routes.ts";
import type { ScenarioCatalog } from "./scenarios.ts";

const ATTRS: AttrDef[] = [
  { key: "stamina", type: "number", scope: ["plr", "npc"], min: 0, max: 100, visibility: "public", display: { label: "体力", unit: "点" } },
  { key: "trust", type: "number", scope: ["npc"], min: 0, max: 100, visibility: "self", display: { label: "信任", unit: "点" } },
  { key: "guard", type: "number", scope: ["npc"], min: 0, max: 100, visibility: "secret", display: { label: "戒备" } },
  { key: "mood", type: "string", scope: ["npc"], visibility: "self", display: { label: "心情" } },
  { key: "coord_x", type: "number", scope: ["npc"], min: 0, max: 6000, visibility: "public", display: { label: "地图 X", hidden: true } },
];

const SCENARIOS: ScenarioCatalog = {
  openings: [],
  npcs: [{ id: "npc_a", role: "学生会主席", traits: ["掌控欲强"], line: "先别往上报。" }],
};

function entity(id: string, kind: EntityKind, name: string, attrs: Entity["attrs"]): Entity {
  return { id, kind, name, attrs, tags: [], origin: "seed", canon: true, status: "active", createdAt: 1, updatedAt: 1 };
}

function world(): WorldState {
  return {
    schemaVersion: 2,
    room: {
      id: "room_x",
      mode: "solo",
      worldId: "world_campus",
      members: [{ actorId: "plr_self", role: "player", joinedSeq: 1 }],
      scene: { locId: "loc_lib", presentIds: ["plr_self", "npc_a"] },
      createdAt: 1,
      lastActiveAt: 1,
    },
    entities: {
      loc_lib: entity("loc_lib", "loc", "图书馆", {}),
      loc_dorm: entity("loc_dorm", "loc", "宿舍", {}),
      plr_self: entity("plr_self", "plr", "你", { stamina: 50 }),
      npc_a: entity("npc_a", "npc", "周明远", {
        stamina: 80,
        guard: 73,
        trust: 64,
        mood: "平静",
        coord_x: 1200,
      }),
      npc_b: entity("npc_b", "npc", "马骁", { stamina: 20, guard: 12, trust: 5 }),
    },
    links: [
      { id: "l1", kind: "located_in", from: "npc_a", to: "loc_lib", createdAt: 1 },
      { id: "l2", kind: "located_in", from: "npc_b", to: "loc_dorm", createdAt: 1 },
      { id: "l3", kind: "located_in", from: "plr_self", to: "loc_lib", createdAt: 1 },
    ],
    clock: { day: 1, phase: "morning", tick: 0 },
    plots: [],
    moduleState: {},
  };
}

async function makeApp(snapshot: (roomId: string) => Promise<WorldState>) {
  const app = Fastify();
  registerViewRoutes(app, { store: { snapshot }, registry: new JsonRegistry({ attrs: ATTRS }), scenarios: SCENARIOS });
  await app.ready();
  return app;
}

describe("GET /api/v1/rooms/:roomId/gallery", () => {
  it("public 给精确值；secret/self 只给分档；hidden 不出现", async () => {
    const app = await makeApp(async () => world());
    const res = await app.inject({ method: "GET", url: "/api/v1/rooms/room_x/gallery" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; gallery: GalleryView };
    expect(body.ok).toBe(true);
    expect(body.gallery.counts).toEqual({ met: 1, total: 2, locs: 2 });

    const a = body.gallery.npcs.find((n) => n.id === "npc_a");
    expect(a).toBeDefined();
    expect(a).toMatchObject({ met: true, present: true, locName: "图书馆", role: "学生会主席" });
    expect(a?.traits).toEqual(["掌控欲强"]);

    // public 数值 → 精确值 + 单位 + 比例
    const stamina = a?.stats.find((s) => s.key === "stamina");
    expect(stamina).toMatchObject({ display: "exact", value: 80, unit: "点" });
    expect(stamina?.ratio).toBeCloseTo(0.8, 5);

    // secret 数值 → 只给分档，绝不带 value/ratio
    const guard = a?.stats.find((s) => s.key === "guard");
    expect(guard).toMatchObject({ display: "band", band: "高" });
    expect(guard).not.toHaveProperty("value");
    expect(guard).not.toHaveProperty("ratio");

    // self 数值（对他人）→ 只给分档，绝不带 value/ratio
    const trust = a?.stats.find((s) => s.key === "trust");
    expect(trust).toMatchObject({ display: "band", band: "中" });
    expect(trust).not.toHaveProperty("value");
    expect(trust).not.toHaveProperty("ratio");

    // self 文本 → 不可见（文本本身就是精确值）
    const mood = a?.stats.find((s) => s.key === "mood");
    expect(mood).toMatchObject({ display: "masked" });
    expect(mood).not.toHaveProperty("text");

    // hidden 属性（坐标）不出现，也不在响应里泄露
    expect(a?.stats.some((s) => s.key === "coord_x")).toBe(false);
    expect(res.body).not.toContain("1200");

    // 未遇见的人：不返回档案、位置、读数
    const b = body.gallery.npcs.find((n) => n.id === "npc_b");
    expect(b).toMatchObject({ met: false, present: false, stats: [] });
    expect(b?.role).toBeUndefined();
    expect(b?.locName).toBeUndefined();

    await app.close();
  });

  it("world room 与未知房间都 404，且 world room 不读 store", async () => {
    let calls = 0;
    const app = await makeApp(async (roomId) => {
      calls += 1;
      if (roomId === "room_x") return world();
      throw new Error("no such room");
    });

    const worldRes = await app.inject({ method: "GET", url: "/api/v1/rooms/room_world_1/gallery" });
    expect(worldRes.statusCode).toBe(404);
    expect(calls).toBe(0);

    const missingRes = await app.inject({ method: "GET", url: "/api/v1/rooms/room_missing/gallery" });
    expect(missingRes.statusCode).toBe(404);
    expect(missingRes.json()).toMatchObject({ ok: false, code: "E_ROOM_NOT_FOUND" });

    await app.close();
  });
});
