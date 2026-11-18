/**
 * 图鉴"认识"口径（一级判定）：只有 knows_name 为 true 才解锁档案与读数。
 * 也覆盖视图名遮罩：未认识时不下发真名。
 */
import { describe, expect, it } from "vitest";
import type { Entity, Registry, WorldState } from "../../../packages/shared/src/contract/types.ts";
import { buildGalleryView } from "./gallery.ts";
import { displayNameOf, UNKNOWN_NPC_NAME } from "./view-names.ts";

function npcEntity(knowsName: boolean): Entity {
  return {
    id: "npc_lin",
    kind: "npc",
    name: "林静",
    attrs: { stamina: 100, knows_name: knowsName },
    tags: [],
    origin: "seed",
    canon: true,
    status: "active",
    createdAt: 0,
    updatedAt: 0,
  };
}

function stateWith(npc: Entity): WorldState {
  return {
    schemaVersion: 2,
    room: {
      id: "room_g",
      mode: "solo",
      worldId: "w",
      members: [{ actorId: "plr_me", role: "player", joinedSeq: 1, online: true }],
      scene: { locId: "loc_library", presentIds: ["plr_me", npc.id] },
      createdAt: 0,
      lastActiveAt: 0,
    },
    entities: { [npc.id]: npc },
    links: [{ id: "l1", kind: "located_in", from: npc.id, to: "loc_library", createdAt: 0 }],
    clock: { day: 1, phase: "morning", tick: 0 },
    plots: [],
    moduleState: {},
  };
}

const registry = {
  attrs: () => [
    { key: "stamina", type: "number", scope: ["npc"], min: 0, max: 100, visibility: "public", display: { label: "体力" } },
  ],
} as unknown as Registry;

describe("图鉴认识口径", () => {
  it("没见过（knows_name=false）：met=false、不下发真名、无读数", () => {
    const view = buildGalleryView({ roomId: "room_g", state: stateWith(npcEntity(false)), registry, profiles: [] });
    const card = view.npcs[0];
    expect(card.met).toBe(false);
    expect(card.name).toBe(UNKNOWN_NPC_NAME);
    expect(card.stats).toEqual([]);
    expect(card.role).toBeUndefined();
    expect(card.locName).toBeUndefined();
  });

  it("知道名字后：解锁档案与读数", () => {
    const view = buildGalleryView({ roomId: "room_g", state: stateWith(npcEntity(true)), registry, profiles: [] });
    const card = view.npcs[0];
    expect(card.met).toBe(true);
    expect(card.name).toBe("林静");
    expect(card.stats.length).toBeGreaterThan(0);
    expect(card.locName).toBeDefined();
  });
});

describe("displayNameOf", () => {
  it("未认识时给占位名，不外泄真名", () => {
    expect(displayNameOf(npcEntity(false))).toBe(UNKNOWN_NPC_NAME);
    expect(displayNameOf(npcEntity(true))).toBe("林静");
  });
});