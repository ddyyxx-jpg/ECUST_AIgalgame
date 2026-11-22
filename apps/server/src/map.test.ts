/**
 * MapService 契约测试（docs/06 §4/§5/§6）。
 *
 * 全部依赖注入：真 EventSourcedStore/DefaultArbiter/DefaultTurn/DialogueHost，
 * 但模块与内容都用 tempDir 里的最小 fixture —— 不依赖 content/modules/map/module.ts 的完成时点。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultArbiter, DefaultTurn, DialogueHost, EventSourcedStore, InMemoryMemory, JsonRegistry } from "@galgame/engine";
import { MockLlm } from "@galgame/llm";
import { makeCtx, tempDir } from "@galgame/testkit";
import type {
  AttrDef,
  ContextSlice,
  Entity,
  Envelope,
  ModuleContext,
  ModuleInfo,
  ModuleOutcome,
  Modules,
  Phase,
  Proposal,
  ViewPatch,
} from "@galgame/shared";
import npcScene from "../../../content/directors/npc.scene.ts";
import { MapService } from "./map.ts";
import type { MapDraft } from "./map.data.ts";

const ADMIN_TOKEN = "dev-admin";
const ROOM_ID = "room_test";

const COORD_ATTRS: AttrDef[] = [
  { key: "coord_x", type: "number", scope: ["loc", "npc", "plr"], min: 0, max: 2000, default: 0, visibility: "public", display: { label: "X", hidden: true } },
  { key: "coord_y", type: "number", scope: ["loc", "npc", "plr"], min: 0, max: 2000, default: 0, visibility: "public", display: { label: "Y", hidden: true } },
];

const WORLD = {
  worldId: "test_world",
  startLocId: "loc_library",
  locs: [
    { id: "loc_library", name: "图书馆", exits: ["loc_canteen"] },
    { id: "loc_canteen", name: "食堂" },
  ],
  npcs: [{ id: "npc_lin", name: "林夏", locId: "loc_library" }],
  facts: [],
};

const WORLD_MAP = {
  schemaVersion: 1,
  worldId: "test_world",
  width: 1000,
  height: 640,
  image: "/map/test-campus.jpg",
  startLocId: "loc_library",
  scenes: [
    {
      id: "loc_library",
      name: "图书馆",
      desc: "书架间有旧纸的味道。",
      tags: ["室内"],
      x: 260,
      y: 180,
      links: [{ kind: "npc", id: "npc_lin" }],
      dialogues: [{ id: "dlg_lib", npcId: "npc_lin", title: "问候", lines: ["你来啦。", "随便坐。"] }],
    },
    {
      id: "loc_canteen",
      name: "食堂",
      desc: "饭点的人声。",
      tags: ["室内"],
      x: 560,
      y: 360,
      links: [],
      dialogues: [],
    },
    {
      id: "loc_annex",
      name: "食堂附属楼",
      desc: "食堂背后的小楼，门牌是新换的。",
      tags: ["室内"],
      x: 600,
      y: 400,
      status: "built",
      category: "teaching",
      anchorLocId: "loc_canteen",
    },
    {
      id: "loc_planned",
      name: "规划中的实验楼",
      desc: "围挡里还是一片空地。",
      tags: ["规划"],
      x: 640,
      y: 420,
      status: "planned",
      category: "lab",
      anchorLocId: "loc_canteen",
    },
    {
      id: "loc_building",
      name: "在建的体育馆",
      desc: "塔吊下面只封了顶。",
      tags: ["在建"],
      x: 660,
      y: 440,
      status: "under_construction",
      category: "sports",
      anchorLocId: "loc_canteen",
    },
  ],
};

const PROMPT = [
  "PROMPT_VERSION: map-scene-1",
  "只输出 JSON。{name} {anchorLocId} {x} {y} {idea} {npcIds}",
].join("\n");

const VALID_SCENE = JSON.stringify({
  name: "旧水房",
  desc: "水房在宿舍楼后面，水泥地一直是湿的。墙上贴着褪色的值日表，最下面那行被人撕掉了。",
  tags: ["废墟"],
  links: [{ kind: "scene", id: "loc_canteen" }],
  dialogues: [{ title: "低语", npcId: "npc_lin", lines: ["水龙头在滴水。", "别回头。"] }],
});

function entity(id: string, kind: Entity["kind"], name: string, canon: boolean): Entity {
  // NPC 默认"已认识"：本文件验证坐标/对话等地图行为，不认识口径见 gallery.knows.test.ts
  const attrs: Entity["attrs"] = kind === "npc" ? { knows_name: true } : {};
  return { id, kind, name, attrs, tags: [], origin: canon ? "seed" : "system", canon, status: "active", createdAt: 0, updatedAt: 0 };
}

/** 只实现 MapService 用到的那部分模块能力，避免测试依赖真 map 模块 */
class FakeModules implements Modules {
  readonly tickedPhases: Phase[] = [];
  tickProposals: Proposal[] = [];
  /** 模拟真 map 模块对"不可达/同点"返回 ok:true + 空 proposals 的行为 */
  noTravel = false;
  /** 模拟模块 tick 抛错（issue #38：失败不能留下已推进的时段） */
  tickError: Error | null = null;

