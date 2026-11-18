/**
 * MapService —— 地图 / 移动 / 时间推进 / 场景对话的服务端门面（docs/06 §4）。
 *
 * 职责边界：
 * - 读：扫描 canon 模板 + 已发布场景，组装 MapView（坐标优先级 实体 attrs → 场景数据 → 0）；
 * - 写：只有两种写入 —— travel 的懒安装 / tick 的模块提案，全部经 Arbiter.apply；
 * - 草案：委托 DraftEngine（状态机 + AI 生成 + published.json 落盘）。
 */
import { isErrorCode } from "../../../packages/shared/src/contract/errors.ts";
import type {
  Arbiter,
  Dialogue,
  DialogueSpec,
  Envelope,
  Entity,
  LinkKind,
  LlmPort,
  ModuleContext,
  Modules,
  Phase,
  Proposal,
  Registry,
  Store,
  Turn,
  TurnEvent,
  WorldState,
} from "../../../packages/shared/src/contract/types.ts";
import {
  MapContent,
  codeOfError,
  fail,
  hex8,
  isMapFail,
} from "./map.data.ts";
import type { MapFail, SceneDialogue, SceneLink, SceneRef, SceneStatus, SceneTemplate } from "./map.data.ts";
import { DraftEngine } from "./map.drafts.ts";
import type { DraftListResult, DraftResult, PublishResult } from "./map.drafts.ts";

// ---------------------------------------------------------------- 对外视图（docs/06 §4）
export interface MapViewLink {
  kind: SceneLink["kind"];
  id: string;
  label?: string;
  available: boolean;
}

export interface MapViewScene {
  id: string;
  name: string;
  desc: string;
  tags: string[];
  x: number;
  y: number;
  status: SceneStatus;
  category: string;
  origin: "canon" | "user";
  installed: boolean;
  presentNpcIds: string[];
  residentNpcIds: string[];
  links: MapViewLink[];
}

export interface MapViewNpc {
  id: string;
  name: string;
  locId: string;
  x: number;
  y: number;
}

export interface MapView {
  worldId: string;
  width: number;
  height: number;
  image: string | null;
  clock: { day: number; phase: Phase; tick: number };
  player: { actorId: string; locId: string };
  scenes: MapViewScene[];
  npcs: MapViewNpc[];
  published: string[];
}

export interface MapSceneDetail extends MapViewScene {
  dialogues: SceneDialogue[];
  anchorLocId?: string;
}

export interface MovedSummary {
  actorId: string;
  name: string;
  from: string;
  to: string;
}

export type GetMapResult = { ok: true; map: MapView } | MapFail;
export type TravelResult = { ok: true; scene: MapSceneDetail; events: TurnEvent[]; map: MapView } | MapFail;
export type TickResult = { ok: true; events: Envelope[]; moved: MovedSummary[]; map: MapView } | MapFail;
export type DialogueResult = { ok: true; npc: { id: string; name: string }; lines: string[]; sessionId: string } | MapFail;

export interface MapServiceDeps {
  store: Store;
  turn: Turn;
  arbiter: Arbiter;
  modules: Modules;
  dialogue: Dialogue;
  llm: LlmPort;
  registry: Registry;
  contentDir: string;
  dataDir: string;
  adminToken: string;
  now?: () => number;
}

const PHASES: readonly Phase[] = ["morning", "noon", "afternoon", "evening", "night"];
const INSTALL_MAX_DEPTH = 8;

function nextPhase(phase: Phase): Phase {
  const index = PHASES.indexOf(phase);
  return PHASES[(index + 1) % PHASES.length] ?? "morning";
}

function isLive(state: WorldState, id: string): boolean {
  const entity = state.entities[id];
  return entity !== undefined && entity.status !== "tombstoned";
}

export class MapService {
  private readonly deps: MapServiceDeps;
  private readonly content: MapContent;
  private readonly drafts: DraftEngine;

  constructor(deps: MapServiceDeps) {
    this.deps = deps;
    this.content = new MapContent({ contentDir: deps.contentDir, dataDir: deps.dataDir });
    this.drafts = new DraftEngine({
      content: this.content,
      llm: deps.llm,
      adminToken: deps.adminToken,
      now: deps.now ?? Date.now,
    });
  }

