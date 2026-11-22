/**
 * /state 原始 attrs 通道与 GalleryView visibility 口径的结构断言（issue #74 收口）。
 *
 * docs/03 §5.2.5 明确两条通道不可混用：
 * - /state 是权威原状态通道，返回实体 attrs 原值（含 self/secret 的精确值），
 *   只按一级认识口径做名字脱敏、并剥掉引擎内部 sim_lease，不做 visibility 过滤；
 * - GalleryView 才是读数视图：public→exact，secret→band（无 value/ratio），
 *   self 对他人→数值 band / 文本 masked（本版本无"看自己"视图）。
 *
 * 只断言结构（display/字段有无/精确值是否原样保留），不断言叙事文案。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { AttrDef, Entity, Registry, WorldState } from "../../../packages/shared/src/contract/types.ts";
import { JsonRegistry } from "../../../packages/engine/src/registry.ts";
import { buildGalleryView } from "./gallery.ts";
import type { GalleryStat } from "./gallery.ts";
import { registerRoutes, type AppDeps } from "./routes.ts";
import { UNKNOWN_NPC_NAME } from "./view-names.ts";

const ROOM = "room_state_view";
const PLR = "plr_me";
const NPC = "npc_known";
const STRANGER = "npc_stranger";

async function realRegistry(): Promise<Registry> {
  const raw = JSON.parse(await readFile(path.join(process.cwd(), "content/registry/attrs.json"), "utf8")) as { attrs: AttrDef[] };
  return new JsonRegistry({ attrs: raw.attrs, events: [], intents: [], tools: [], ops: [] });
}

function entity(id: string, kind: Entity["kind"], name: string, attrs: Entity["attrs"]): Entity {
  return { id, kind, name, attrs, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 };
}

function world(): WorldState {
  return {
    schemaVersion: 2,
    room: {
      id: ROOM,
      mode: "solo",
      worldId: "world_campus",
      members: [{ actorId: PLR, role: "player", joinedSeq: 1 }],
      scene: { locId: "loc_lib", presentIds: [PLR, NPC, STRANGER] },
      createdAt: 1,
      lastActiveAt: 1,
    },
    entities: {
      loc_lib: entity("loc_lib", "loc", "图书馆", {}),
      [PLR]: entity(PLR, "plr", "你", { stamina: 55, trust: 42, guard: 11 }),
      // knows_name=true：图鉴解锁读数；self/secret 都写入了具体值，用来验证两条通道口径
      [NPC]: entity(NPC, "npc", "林静", { knows_name: true, stamina: 80, trust: 64, mood: "平静", guard: 73, stress: 35, sim_lease: '{"action":"move","target":"loc_canteen","remaining":1,"phase":"morning"}' }),
      [STRANGER]: entity(STRANGER, "npc", "白晓通", { knows_name: false, trust: 90 }),
    },
    links: [
      { id: "l1", kind: "located_in", from: NPC, to: "loc_lib", createdAt: 1 },
      { id: "l2", kind: "located_in", from: STRANGER, to: "loc_lib", createdAt: 1 },
    ],
    clock: { day: 1, phase: "morning", tick: 0 },
    plots: [],
    moduleState: {},
  };
}

describe("/state 原始 attrs 通道（docs/03 §5.2.5）", () => {
  it("attrs 原样返回（self/secret 精确值不被过滤），只做名字脱敏并剥引擎内部 sim_lease", async () => {
    const app = Fastify();
    registerRoutes(app, {
      store: { snapshot: async () => world(), listRooms: async () => [ROOM], events: async () => [] },
      turn: {},
      map: {},
      registry: await realRegistry(),
      settings: { view: () => ({ mode: "offline", baseUrl: "", model: "", persisted: false }), apply: async () => ({ ok: false }), clear: async () => undefined },
      createRoom: async () => ({ roomId: ROOM, actorId: PLR }),
      version: "test",
    } as unknown as AppDeps);
    await app.ready();

    const res = await app.inject({ method: "GET", url: `/api/v1/rooms/${ROOM}/state` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entities: Record<string, Entity> };
    const entities = body.entities;

    // npc：secret=guard、self=trust/mood/stress 的精确值都在（/state 不做 visibility 过滤）
    expect(entities[NPC]?.attrs).toMatchObject({ guard: 73, trust: 64, mood: "平静", stress: 35, stamina: 80 });
    // sim_lease 是引擎内部动作租约（含下一步目标），不能随 /state 出站
    expect(entities[NPC]?.attrs).not.toHaveProperty("sim_lease");
    // plr：self 视角下自己的 self/secret 同样原样返回
    expect(entities[PLR]?.attrs).toMatchObject({ trust: 42, guard: 11 });

    // 唯一的出站加工：未认识 NPC 的真名被占位名替换，但它的数值仍原样
    expect(entities[STRANGER]?.name).toBe(UNKNOWN_NPC_NAME);
    expect(entities[STRANGER]?.attrs.trust).toBe(90);

    // 不是读数视图：没有 GalleryStat 结构混入
    expect(JSON.stringify(body)).not.toContain('"display"');
    expect(JSON.stringify(body)).not.toContain('"band"');
    expect(JSON.stringify(body)).not.toContain("sim_lease");
    await app.close();
  });
});

describe("GalleryView 的 self 对他人口径（docs/03 §5.2.5，结构断言）", () => {
  it("真实 registry：self/secret 读数无精确字段，public 读数有精确值", async () => {
    const view = buildGalleryView({ roomId: ROOM, state: world(), registry: await realRegistry(), profiles: [] });
    const card = view.npcs.find((n) => n.id === NPC);
    expect(card).toBeDefined();
    expect(card?.met).toBe(true);
    // 视图不含原始 attrs 字段
    expect(card).not.toHaveProperty("attrs");

    const byKey = new Map<string, GalleryStat>((card?.stats ?? []).map((s) => [s.key, s]));
    const trust = byKey.get("trust");
    expect(trust?.visibility).toBe("self");
    expect(["band", "masked"]).toContain(trust?.display);
    expect(trust).not.toHaveProperty("value");
    expect(trust).not.toHaveProperty("ratio");
    expect(trust).not.toHaveProperty("text");

    const guard = byKey.get("guard");
    expect(guard?.visibility).toBe("secret");
    expect(guard?.display).toBe("band");
    expect(guard).not.toHaveProperty("value");
    expect(guard).not.toHaveProperty("ratio");

    const stamina = byKey.get("stamina");
    expect(stamina?.visibility).toBe("public");
    expect(stamina?.display).toBe("exact");
    expect(stamina?.value).toBe(80);

    // 所有非 public 读数都不带可反推精确值的字段（本版本无看自己视图，一律对他人口径）
    for (const stat of card?.stats ?? []) {
      if (stat.visibility === "public") continue;
      expect(stat).not.toHaveProperty("value");
      expect(stat).not.toHaveProperty("ratio");
      expect(stat).not.toHaveProperty("text");
    }
  });
});