  list(): ModuleInfo[] {
    return [];
  }
  get(): ModuleInfo | undefined {
    return undefined;
  }
  async dispatchIntent(ctx: ModuleContext): Promise<ModuleOutcome> {
    const hit = /^map\.travel (\S+)$/.exec(ctx.input);
    if (!hit) return { ok: false, proposals: [], error: { code: "E_TOOL_UNKNOWN", message: "无匹配意图" } };
    if (this.noTravel) return { ok: true, proposals: [] };
    return { ok: true, proposals: [{ op: "move.to", args: { actorId: ctx.actorId, locId: hit[1] }, reason: "fake map intent" }] };
  }
  async callTool(): Promise<ModuleOutcome> {
    return { ok: false, proposals: [], error: { code: "E_TOOL_UNKNOWN", message: "n/a" } };
  }
  async tick(_ctx: ModuleContext, phase: Phase): Promise<Proposal[]> {
    this.tickedPhases.push(phase);
    if (this.tickError) throw this.tickError;
    return this.tickProposals;
  }
  context(): ContextSlice[] {
    return [];
  }
  view(): ViewPatch | null {
    return null;
  }
}

interface Fixture {
  service: MapService;
  store: EventSourcedStore;
  arbiter: DefaultArbiter;
  turn: DefaultTurn;
  dialogue: DialogueHost;
  registry: JsonRegistry;
  modules: FakeModules;
  llm: MockLlm;
  contentDir: string;
  dataDir: string;
}

async function writeFixture(contentDir: string): Promise<void> {
  const files: [string, unknown][] = [
    ["canon/world.json", WORLD],
    ["modules/map/data/world_map.json", WORLD_MAP],
    ["prompts/map.scene.md", PROMPT],
  ];
  for (const [rel, data] of files) {
    const file = path.join(contentDir, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof data === "string" ? data : JSON.stringify(data), "utf8");
  }
}

/** 可注入一次 append 失败的 store：模拟落盘异常（issue #38 的"写盘失败"用例） */
class FlakyStore extends EventSourcedStore {
  failAppendOnce = false;
  override async append(roomId: string, envs: Envelope[]): Promise<void> {
    if (this.failAppendOnce) {
      this.failAppendOnce = false;
      throw new Error("simulated disk full");
    }
    return super.append(roomId, envs);
  }
}