  // -------------------------------------------------------------- 草案 API（状态机在 map.drafts.ts）
  createDraft(body: unknown): Promise<DraftResult> {
    return this.drafts.create(body);
  }

  getDraft(id: string): Promise<DraftResult> {
    return this.drafts.get(id);
  }

  listDrafts(token: string): Promise<DraftListResult> {
    return this.drafts.list(token);
  }

  reviewDraft(id: string, token: string, body: unknown): Promise<DraftResult> {
    return this.drafts.review(id, token, body);
  }

  publishDraft(id: string, token: string, body: unknown): Promise<PublishResult> {
    return this.drafts.publish(id, token, body);
  }

  retryGenerate(id: string, token: string): Promise<DraftResult> {
    return this.drafts.generate(id, token);
  }

  // -------------------------------------------------------------- 读地图
  async getMap(roomId: string, actorId?: string): Promise<GetMapResult> {
    const state = await this.deps.store.snapshot(roomId);
    // actorId 缺省时从房间成员表解析（服务端签发，不再默认 plr_self）
    return { ok: true, map: await this.buildMapView(state, actorId ?? playerActorId(state)) };
  }

  // -------------------------------------------------------------- 移动（turn 跑完整流程，skipLLM）
  async travel(roomId: string, actorId: string | undefined, locId: string): Promise<TravelResult> {
    const { refs } = await this.content.sceneRefs();
    const target = refs.get(locId);
    if (!target) return fail("E_SCENE_NOT_FOUND", `场景 ${locId} 不存在`);
    // 规划/在建点只用于地图展示：不能进入，也不触发懒安装
    if (target.scene.status !== "built") {
      const label = target.scene.status === "planned" ? "规划中，尚未建成" : "在建，暂不可进入";
      return fail("E_FORBIDDEN", `${target.scene.name}${label}`);
    }

    const state = await this.deps.store.snapshot(roomId);
    const actor = actorId ?? playerActorId(state);
    if (target.origin === "user") {
      // 已发布场景每次进入都做一次幂等安装：实体可能已 live 但缺边（上次半途失败），要能补齐
      const installFail = await this.installScene(roomId, locId, refs, 0);
      if (installFail) return installFail;
    } else if (!isLive(state, locId)) {
      // canon 新场景首次进入时才懒安装（老场景在建房时已 seed）
      const installFail = await this.installScene(roomId, locId, refs, 0);
      if (installFail) return installFail;
    }

    const events: TurnEvent[] = [];
    let failure: MapFail | undefined;
    try {
      for await (const event of this.deps.turn.run({
        roomId,
        actorId: actor,
        input: `map.travel ${locId}`,
        clientTurnId: `map_travel_${hex8()}`,
        options: { skipLLM: true },
      })) {
        events.push(event);
        if (event.type === "turn.error" || event.type === "turn.rejected") {
          failure = fail(isErrorCode(event.code) ? event.code : "E_MODULE_FAULT", event.message);
          break;
        }
        if (event.type === "turn.commit") break;
      }
    } catch (e) {
      return fail(codeOfError(e), e instanceof Error ? e.message : String(e));
    }
    if (failure) return failure;

    const after = await this.deps.store.snapshot(roomId);
    // 模块对"不可达"会返回 ok:true + 空 proposals，而 Arbiter 部分应用也返回 ok:true；
    // 只看 turn 事件会把"没走动"当成到达。以移动后的权威位置做最终校验。
    const actorLoc = after.links.find((l) => l.kind === "located_in" && l.from === actor)?.to;
    if (after.room.scene.locId !== locId && actorLoc !== locId) {
      return fail("E_NOT_ADJACENT", `从当前位置无法到达 ${locId}`);
    }
    const map = await this.buildMapView(after, actor);
    const scene = this.buildSceneDetail(target, after, refs, npcLocations(after));
    return { ok: true, scene, events, map };
  }

