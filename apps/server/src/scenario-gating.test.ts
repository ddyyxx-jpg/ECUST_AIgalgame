/**
 * issue #54：NPC 档案的“一级认识”下发口径回归。
 * - `/scenarios` 是全局公开端点：任何 NPC（哪怕内容数据里有完整档案）都只给 id + appearance；
 * - `/gallery` 只在 met=true 时给 role/traits/line/mutter，met=false 一个字段都不给。
 */
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { AttrDef, Entity, WorldState } from "../../../packages/shared/src/contract/types.ts";
import { JsonRegistry } from "../../../packages/engine/src/registry.ts";
import { buildGalleryView } from "./gallery.ts";
import type { ScenarioCatalog } from "./scenarios.ts";
import { registerViewRoutes } from "./view.routes.ts";

const SCENARIOS: ScenarioCatalog = {
  openings: [],
  npcs: [
    {
      id: "npc_known",
      role: "图书馆流通部管理员 · 工作五年",
      traits: ["林馆员"],
      line: "请保持安静。",
      mutter: "今天也没人来借书……",
      appearance: "穿白衬衫的管理员",
    },
    {
      id: "npc_stranger",
      role: "校学生会主席 · 大三",
      traits: ["周主席"],
      line: "先别往上报。",
      mutter: "这事得压下来。",
      appearance: "袖口别着校徽的男生",
    },
  ],
};

const ATTRS: AttrDef[] = [
  { key: "stamina", type: "number", scope: ["npc"], min: 0, max: 100, visibility: "public", display: { label: "体力" } },
];

function npc(id: string, name: string, knowsName: boolean): Entity {
  return {
    id,
    kind: "npc",
    name,
    attrs: { knows_name: knowsName, stamina: 50 },
    tags: [],
    origin: "seed",
    canon: true,
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  };
}

function state(): WorldState {
  return {
    schemaVersion: 2,
    room: {
      id: "room_g",
      mode: "solo",
      worldId: "world_campus",
      members: [{ actorId: "plr_self", role: "player", joinedSeq: 1 }],
      scene: { locId: "loc_lib", presentIds: ["plr_self", "npc_known", "npc_stranger"] },
      createdAt: 1,
      lastActiveAt: 1,
    },
    entities: {
      plr_self: { ...npc("plr_self", "你", false), kind: "plr" },
      npc_known: npc("npc_known", "林静", true),
      npc_stranger: npc("npc_stranger", "周明远", false),
    },
    links: [
      { id: "l1", kind: "located_in", from: "npc_known", to: "loc_lib", createdAt: 1 },
      { id: "l2", kind: "located_in", from: "npc_stranger", to: "loc_lib", createdAt: 1 },
    ],
    clock: { day: 1, phase: "morning", tick: 0 },
    plots: [],
    moduleState: {},
  };
}

describe("GET /api/v1/scenarios 只下发公开字段", () => {
  it("有档案的 NPC 也不给 role/traits/line/mutter，只给 id + appearance", async () => {
    const app = Fastify();
    registerViewRoutes(app, {
      store: { snapshot: async () => state(), listRooms: async () => [] },
      registry: new JsonRegistry({ attrs: ATTRS }),
      scenarios: SCENARIOS,
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/v1/scenarios" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; npcs: Array<Record<string, unknown>> };
    expect(body.npcs).toEqual([
      { id: "npc_known", appearance: "穿白衬衫的管理员" },
      { id: "npc_stranger", appearance: "袖口别着校徽的男生" },
    ]);
    for (const entry of body.npcs) {
      for (const key of ["role", "traits", "line", "mutter"]) expect(entry).not.toHaveProperty(key);
    }
    // 连原始响应文本里也不能残留档案片段
    for (const secret of ["图书馆流通部管理员", "校学生会主席", "林馆员", "周主席", "今天也没人来借书", "这事得压下来"]) {
      expect(res.body).not.toContain(secret);
    }

    await app.close();
  });
});

describe("GET /gallery 的 mutter 口径", () => {
  const gallery = () =>
    buildGalleryView({
      roomId: "room_g",
      state: state(),
      registry: new JsonRegistry({ attrs: ATTRS }),
      profiles: SCENARIOS.npcs,
    });

  it("met=true：role/traits/line/mutter 一并给", () => {
    const card = gallery().npcs.find((n) => n.id === "npc_known");
    expect(card).toMatchObject({
      met: true,
      role: "图书馆流通部管理员 · 工作五年",
      traits: ["林馆员"],
      line: "请保持安静。",
      mutter: "今天也没人来借书……",
    });
  });

  it("met=false：role/traits/line/mutter 全不给", () => {
    const card = gallery().npcs.find((n) => n.id === "npc_stranger");
    expect(card?.met).toBe(false);
    for (const key of ["role", "traits", "line", "mutter"]) expect(card).not.toHaveProperty(key);
  });
});