async function setup(
  llm = new MockLlm({ responses: [VALID_SCENE] }),
  store: EventSourcedStore = new EventSourcedStore({ worldId: WORLD.worldId, locId: WORLD.startLocId }),
): Promise<Fixture> {
  const root = tempDir("galgame-map-test-");
  const contentDir = path.join(root, "content");
  const dataDir = path.join(root, "data");
  await writeFixture(contentDir);

  const registry = new JsonRegistry({ attrs: COORD_ATTRS });
  const arbiter = new DefaultArbiter({ store, registry });
  const modules = new FakeModules();

  // 播种 canon 实体：与 bootstrap.createRoom 同样的"内容加载器直写一次"
  const seeded: Entity[] = [
    entity("loc_library", "loc", "图书馆", true),
    entity("loc_canteen", "loc", "食堂", true),
    entity("npc_lin", "npc", "林夏", true),
    entity("plr_self", "plr", "你", false),
  ];
  store.append(
    ROOM_ID,
    seeded.map((e, i) => ({
      v: 1 as const,
      id: `evt_seed_${i}`,
      roomId: ROOM_ID,
      seq: i + 1,
      ts: 1,
      actorId: "system",
      type: "entity.created",
      payload: { entity: e },
    })),
  );
  const cause: Envelope = {
    v: 1,
    id: "evt_bootstrap",
    roomId: ROOM_ID,
    seq: store.seq(ROOM_ID) + 1,
    ts: 1,
    actorId: "system",
    type: "room.bootstrap",
    payload: {},
  };
  const seedOps: Proposal[] = [
    { op: "link.create", args: { kind: "located_in", from: "loc_library", to: "loc_canteen" } },
    { op: "link.create", args: { kind: "located_in", from: "loc_canteen", to: "loc_library" } },
    { op: "move.to", args: { actorId: "npc_lin", locId: "loc_library" } },
    { op: "move.to", args: { actorId: "plr_self", locId: "loc_library" } },
    { op: "scene.set", args: { locId: "loc_library", presentIds: ["plr_self", "npc_lin"] } },
  ];
  const seeded2 = await arbiter.apply(ROOM_ID, seedOps, cause);
  expect(seeded2.rejected).toEqual([]);

  const dialogue = new DialogueHost(() => makeCtx({ state: store.state(ROOM_ID), registry }), [npcScene]);
  const turn = new DefaultTurn({ store, arbiter, registry, modules, memory: new InMemoryMemory(), llm });
  const service = new MapService({
    store,
    turn,
    arbiter,
    modules,
    dialogue,
    llm,
    registry,
    contentDir,
    dataDir,
    adminToken: ADMIN_TOKEN,
  });
  return { service, store, arbiter, turn, dialogue, registry, modules, llm, contentDir, dataDir };
}

/** 走完 create→review approve→generate→publish 的合法链路，返回草案与发布场景 id */
async function publishSample(f: Fixture, draftName = "旧水房"): Promise<{ draft: MapDraft; locId: string }> {
  const created = await f.service.createDraft({ name: draftName, idea: "宿舍楼后面废弃的水房，夜里有人低语", anchorLocId: "loc_library", x: 300, y: 200 });
  if (!created.ok) throw new Error(created.message);
  const id = created.draft.id;
  expect(await f.service.reviewDraft(id, ADMIN_TOKEN, { action: "approve" })).toMatchObject({ ok: true });
  const generated = await f.service.retryGenerate(id, ADMIN_TOKEN);
  if (!generated.ok) throw new Error(generated.message);
  const published = await f.service.publishDraft(id, ADMIN_TOKEN, { action: "approve" });
  if (!published.ok || !published.scene) throw new Error("发布失败");
  return { draft: published.draft, locId: published.scene.id };
}

describe("MapService · 读地图", () => {
  it("canon 场景 / 玩家位置 / NPC 坐标", async () => {
    const f = await setup();
    const res = await f.service.getMap(ROOM_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.map.worldId).toBe("test_world");
    expect(res.map.width).toBe(1000);
    expect(res.map.image).toBe("/map/test-campus.jpg");
    expect(res.map.player).toEqual({ actorId: "plr_self", locId: "loc_library" });
    const lib = res.map.scenes.find((s) => s.id === "loc_library");
    expect(lib).toMatchObject({
      origin: "canon",
      installed: true,
      status: "built",
      category: "other",
      x: 260,
      y: 180,
      presentNpcIds: ["npc_lin"],
    });
    expect(res.map.scenes.find((s) => s.id === "loc_planned")).toMatchObject({
      status: "planned",
      installed: false,
    });
    expect(res.map.scenes.find((s) => s.id === "loc_annex")).toMatchObject({
      status: "built",
      installed: false,
    });
    const npc = res.map.npcs.find((n) => n.id === "npc_lin");
    expect(npc).toMatchObject({ name: "林夏", locId: "loc_library", x: 260, y: 180 });
    expect(res.map.published).toEqual([]);
  });
});