  // -------------------------------------------------------------- tick（不经过 Turn / LLM）
  async tick(roomId: string, opts: { advance?: boolean } = {}): Promise<TickResult> {
    const events: Envelope[] = [];
    const state = await this.deps.store.snapshot(roomId);
    const phase = opts.advance ? nextPhase(state.clock.phase) : state.clock.phase;
    const actorId = playerActorId(state);

    let proposals: Proposal[];
    try {
      proposals = await this.deps.modules.tick(
        this.moduleContext(roomId, actorId, `map.tick:${phase}`, state),
        phase,
      );
    } catch (e) {
      return fail(codeOfError(e), e instanceof Error ? e.message : String(e));
    }

    // issue #38：time.advance 与模块提案必须合成**同一批**提交。旧实现先单独提交时间推进，
    // 后阶段失败时时段已经前进且无法撤销（响应 ok:false 但世界变了，重试还会多推一次）。
    // 注意：模块拿到的 ctx.clock 是推进前状态，目标 phase 以 `tick(ctx, phase)` 的参数为准。
    const batch: Proposal[] = opts.advance
      ? [{ op: "time.advance", args: { phase }, reason: "地图 tick 推进时段", by: "tick" }, ...proposals]
      : proposals;
    if (batch.length > 0) {
      // 先整批 dryRun：任何一条被拒就整批不落库，避免 NPC 半移动、坐标与镜头不一致。
      // 注意 dryRun 的信封来源是 `arbiter.dryRun`，3.2.1 的 `time.advance` 只认
      // engine/tick 来源（不认 proposal.by），所以这里只预检模块提案；time.advance 由
      // 下面带 `cause {type:"tick"}` 的 apply 一并裁决——apply 是 atomic，失败即整批回滚。
      if (proposals.length > 0) {
        const dry = await this.deps.arbiter.dryRun(roomId, proposals);
        const dryRejected = dry.rejected[0];
        if (!dry.ok || dryRejected) {
          return fail(
            dryRejected && isErrorCode(dryRejected.code) ? dryRejected.code : "E_MODULE_FAULT",
            dryRejected?.detail ?? "tick 提案未通过 Arbiter 校验",
          );
        }
      }
      // apply 默认 atomic：dryRun 与 apply 之间若有竞争/落盘失败，整批回滚（含 time.advance）。
      try {
        const applied = await this.deps.arbiter.apply(roomId, batch, this.cause(roomId, "tick"));
        const rejected = applied.rejected[0];
        if (!applied.ok || rejected) {
          const code = rejected && isErrorCode(rejected.code)
            ? rejected.code
            : applied.error && isErrorCode(applied.error.code)
              ? applied.error.code
              : "E_MODULE_FAULT";
          return fail(code, rejected?.detail ?? applied.error?.message ?? "tick 提案未提交");
        }
        events.push(...applied.events);
      } catch (e) {
        // 兜底未预期异常；语义与 E_STORE_FAULT 一致：整批未提交
        return fail(codeOfError(e), e instanceof Error ? e.message : String(e));
      }
    }

    const after = await this.deps.store.snapshot(roomId);
    return {
      ok: true,
      events,
      moved: movedSummaries(events, after),
      map: await this.buildMapView(after, actorId),
    };
  }