describe("MapService · travel", () => {
  it("走 Turn(skipLLM) 移动玩家并返回场景/事件/地图", async () => {
    const f = await setup();
    const res = await f.service.travel(ROOM_ID, "plr_self", "loc_canteen");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scene.id).toBe("loc_canteen");
    expect(res.events.some((e) => e.type === "turn.commit")).toBe(true);
    expect(res.events.some((e) => e.type === "turn.patch")).toBe(true);
    expect(res.map.player.locId).toBe("loc_canteen");
  });

  it("不存在的场景 → E_SCENE_NOT_FOUND", async () => {
    const f = await setup();
    const res = await f.service.travel(ROOM_ID, "plr_self", "loc_nowhere");
    expect(res).toMatchObject({ ok: false, code: "E_SCENE_NOT_FOUND" });
  });

  it("规划/在建点不能进入，也不会懒安装", async () => {
    const f = await setup();
    for (const locId of ["loc_planned", "loc_building"]) {
      const res = await f.service.travel(ROOM_ID, "plr_self", locId);
      expect(res).toMatchObject({ ok: false, code: "E_FORBIDDEN" });
      expect(f.store.state(ROOM_ID).entities[locId]).toBeUndefined();
      expect(f.store.state(ROOM_ID).room.scene.locId).toBe("loc_library");
    }
  });

  it("canon 新场景首次进入 → 懒安装（origin seed + 双向锚点边）", async () => {
    const f = await setup();
    expect(await f.service.travel(ROOM_ID, "plr_self", "loc_canteen")).toMatchObject({ ok: true });

    const res = await f.service.travel(ROOM_ID, "plr_self", "loc_annex");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scene.id).toBe("loc_annex");
    expect(res.map.player.locId).toBe("loc_annex");

    const state = f.store.state(ROOM_ID);
    expect(state.entities.loc_annex).toMatchObject({ kind: "loc", canon: false, origin: "seed" });
    expect(state.entities.loc_annex?.attrs).toMatchObject({ coord_x: 600, coord_y: 400 });
    const links = state.links.filter(
      (l) =>
        l.kind === "located_in" &&
        ((l.from === "loc_annex" && l.to === "loc_canteen") ||
          (l.from === "loc_canteen" && l.to === "loc_annex")),
    );
    expect(links.length).toBe(2);
  });

  it("已发布但未安装 → 先经 Arbiter 懒安装，再移动", async () => {
    const f = await setup();
    const { locId } = await publishSample(f);
    expect(locId).toMatch(/^loc_user_[0-9a-f]{8}$/);

    const before = await f.service.getMap(ROOM_ID);
    if (!before.ok) throw new Error(before.message);
    expect(before.map.scenes.find((s) => s.id === locId)).toMatchObject({ origin: "user", installed: false });

    const res = await f.service.travel(ROOM_ID, "plr_self", locId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scene.id).toBe(locId);
    expect(res.map.player.locId).toBe(locId);

    const state = f.store.state(ROOM_ID);
    const installed = state.entities[locId];
    expect(installed).toMatchObject({ kind: "loc", canon: false, origin: "ai" });
    expect(installed?.attrs.coord_x).toBe(300);
    const links = state.links.filter(
      (l) =>
        l.kind === "located_in" &&
        ((l.from === locId && l.to === "loc_library") || (l.from === "loc_library" && l.to === locId)),
    );
    expect(links.length).toBe(2);

    const after = await f.service.getMap(ROOM_ID);
    if (!after.ok) throw new Error(after.message);
    expect(after.map.scenes.find((s) => s.id === locId)).toMatchObject({ origin: "user", installed: true });
  });

  it("模块报 ok 但玩家没动 → E_NOT_ADJACENT（不再假到达）", async () => {
    const f = await setup();
    f.modules.noTravel = true;
    const res = await f.service.travel(ROOM_ID, "plr_self", "loc_canteen");
    expect(res).toMatchObject({ ok: false, code: "E_NOT_ADJACENT" });
    expect(f.store.state(ROOM_ID).room.scene.locId).toBe("loc_library");
  });

  it("懒安装缺边可补齐（半安装自愈）", async () => {
    const f = await setup();
    const { locId } = await publishSample(f);
    // 只造实体、不建边：模拟上次懒安装中途中断
    const cause: Envelope = {
      v: 1,
      id: "evt_half_install",
      roomId: ROOM_ID,
      seq: f.store.seq(ROOM_ID) + 1,
      ts: 1,
      actorId: "system",
      type: "room.bootstrap",
      payload: {},
    };
    const seeded = await f.arbiter.apply(
      ROOM_ID,
      [{ op: "entity.create", args: { id: locId, kind: "loc", name: "旧水房", attrs: { coord_x: 300, coord_y: 200 }, origin: "ai", canon: false } }],
      cause,
    );
    expect(seeded.rejected).toEqual([]);

    const res = await f.service.travel(ROOM_ID, "plr_self", locId);
    expect(res.ok).toBe(true);
    const links = f.store.state(ROOM_ID).links.filter(
      (l) => l.kind === "located_in" && ((l.from === locId && l.to === "loc_library") || (l.from === "loc_library" && l.to === locId)),
    );
    expect(links.length).toBe(2);
  });
});