  // -------------------------------------------------------------- 场景对话（npc.scene 导演）
  async openDialogue(
    roomId: string,
    actorId: string | undefined,
    sceneId: string,
    dialogueId: string,
  ): Promise<DialogueResult> {
    const { refs } = await this.content.sceneRefs();
    const sceneRef = refs.get(sceneId);
    if (!sceneRef) return fail("E_SCENE_NOT_FOUND", `场景 ${sceneId} 不存在`);

    const state = await this.deps.store.snapshot(roomId);
    const actor = actorId ?? playerActorId(state);
    // 只能触发"当前所在地 + 玩家在场"的场景对话，避免从地图远程播放别处剧情
    if (state.room.scene.locId !== sceneId) {
      return fail("E_NOT_ADJACENT", `你不在 ${sceneId}，不能触发该场景对话`);
    }
    if (!state.room.scene.presentIds.includes(actor)) {
      return fail("E_NOT_IN_ROOM", "玩家不在当前场景");
    }

    const dialogue = sceneRef.scene.dialogues.find((d) => d.id === dialogueId);
    if (!dialogue) return fail("E_DIALOGUE_NOT_FOUND", `场景 ${sceneId} 没有对话 ${dialogueId}`);

    const npc = state.entities[dialogue.npcId];
    if (!npc || npc.kind !== "npc" || !isLive(state, dialogue.npcId)) {
      return fail("E_ENTITY_MISSING", `对话 NPC ${dialogue.npcId} 不在本房间`);
    }
    // 不强制 NPC 与玩家同场景：AI 生成的场景对话可能是"门后的声音/电话/留言"，
    // 强校验会让生成内容几乎永远不可用；玩家必须在场这一点已在上面校验。

    const spec: DialogueSpec = {
      roomId,
      participants: [npc.id],
      directorId: "npc.scene",
      seed: {
        sceneId,
        dialogueId,
        npcId: npc.id,
        npcName: npc.name,
        lines: dialogue.lines,
      },
      maxTurns: Math.min(8, dialogue.lines.length),
      visibility: "scene",
    };
    try {
      const session = await this.deps.dialogue.open(spec);
      const lines: string[] = [];
      let done = false;
      while (!done) {
        const step = await this.deps.dialogue.step(session.id);
        lines.push(...step.utterances.map((u) => u.text));
        done = step.done;
      }
      await this.deps.dialogue.close(session.id, "scene dialogue");
      return { ok: true, npc: { id: npc.id, name: npc.name }, lines, sessionId: session.id };
    } catch (e) {
      return fail(codeOfError(e), e instanceof Error ? e.message : String(e));
    }
  }

  // -------------------------------------------------------------- 内部：组装 MapView
  private async buildMapView(state: WorldState, actorId: string): Promise<MapView> {
    const { world, published, refs } = await this.content.sceneRefs();
    const npcLoc = npcLocations(state);
    const scenes = [...refs.values()].map((ref) => this.buildScene(ref, state, refs, npcLoc));
    const npcItems = Object.values(state.entities)
      .filter((e) => e.kind === "npc" && e.status !== "tombstoned")
      .map((e) => {
        const locId = npcLoc.get(e.id) ?? "";
        const fallback = refs.get(locId)?.scene;
        const attrX = e.attrs.coord_x;
        const attrY = e.attrs.coord_y;
        // 与 loc 同策略：当前所在场景的模板坐标优先，旧存档里的 1000×640 旧 attrs 只作兜底。
        const base = fallback
          ? { x: fallback.x, y: fallback.y }
          : typeof attrX === "number" && typeof attrY === "number"
            ? { x: attrX, y: attrY }
            : { x: 0, y: 0 };
        return { id: e.id, name: e.name, locId, ...base };
      });
    // 同场景多个 NPC 的坐标可能完全相同；按 id 排序做确定性小偏移，纯展示，不写状态。
    const byLoc = new Map<string, typeof npcItems>();
    for (const npc of npcItems) {
      if (npc.locId === "") continue;
      const group = byLoc.get(npc.locId);
      if (group) group.push(npc);
      else byLoc.set(npc.locId, [npc]);
    }
    for (const group of byLoc.values()) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => a.id.localeCompare(b.id));
      sorted.forEach((npc, i) => {
        const angle = -Math.PI / 2 + (2 * Math.PI * i) / sorted.length;
        npc.x = Math.round(npc.x + Math.cos(angle) * 34);
        npc.y = Math.round(npc.y + Math.sin(angle) * 34);
      });
    }
    const npcs: MapViewNpc[] = npcItems.map(({ id, name, locId, x, y }) => ({ id, name, locId, x, y }));
    return {
      worldId: world.worldId,
      width: world.width,
      height: world.height,
      image: world.image ?? null,
      clock: { day: state.clock.day, phase: state.clock.phase, tick: state.clock.tick },
      player: { actorId, locId: state.room.scene.locId },
      scenes,
      npcs,
      published: published.map((s) => s.id),
    };
  }

  private buildScene(
    ref: SceneRef,
    state: WorldState,
    refs: Map<string, SceneRef>,
    npcLoc: Map<string, string>,
  ): MapViewScene {
    const template = ref.scene;
    const coords = this.coordsOf(state.entities[template.id], template);
    const presentNpcIds = [...npcLoc.entries()].filter(([, loc]) => loc === template.id).map(([id]) => id);
    const residentNpcIds = template.links.filter((l) => l.kind === "npc").map((l) => l.id);
    const links = template.links.map((link) => this.buildLink(link, template, refs, state));
    return {
      id: template.id,
      name: template.name,
      desc: template.desc,
      tags: template.tags,
      x: coords.x,
      y: coords.y,
      status: template.status,
      category: template.category,
      origin: ref.origin,
      installed: isLive(state, template.id),
      presentNpcIds,
      residentNpcIds,
      links,
    };
  }

  private buildSceneDetail(
    ref: SceneRef,
    state: WorldState,
    refs: Map<string, SceneRef>,
    npcLoc: Map<string, string>,
  ): MapSceneDetail {
    const detail: MapSceneDetail = { ...this.buildScene(ref, state, refs, npcLoc), dialogues: ref.scene.dialogues };
    if (ref.anchorLocId !== undefined) detail.anchorLocId = ref.anchorLocId;
    return detail;
  }

  private buildLink(
    link: SceneLink,
    scene: SceneTemplate,
    refs: Map<string, SceneRef>,
    state: WorldState,
  ): MapViewLink {
    const base = link.label === undefined ? { kind: link.kind, id: link.id } : { kind: link.kind, id: link.id, label: link.label };
    switch (link.kind) {
      case "module":
        return { ...base, available: this.deps.modules.get(link.id)?.loaded === true };
      case "npc":
        return { ...base, available: isLive(state, link.id) && state.entities[link.id]?.kind === "npc" };
      case "dialogue":
        return { ...base, available: scene.dialogues.some((d) => d.id === link.id) };
      case "scene":
        return { ...base, available: refs.has(link.id) || isLive(state, link.id) };
    }
  }

  private coordsOf(entity: Entity | undefined, fallback?: SceneTemplate): { x: number; y: number } {
    // 地图模板是点位权威：旧存档里的 coord 属性可能还是旧画布尺寸（1000×640），
    // 若优先读属性会把老房间的点位甩到左上角；模板存在时一律用模板坐标。
    if (fallback) return { x: fallback.x, y: fallback.y };
    const x = typeof entity?.attrs.coord_x === "number" ? entity.attrs.coord_x : 0;
    const y = typeof entity?.attrs.coord_y === "number" ? entity.attrs.coord_y : 0;
    return { x, y };
  }

  // -------------------------------------------------------------- 内部：懒安装（全部过 Arbiter）
  private async installScene(
    roomId: string,
    locId: string,
    refs: Map<string, SceneRef>,
    depth: number,
  ): Promise<MapFail | undefined> {
    if (depth > INSTALL_MAX_DEPTH) return fail("E_ILLEGAL_OP", "场景锚点链过深，拒绝懒安装");
    const ref = refs.get(locId);
    if (!ref) return fail("E_SCENE_NOT_FOUND", `场景 ${locId} 不存在`);
    if (ref.scene.status !== "built") return fail("E_FORBIDDEN", `${ref.scene.name}尚未建成，不能进入`);
    if (ref.anchorLocId === undefined) {
      return fail("E_SCENE_NOT_FOUND", `地点实体 ${locId} 不在本房间`);
    }
    // 锚点可能也是"已发布未安装"的用户场景，先递归装它，保证 located_in 两端 live
    const pre = await this.deps.store.snapshot(roomId);
    if (!isLive(pre, ref.anchorLocId)) {
      const anchorFail = await this.installScene(roomId, ref.anchorLocId, refs, depth + 1);
      if (anchorFail) return anchorFail;
    }

    const state = await this.deps.store.snapshot(roomId);
    const hasEdge = (from: string, to: string): boolean =>
      state.links.some((l) => l.kind === "located_in" && l.from === from && l.to === to);
    // 已 live 但缺双向边的半安装要能补齐：只创建缺失的部分，而不是直接短路
    const ops: Proposal[] = [];
    if (!isLive(state, ref.scene.id)) {
      ops.push({
        op: "entity.create",
        args: {
          id: ref.scene.id,
          kind: "loc",
          name: ref.scene.name,
          attrs: { coord_x: ref.scene.x, coord_y: ref.scene.y },
          tags: ref.scene.tags,
          origin: ref.origin === "user" ? "ai" : "seed",
          canon: false,
        },
        reason: "懒安装地图场景",
        by: "map.service",
      });
    }
    if (!hasEdge(ref.anchorLocId, ref.scene.id)) {
      ops.push({
        op: "link.create",
        args: { kind: "located_in", from: ref.anchorLocId, to: ref.scene.id },
        reason: "锚点→新场景通路",
        by: "map.service",
      });
    }
    if (!hasEdge(ref.scene.id, ref.anchorLocId)) {
      ops.push({
        op: "link.create",
        args: { kind: "located_in", from: ref.scene.id, to: ref.anchorLocId },
        reason: "新场景→锚点通路",
        by: "map.service",
      });
    }
    if (ops.length === 0) return undefined;

    const dry = await this.deps.arbiter.dryRun(roomId, ops);
    const dryRejected = dry.rejected[0];
    if (!dry.ok || dryRejected) {
      return fail(
        dryRejected && isErrorCode(dryRejected.code) ? dryRejected.code : "E_MODULE_FAULT",
        dryRejected?.detail ?? "场景懒安装未通过 Arbiter 校验",
      );
    }
    const applied = await this.deps.arbiter.apply(roomId, ops, this.cause(roomId, "map.install"));
    const rejected = applied.rejected[0];
    if (!applied.ok || rejected) {
      return fail(
        rejected && isErrorCode(rejected.code) ? rejected.code : "E_MODULE_FAULT",
        rejected?.detail ?? "场景懒安装被 Arbiter 拒绝",
      );
    }
    return undefined;
  }

  // -------------------------------------------------------------- 内部：tick / cause
  private moduleContext(roomId: string, actorId: string, input: string, state: WorldState): ModuleContext {
    return {
      roomId,
      actorId,
      input,
      state,
      registry: this.deps.registry,
      clock: state.clock,
      query: {
        entity: (id) => state.entities[id],
        attr: (entityId, key) => state.entities[entityId]?.attrs[key],
        present: () => [...state.room.scene.presentIds],
        links: (kind: LinkKind | undefined, from: string | undefined) =>
          state.links.filter((l) => (kind === undefined || l.kind === kind) && (from === undefined || l.from === from)),
      },
      llm: this.deps.llm,
      log: () => undefined,
    };
  }

  private cause(roomId: string, type: string): Envelope {
    return {
      v: 1,
      id: `evt_map_${type}_${hex8()}`,
      roomId,
      seq: 0, // 真实 seq 由 Arbiter 按 store 分配；cause 只用来标 room/type/actor
      ts: (this.deps.now ?? Date.now)(),
      actorId: "system",
      type,
      payload: {},
    };
  }
}