describe("MapService · tick", () => {
  it("advance:true 推进一个 phase 并跑模块 tick", async () => {
    const f = await setup();
    f.modules.tickProposals = [{ op: "move.to", args: { actorId: "npc_lin", locId: "loc_canteen" }, reason: "假日程" }];
    const res = await f.service.tick(ROOM_ID, { advance: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.events.some((e) => e.type === "clock.advanced")).toBe(true);
    expect(f.store.state(ROOM_ID).clock.phase).toBe("noon");
    expect(f.modules.tickedPhases).toEqual(["noon"]);
    expect(res.moved).toEqual([{ actorId: "npc_lin", name: "林夏", from: "loc_library", to: "loc_canteen" }]);
  });

  it("advance:false 只按当前 phase 重排", async () => {
    const f = await setup();
    const res = await f.service.tick(ROOM_ID, { advance: false });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.events).toEqual([]);
    expect(res.moved).toEqual([]);
    expect(f.store.state(ROOM_ID).clock.phase).toBe("morning");
    expect(f.modules.tickedPhases).toEqual(["morning"]);
  });

  it("模块提案被 Arbiter 拒绝时整批失败，不半移动", async () => {
    const f = await setup();
    f.modules.tickProposals = [{ op: "move.to", args: { actorId: "npc_missing", locId: "loc_canteen" }, reason: "坏日程" }];
    const res = await f.service.tick(ROOM_ID, { advance: false });
    expect(res).toMatchObject({ ok: false, code: "E_ENTITY_MISSING" });
    expect(f.store.state(ROOM_ID).entities.npc_missing).toBeUndefined();
  });

  it("advance:true 时模块抛错：时段不推进、不产生事件（issue #38）", async () => {
    const f = await setup();
    const seqBefore = f.store.seq(ROOM_ID);
    f.modules.tickError = new Error("module boom");
    const res = await f.service.tick(ROOM_ID, { advance: true });
    expect(res).toMatchObject({ ok: false, code: "E_MODULE_FAULT" });
    expect(f.store.state(ROOM_ID).clock.phase).toBe("morning");
    expect(f.store.seq(ROOM_ID)).toBe(seqBefore);
  });

  it("advance:true 时提案被拒：时段不推进，重试只推进一次（issue #38）", async () => {
    const f = await setup();
    f.modules.tickProposals = [{ op: "move.to", args: { actorId: "npc_missing", locId: "loc_canteen" }, reason: "坏日程" }];
    const first = await f.service.tick(ROOM_ID, { advance: true });
    expect(first).toMatchObject({ ok: false, code: "E_ENTITY_MISSING" });
    // 旧实现此时已经提交了 time.advance：ok=false 但 phase 已经变成 noon
    expect(f.store.state(ROOM_ID).clock.phase).toBe("morning");

    // 修好日程后重试：只推进一次（morning→noon），不是补推进到 afternoon
    f.modules.tickProposals = [];
    const retry = await f.service.tick(ROOM_ID, { advance: true });
    expect(retry.ok).toBe(true);
    expect(f.store.state(ROOM_ID).clock.phase).toBe("noon");
  });

  it("落盘失败时整批不提交：时段留在原处，重试只推进一次（issue #38）", async () => {
    const flaky = new FlakyStore({ worldId: WORLD.worldId, locId: WORLD.startLocId });
    const f = await setup(undefined, flaky);
    flaky.failAppendOnce = true;
    const first = await f.service.tick(ROOM_ID, { advance: true });
    expect(first).toMatchObject({ ok: false, code: "E_STORE_FAULT" });
    expect(f.store.state(ROOM_ID).clock.phase).toBe("morning");

    const retry = await f.service.tick(ROOM_ID, { advance: true });
    expect(retry.ok).toBe(true);
    expect(f.store.state(ROOM_ID).clock.phase).toBe("noon");
  });
});

describe("MapService · 场景对话", () => {
  it("按 npc.scene 导演返回台词", async () => {
    const f = await setup();
    const res = await f.service.openDialogue(ROOM_ID, "plr_self", "loc_library", "dlg_lib");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.npc).toEqual({ id: "npc_lin", name: "林夏" });
    expect(res.lines).toEqual(["你来啦。", "随便坐。"]);
    expect(res.sessionId).toMatch(/^dlg_/);
  });

  it("不能远程触发别处场景的对话", async () => {
    const f = await setup();
    // 玩家在图书馆，却请求食堂的对话：先被"当前场景"挡下
    expect(await f.service.openDialogue(ROOM_ID, "plr_self", "loc_canteen", "dlg_lib")).toMatchObject({
      ok: false,
      code: "E_NOT_ADJACENT",
    });
    // 即使场景对了，玩家不在 presentIds 也要拒绝
    const cause: Envelope = {
      v: 1,
      id: "evt_leave",
      roomId: ROOM_ID,
      seq: f.store.seq(ROOM_ID) + 1,
      ts: 1,
      actorId: "system",
      type: "room.bootstrap",
      payload: {},
    };
    await f.arbiter.apply(ROOM_ID, [{ op: "scene.set", args: { locId: "loc_library", presentIds: ["npc_lin"] } }], cause);
    expect(await f.service.openDialogue(ROOM_ID, "plr_self", "loc_library", "dlg_lib")).toMatchObject({
      ok: false,
      code: "E_NOT_IN_ROOM",
    });
  });

  it("场景/对话不存在或 NPC 不在房间时给出明确错误码", async () => {
    const f = await setup();
    expect(await f.service.openDialogue(ROOM_ID, "plr_self", "loc_nowhere", "dlg_lib")).toMatchObject({ ok: false, code: "E_SCENE_NOT_FOUND" });
    expect(await f.service.openDialogue(ROOM_ID, "plr_self", "loc_canteen", "dlg_lib")).toMatchObject({ ok: false, code: "E_NOT_ADJACENT" });
    expect(await f.service.openDialogue(ROOM_ID, "plr_self", "loc_library", "dlg_missing")).toMatchObject({ ok: false, code: "E_DIALOGUE_NOT_FOUND" });
  });
});