// ---------------------------------------------------------------- 纯函数
function playerActorId(state: WorldState): string {
  const member = state.room.members.find((m) => m.role === "player");
  if (member) return member.actorId;
  // 老房间/unseed 状态：成员表可能为空，退化为从实体表认（kind=plr）；
  // 最后才给 "system"（只应出现在测试/异常状态里，正常房间不会走到）。
  const plr = Object.values(state.entities).find((e) => e.kind === "plr" && e.status === "active");
  return plr?.id ?? state.room.members[0]?.actorId ?? "system";
}

/** NPC 当前位置 = 其 located_in 边的终点（谁移动谁负责维护这条边） */
function npcLocations(state: WorldState): Map<string, string> {
  const out = new Map<string, string>();
  for (const link of state.links) {
    if (link.kind !== "located_in") continue;
    const entity = state.entities[link.from];
    if (!entity || entity.kind !== "npc" || entity.status === "tombstoned") continue;
    out.set(link.from, link.to);
  }
  return out;
}

function movedSummaries(events: Envelope[], state: WorldState): MovedSummary[] {
  const moved: MovedSummary[] = [];
  for (const event of events) {
    if (event.type !== "actor.moved") continue;
    const payload = event.payload as { actorId?: unknown; from?: unknown; to?: unknown };
    if (typeof payload.actorId !== "string" || typeof payload.from !== "string" || typeof payload.to !== "string") continue;
    const name = state.entities[payload.actorId]?.name ?? payload.actorId;
    moved.push({ actorId: payload.actorId, name, from: payload.from, to: payload.to });
  }
  return moved;
}