describe("MapService · 草案状态机", () => {
  it("create 参数校验与锚点校验", async () => {
    const f = await setup();
    expect(await f.service.createDraft({ name: "水", idea: "太短", anchorLocId: "loc_library" })).toMatchObject({ ok: false, code: "E_SCHEMA_INVALID" });
    expect(await f.service.createDraft({ name: "旧水房", idea: "宿舍楼后面废弃的水房", anchorLocId: "loc_nowhere" })).toMatchObject({ ok: false, code: "E_SCENE_NOT_FOUND" });
    const ok = await f.service.createDraft({ name: "旧水房", idea: "宿舍楼后面废弃的水房", anchorLocId: "loc_library" });
    expect(ok).toMatchObject({ ok: true });
    if (!ok.ok) return;
    expect(ok.draft).toMatchObject({ status: "pending_review", anchorLocId: "loc_library" });
    expect(ok.draft.id).toMatch(/^draft_[0-9a-f]{8}$/);
  });

  it("合法链路 pending_review → approved → generated_pending_review → published", async () => {
    const f = await setup();
    const created = await f.service.createDraft({ name: "旧水房", idea: "宿舍楼后面废弃的水房", anchorLocId: "loc_library", x: 300, y: 200 });
    if (!created.ok) throw new Error(created.message);
    const id = created.draft.id;

    const reviewed = await f.service.reviewDraft(id, ADMIN_TOKEN, { action: "approve", note: "可以" });
    expect(reviewed).toMatchObject({ ok: true, draft: { status: "approved" } });

    const generated = await f.service.retryGenerate(id, ADMIN_TOKEN);
    expect(generated).toMatchObject({ ok: true, draft: { status: "generated_pending_review" } });
    if (!generated.ok) return;
    expect(generated.draft.generated?.dialogues.every((d) => d.id.startsWith("dlg_user_"))).toBe(true);

    const published = await f.service.publishDraft(id, ADMIN_TOKEN, { action: "approve" });
    expect(published).toMatchObject({ ok: true, draft: { status: "published" } });
    if (!published.ok || !published.scene) return;
    expect(published.scene).toMatchObject({ id: `loc_user_${id.slice("draft_".length)}`, name: "旧水房", anchorLocId: "loc_library", x: 300, y: 200 });
  });

  it("review reject 与 publish reject 都落 rejected，非法迁移被拒", async () => {
    const f = await setup();
    const created = await f.service.createDraft({ name: "旧水房", idea: "宿舍楼后面废弃的水房", anchorLocId: "loc_library" });
    if (!created.ok) throw new Error(created.message);
    const id = created.draft.id;

    expect(await f.service.retryGenerate(id, ADMIN_TOKEN)).toMatchObject({ ok: false, code: "E_ILLEGAL_OP" });
    expect(await f.service.publishDraft(id, ADMIN_TOKEN, { action: "reject" })).toMatchObject({ ok: false, code: "E_ILLEGAL_OP" });
    expect(await f.service.publishDraft(id, ADMIN_TOKEN, { action: "approve" })).toMatchObject({ ok: false, code: "E_ILLEGAL_OP" });
    expect(await f.service.reviewDraft(id, ADMIN_TOKEN, { action: "reject" })).toMatchObject({ ok: true, draft: { status: "rejected" } });
    expect(await f.service.reviewDraft(id, ADMIN_TOKEN, { action: "approve" })).toMatchObject({ ok: false, code: "E_ILLEGAL_OP" });

    const second = await f.service.createDraft({ name: "旧水房", idea: "宿舍楼后面废弃的水房", anchorLocId: "loc_library" });
    if (!second.ok) throw new Error(second.message);
    await f.service.reviewDraft(second.draft.id, ADMIN_TOKEN, { action: "approve" });
    const rejected = await f.service.publishDraft(second.draft.id, ADMIN_TOKEN, { action: "reject" });
    expect(rejected).toMatchObject({ ok: true, draft: { status: "rejected" } });
  });

  it("管理员接口校验 x-admin-token，公开接口不校验", async () => {
    const f = await setup();
    const created = await f.service.createDraft({ name: "旧水房", idea: "宿舍楼后面废弃的水房", anchorLocId: "loc_library" });
    if (!created.ok) throw new Error(created.message);
    const id = created.draft.id;

    expect(await f.service.listDrafts("wrong")).toMatchObject({ ok: false, code: "E_FORBIDDEN" });
    expect(await f.service.reviewDraft(id, "wrong", { action: "approve" })).toMatchObject({ ok: false, code: "E_FORBIDDEN" });
    expect(await f.service.publishDraft(id, "wrong", { action: "reject" })).toMatchObject({ ok: false, code: "E_FORBIDDEN" });
    expect(await f.service.retryGenerate(id, "wrong")).toMatchObject({ ok: false, code: "E_FORBIDDEN" });

    expect(await f.service.listDrafts(ADMIN_TOKEN)).toMatchObject({ ok: true });
    expect(await f.service.getDraft(id)).toMatchObject({ ok: true });
  });

  it("AI 生成失败重试一次后保持 approved 并记录 error", async () => {
    const llm = new MockLlm({ handler: () => "这不是 JSON" });
    const f = await setup(llm);
    const created = await f.service.createDraft({ name: "旧水房", idea: "宿舍楼后面废弃的水房", anchorLocId: "loc_library" });
    if (!created.ok) throw new Error(created.message);
    const id = created.draft.id;
    await f.service.reviewDraft(id, ADMIN_TOKEN, { action: "approve" });

    const res = await f.service.retryGenerate(id, ADMIN_TOKEN);
    expect(res).toMatchObject({ ok: false, code: "E_LLM_FORMAT" });
    expect(llm.calls).toBe(2);
    const got = await f.service.getDraft(id);
    if (!got.ok) return;
    expect(got.draft.status).toBe("approved");
    expect(got.draft.error?.length).toBeGreaterThan(0);
    expect(got.draft.history.some((h) => h.action === "generate:failed")).toBe(true);
  });

  it("首次生成失败、重试成功", async () => {
    const llm = new MockLlm({ responses: ["坏 JSON", VALID_SCENE] });
    const f = await setup(llm);
    const created = await f.service.createDraft({ name: "旧水房", idea: "宿舍楼后面废弃的水房", anchorLocId: "loc_library" });
    if (!created.ok) throw new Error(created.message);
    await f.service.reviewDraft(created.draft.id, ADMIN_TOKEN, { action: "approve" });

    const res = await f.service.retryGenerate(created.draft.id, ADMIN_TOKEN);
    expect(res).toMatchObject({ ok: true, draft: { status: "generated_pending_review" } });
    expect(llm.calls).toBe(2);
  });

  it("发布落盘 published.json，重新装载后 getMap 可见", async () => {
    const f = await setup();
    const { locId } = await publishSample(f);

    const onDisk = JSON.parse(await readFile(path.join(f.dataDir, "map", "published.json"), "utf8")) as {
      schemaVersion: number;
      scenes: { id: string; name: string; anchorLocId: string }[];
    };
    expect(onDisk.schemaVersion).toBe(1);
    expect(onDisk.scenes.find((s) => s.id === locId)).toMatchObject({ name: "旧水房", anchorLocId: "loc_library" });

    // 新实例从磁盘重新加载：发布库与草案库都不应依赖内存缓存
    const fresh = new MapService({
      store: f.store,
      turn: f.turn,
      arbiter: f.arbiter,
      modules: f.modules,
      dialogue: f.dialogue,
      llm: f.llm,
      registry: f.registry,
      contentDir: f.contentDir,
      dataDir: f.dataDir,
      adminToken: ADMIN_TOKEN,
    });
    const res = await fresh.getMap(ROOM_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.map.published).toContain(locId);
    expect(res.map.scenes.find((s) => s.id === locId)).toMatchObject({ origin: "user", installed: false });
  });
});

/** 模拟 FileStore：load() 之前 seq() 只会给 0（未载入的内存视图是空的） */
class UnloadedStore extends EventSourcedStore {
  private loaded = false;
  override seq(roomId: string): number {
    return this.loaded ? super.seq(roomId) : 0;
  }
  override async load(roomId: string): Promise<number> {
    const seq = await super.load(roomId);
    this.loaded = true;
    return seq;
  }
}

describe("MapService · tick 与并发写入（PR #149 审阅 P1）", () => {
  it("modules.tick 期间的并发写入不会被旧快照覆盖", async () => {
    const f = await setup();
    // 模拟 tick 正在算提案时，另一个入口（/turns）提交了一次 scene.set
    f.modules.tick = async () => {
      const seq = f.store.seq(ROOM_ID) + 1;
      const applied = await f.arbiter.apply(
        ROOM_ID,
        [{ op: "scene.set", args: { locId: "loc_canteen", presentIds: ["plr_self"] }, reason: "并发玩家移动", by: "turn" }],
        { v: 1, id: "evt_concurrent_scene", roomId: ROOM_ID, seq, ts: 2, actorId: "plr_self", type: "turn", payload: {} },
      );
      expect(applied.rejected).toEqual([]);
      // 模块基于**旧快照**算出的提案：不能落库覆盖上面那次场景切换
      return [{ op: "scene.set", args: { locId: "loc_library", presentIds: ["plr_self"] }, reason: "旧快照", by: "map" }];
    };
    const res = await f.service.tick(ROOM_ID, { advance: false });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("E_SEQ_GAP");
    const after = await f.store.snapshot(ROOM_ID);
    expect(after.room.scene.locId).toBe("loc_canteen");
  });

  it("重启后首次直接调用 tick（未经 guardRoom/load）也拿得到权威 seq（PR #149 复审 P3）", async () => {
    const f = await setup();
    // 等价于"进程重启"：新 store 实例只有磁盘事件，内存视图还没 load
    const restarted = new UnloadedStore({ worldId: WORLD.worldId, locId: WORLD.startLocId });
    restarted.append(ROOM_ID, await f.store.events(ROOM_ID, 0));
    const arbiter = new DefaultArbiter({ store: restarted, registry: f.registry });
    const llm = new MockLlm({ responses: [VALID_SCENE] });
    const turn = new DefaultTurn({ store: restarted, arbiter, registry: f.registry, modules: f.modules, memory: new InMemoryMemory(), llm });
    const dialogue = new DialogueHost(() => makeCtx({ state: restarted.state(ROOM_ID), registry: f.registry }), [npcScene]);
    const service = new MapService({
      store: restarted,
      turn,
      arbiter,
      modules: f.modules,
      dialogue,
      llm,
      registry: f.registry,
      contentDir: f.contentDir,
      dataDir: f.dataDir,
      adminToken: ADMIN_TOKEN,
    });
    // 未 load 时 seq() 只会给 0：旧实现既不载入日志、也拿 0 当 expectedSeq（真有写入时首拍即假 E_SEQ_GAP）
    expect(restarted.seq(ROOM_ID)).toBe(0);
    const res = await service.tick(ROOM_ID, { advance: false });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(restarted.seq(ROOM_ID)).toBeGreaterThan(0);
  });
});
