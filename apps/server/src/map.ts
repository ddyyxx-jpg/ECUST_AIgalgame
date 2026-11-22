/**
 * MapService —— 地图 / 移动 / 时间推进 / 场景对话的服务端门面（docs/06 §4）。
 *
 * 职责边界：
 * - 读：扫描 canon 模板 + 已发布场景，组装 MapView（坐标优先级 实体 attrs → 场景数据 → 0）；
 * - 写：只有两种写入 —— travel 的懒安装 / tick 的模块提案，全部经 Arbiter.apply；
 * - 草案：委托 DraftEngine（状态机 + AI 生成 + published.json 落盘）。
 */
import { DEFAULT_LIMITS } from "../../../packages/engine/src/index.ts";
import type { DefaultArbiter, MemoryIndex } from "../../../packages/engine/src/index.ts";
import { isErrorCode } from "../../../packages/shared/src/contract/errors.ts";
import type {
  Arbiter,
  Dialogue,
  DialogueSpec,
  DialogueStep,
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
import { displayNameOf, knowsNameOf, maskNamesDeep, maskTurnEvents, unknownPlaceholders } from "./view-names.ts";
import { projectEventsForPlayer, projectTurnEventForPlayer } from "./outbound-secrets.ts";

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
  arbiter: Pick<Arbiter, "dryRun"> & Pick<DefaultArbiter, "apply">;
  modules: Modules;
  dialogue: Dialogue;
  llm: LlmPort;
  registry: Registry;
  /** 夜间密谋的私忆也要进同一份记忆索引；不接会让"tick 后立刻召回"落空（PR #147 审阅 P1-2）。生产入口（bootstrap）必传 */
  memory?: Pick<MemoryIndex, "ingest">;
  contentDir: string;
  dataDir: string;
  adminToken: string;
  /** npcId → 外貌描述（content/scenarios/npcs.json 的 appearance）：未认识时用作占位名 */
  appearance?: Map<string, string>;
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
  /**
   * issue #62：早期失败脱敏用的占位表缓存，按 roomId 一份轻量 Map（真名 → 占位名），
   * 不缓存整份 WorldState，避免长期占用内存。只保存最近一次算出的表。
   */
  private readonly failPlaceholders = new Map<string, Map<string, string>>();

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

  /**
   * travel / tick / scene dialogue 所有返回点的统一出站脱敏出口（issue #53 成功，#58 失败，#61 对话）。
   *
   * 成功整包交给 maskTurnEvents；失败响应（MapFail）同属出站视图，message / details
   * 里的文本同样可能带未认识 NPC 真名，走同一层掩码。maskNamesDeep 只替换未认识
   * NPC 真名，错误码 / 场景 id 不含人名，不会被误伤。早期失败可能拿不到快照，
   * 此时 maskTurnEvents 回退到 store.snapshot；已有快照的调用点传入可省一次回放。
   */
  private async outbound<T extends TravelResult | TickResult | DialogueResult>(
    result: T,
    roomId: string,
    state?: WorldState,
  ): Promise<T> {
    const masked = await maskTurnEvents<T>(roomId, result, this.deps.store, this.deps.appearance, state);
    // travel 也走 Turn：它的 events 里有 turn.patch（整份 state + ops），只遮人名不够
    // （PR #149 审阅 P0-1/P0-2）。tick 的 Envelope 已在上游裁过，这里幂等。
    const withEvents = masked as unknown as { events?: unknown };
    if (Array.isArray(withEvents.events)) {
      (withEvents as { events: unknown[] }).events = withEvents.events.map((ev) =>
        typeof ev === "object" && ev !== null ? projectTurnEventForPlayer(ev as { type: string }) : ev,
      );
    }
    return masked;
  }

  /**
   * issue #62：早期失败（travel 的 E_SCENE_NOT_FOUND、规划/在建点 E_FORBIDDEN）发生在取快照之前，
   * 此时拿不到 state；若照常走 outbound → maskTurnEvents，就会每次都 `store.snapshot(roomId)`，
   * FileStore 每次 ensure + replay 整条事件日志（O(事件数)）。无鉴权下重复请求非法 locId 可放大
   * CPU / 磁盘读。这里按房间缓存最近一次算出的占位表：命中直接复用，未命中才回退一次 snapshot
   * （首个请求的必要代价），之后同房间的早期失败不再回放日志。
   *
   * 安全性论证（缓存陈旧不会导致漏遮）：早期失败的 message 只来自静态场景名（canon 模板 /
   * 已发布场景数据）和用户传入的 locId，不是"状态里新出现的 NPC 名"。占位表的变化只会随
   * knows_name 变 true 而移除条目（已认识 → 真名可直接显示），陈旧表至多让本该显示的已认识名
   * 被多遮一次（可接受）。边界：缓存填充后才发布、且场景名里带新 NPC 真名的静态数据不在旧表里，
   * 该极端情形需靠场景发布时清空缓存（当前发布低频，未做）。
   */
  private async maskEarlyFailure(result: MapFail, roomId: string): Promise<MapFail> {
    let placeholders = this.failPlaceholders.get(roomId);
    if (!placeholders) {
      const state = await this.deps.store.snapshot(roomId);
      placeholders = unknownPlaceholders(state, this.deps.appearance);
      this.failPlaceholders.set(roomId, placeholders);
    }
    return maskNamesDeep(result, placeholders);
  }

  // -------------------------------------------------------------- 移动（turn 跑完整流程，skipLLM）
  async travel(roomId: string, actorId: string | undefined, locId: string): Promise<TravelResult> {
    const { refs } = await this.content.sceneRefs();
    const target = refs.get(locId);
    if (!target) return this.maskEarlyFailure(fail("E_SCENE_NOT_FOUND", `场景 ${locId} 不存在`), roomId);
    // 规划/在建点只用于地图展示：不能进入，也不触发懒安装
    if (target.scene.status !== "built") {
      const label = target.scene.status === "planned" ? "规划中，尚未建成" : "在建，暂不可进入";
      return this.maskEarlyFailure(fail("E_FORBIDDEN", `${target.scene.name}${label}`), roomId);
    }

    const state = await this.deps.store.snapshot(roomId);
    const actor = actorId ?? playerActorId(state);
    if (target.origin === "user") {
      // 已发布场景每次进入都做一次幂等安装：实体可能已 live 但缺边（上次半途失败），要能补齐
      const installFail = await this.installScene(roomId, locId, refs, 0);
      if (installFail) return this.outbound(installFail, roomId, state);
    } else if (!isLive(state, locId)) {
      // canon 新场景首次进入时才懒安装（老场景在建房时已 seed）
      const installFail = await this.installScene(roomId, locId, refs, 0);
      if (installFail) return this.outbound(installFail, roomId, state);
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
      return this.outbound(fail(codeOfError(e), e instanceof Error ? e.message : String(e)), roomId, state);
    }
    if (failure) return this.outbound(failure, roomId, state);

    const patch = events.find((event) => event.type === "turn.patch");
    const after = patch?.state ?? await this.deps.store.snapshot(roomId);
    // 模块对"不可达"会返回 ok:true + 空 proposals，而 Arbiter 部分应用也返回 ok:true；
    // 只看 turn 事件会把"没走动"当成到达。以移动后的权威位置做最终校验。
    const actorLoc = after.links.find((l) => l.kind === "located_in" && l.from === actor)?.to;
    if (after.room.scene.locId !== locId && actorLoc !== locId) {
      return this.outbound(fail("E_NOT_ADJACENT", `从当前位置无法到达 ${locId}`), roomId, after);
    }
    const map = await this.buildMapView(after, actor);
    const scene = this.buildSceneDetail(target, after, refs, npcLocations(after));
    // 出站脱敏（issue #53 成功 / #58 失败）：统一走 outbound，成功整包、失败只遮文本，
    // 与 /turns /events /state /history 同口径；用 after 快照省一次事件日志回放。
    return this.outbound<TravelResult>({ ok: true, scene, events, map }, roomId, after);
  }

  // -------------------------------------------------------------- tick（不经过 Turn / LLM）
  /**
   * 房间级串行队列（PR #147 审阅 P2-1）：tick 的 phase 判定、第一批提交、夜间编排
   * 全部基于同一份快照，并发两个 tick 会各推一天、各开一场密谋。Arbiter 只保证
   * 单次 apply 原子，不保证"读快照→判定→再次 apply"这条跨 apply 的业务链。
   * 队列只按 roomId 串行，房间之间互不阻塞；上一次失败不阻断下一次（错误已由返回值承载）。
   */
  private readonly tickQueues = new Map<string, Promise<unknown>>();

  async tick(roomId: string, opts: { advance?: boolean; viewer?: string } = {}): Promise<TickResult> {
    const prev = this.tickQueues.get(roomId) ?? Promise.resolve();
    const next = prev.then(
      () => this.tickInner(roomId, opts),
      () => this.tickInner(roomId, opts),
    );
    // 队列里只留"已 settle"的尾巴，避免错误态 Promise 污染下一次；返回值仍走 next
    this.tickQueues.set(roomId, next.catch(() => undefined));
    return next;
  }

  private async tickInner(roomId: string, opts: { advance?: boolean; viewer?: string } = {}): Promise<TickResult> {
    const events: Envelope[] = [];
    let stateAfter: WorldState | undefined;
    // 必须在 snapshot **之前**取 seq（PR #149 审阅 P1）：模块 tick / dryRun 期间如果有
    // /turns 提交（例如 scene.set），snapshot 之后取的 seq 已经是新值，expectedSeq 会通过，
    // 于是用旧快照算出的提案把并发写入覆盖掉。先取 seq 再读快照，最坏只是保守失败一次。
    const seqBefore = this.seqOf(roomId);
    const state = await this.deps.store.snapshot(roomId);
    const phase = opts.advance ? nextPhase(state.clock.phase) : state.clock.phase;
    // 出站视角按调用者解析（PR #149 P3）：联机房不能用"1 号玩家"替别人过滤私忆
    const actorId = opts.viewer ?? playerActorId(state);

    let proposals: Proposal[];
    try {
      proposals = await this.deps.modules.tick(
        this.moduleContext(roomId, actorId, `map.tick:${phase}`, state),
        phase,
      );
    } catch (e) {
      return this.outbound(fail(codeOfError(e), e instanceof Error ? e.message : String(e)), roomId, state);
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
          return this.outbound(fail(
            dryRejected && isErrorCode(dryRejected.code) ? dryRejected.code : "E_MODULE_FAULT",
            dryRejected?.detail ?? "tick 提案未通过 Arbiter 校验",
          ), roomId, state);
        }
      }
      // apply 默认 atomic：dryRun 与 apply 之间若有竞争/落盘失败，整批回滚（含 time.advance）。
      try {
        const applied = await this.deps.arbiter.apply(roomId, batch, this.cause(roomId, "tick"), {
          captureState: true,
          // 队列内已串行，这里再加 seq 防线：队列之外的写入（对话/后台任务）插队时整批拒绝，
          // 而不是把 time.advance 叠在别人刚提交的状态上（P2-1）
          ...(seqBefore !== undefined ? { expectedSeq: seqBefore } : {}),
        });
        const rejected = applied.rejected[0];
        if (!applied.ok || rejected) {
          const code = rejected && isErrorCode(rejected.code)
            ? rejected.code
            : applied.error && isErrorCode(applied.error.code)
              ? applied.error.code
              : "E_MODULE_FAULT";
          return this.outbound(fail(code, rejected?.detail ?? applied.error?.message ?? "tick 提案未提交"), roomId, state);
        }
        events.push(...applied.events);
        stateAfter = applied.stateAfter;
      } catch (e) {
        // 同时涵盖落盘失败和替换后结果待核对的情况。
        return this.outbound(fail(codeOfError(e), e instanceof Error ? e.message : String(e)), roomId, state);
      }
    }

    const after = stateAfter ?? await this.deps.store.snapshot(roomId);

    // 夜间密谋第二批（issue #96/#128）："进入夜间"严格按 nextPhase 的真实枚举判定。
    // 第一批（time.advance + 模块提案）保持原子不变；密谋失败只 warn，不回滚已经推进的时间。
    const enteredNight = opts.advance === true && state.clock.phase !== "night" && phase === "night";
    if (enteredNight) {
      try {
        const plotEvents = await this.runNightPlot(roomId, after, state, actorId);
        events.push(...plotEvents);
      } catch (e) {
        console.warn(`[map.tick] 夜间密谋编排失败（不影响时段推进）：${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const map = await this.buildMapView(after, actorId);
    // 出站脱敏（issue #53 成功 / #58 失败）：apply 的 envelopes 与 moved 摘要都要过
    // 同一层掩码，否则 tick 响应会从 payload/state 里漏出未认识 NPC 真名。
    // 出站再裁一次秘密（PR #147 审阅 P0）：夜间密谋的第二批事件会进 TickResult，
    // plot 的 GM 字段与 NPC 私忆不能随响应体下发给玩家；测试需要原文时直接读 EventLog。
    const visible = projectEventsForPlayer(events, actorId);
    return this.outbound<TickResult>({ ok: true, events: visible, moved: movedSummaries(visible, after), map }, roomId, after);
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
    // 出站脱敏（issue #61）：场景对话台词/失败文本同样可能带未认识 NPC 真名，统一过掩码。
    // 快照前失败（sceneId 不存在）走 maskEarlyFailure：复用按房间缓存的轻量占位表，
    // 避免对已知房间的重复请求每次都回退 store.snapshot 回放整条事件日志（issue #66）。
    if (!sceneRef) return this.maskEarlyFailure(fail("E_SCENE_NOT_FOUND", `场景 ${sceneId} 不存在`), roomId);

    const state = await this.deps.store.snapshot(roomId);
    const actor = actorId ?? playerActorId(state);
    // 只能触发"当前所在地 + 玩家在场"的场景对话，避免从地图远程播放别处剧情
    if (state.room.scene.locId !== sceneId) {
      return this.outbound(fail("E_NOT_ADJACENT", `你不在 ${sceneId}，不能触发该场景对话`), roomId, state);
    }
    if (!state.room.scene.presentIds.includes(actor)) {
      return this.outbound(fail("E_NOT_IN_ROOM", "玩家不在当前场景"), roomId, state);
    }

    const dialogue = sceneRef.scene.dialogues.find((d) => d.id === dialogueId);
    if (!dialogue) return this.outbound(fail("E_DIALOGUE_NOT_FOUND", `场景 ${sceneId} 没有对话 ${dialogueId}`), roomId, state);

    const npc = state.entities[dialogue.npcId];
    if (!npc || npc.kind !== "npc" || !isLive(state, dialogue.npcId)) {
      return this.outbound(fail("E_ENTITY_MISSING", `对话 NPC ${dialogue.npcId} 不在本房间`), roomId, state);
    }
    // 不强制 NPC 与玩家同场景：AI 生成的场景对话可能是"门后的声音/电话/留言"，
    // 强校验会让生成内容几乎永远不可用；玩家必须在场这一点已在上面校验。
    const placeholders = unknownPlaceholders(state, this.deps.appearance);

    const spec: DialogueSpec = {
      roomId,
      participants: [npc.id],
      directorId: "npc.scene",
      seed: {
        sceneId,
        dialogueId,
        npcId: npc.id,
        npcName: displayNameOf(npc, placeholders),
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
      // 还不认识（不知道名字）：先补一句"陌生人"开场，NPC 不会假装熟络，
      // 而是问怎么称呼；玩家随后在对话流里自述名字，由 introduce 模块落 knows_name 与记忆。
      const opener = knowsNameOf(npc) ? [] : [`（他看了你一眼，显然不认识你）「同学，你是？怎么称呼？」`];
      // 成功返回整包过 outbound：seed 台词里的未认识真名换成占位名，已认识名原样保留；
      // 传入已有 state 快照，省一次事件日志回放。
      return this.outbound<DialogueResult>(
        { ok: true, npc: { id: npc.id, name: displayNameOf(npc, placeholders) }, lines: [...opener, ...lines], sessionId: session.id },
        roomId,
        state,
      );
    } catch (e) {
      return this.outbound(fail(codeOfError(e), e instanceof Error ? e.message : String(e)), roomId, state);
    }
  }

  // -------------------------------------------------------------- 内部：组装 MapView
  private async buildMapView(state: WorldState, actorId: string): Promise<MapView> {
    const { world, published, refs } = await this.content.sceneRefs();
    const npcLoc = npcLocations(state);
    const placeholders = unknownPlaceholders(state, this.deps.appearance);
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
        return { id: e.id, name: displayNameOf(e, placeholders), locId, ...base };
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
  /**
   * 夜间密谋编排：取在场且存活的 NPC ≥2 人，开 npc.plot 会话跑完，汇总提案后
   * 以 cause.type=dialogue 单独交给 Arbiter（不是第一批 time.advance 批）。
   *
   * fail-soft 由 tick() 的调用点兜底：这里抛出的任何错误（open/step/close/apply）
   * 都只写 warn 日志，tick 仍返回 ok:true 且世界状态保持第一批提交后的结果。
   */
  private async runNightPlot(roomId: string, after: WorldState, before: WorldState, actorId: string): Promise<Envelope[]> {
    // 以入夜时的在场者为准：第一批 map 模块提案会把 NPC 按日程挪去宿舍，
    // 若用应用后的快照取人，房间很快不足 2 人，密谋永远不会被触发。
    const liveNpcIds = (s: WorldState) => s.room.scene.presentIds.filter(
      (id) => id !== actorId && isLive(s, id) && s.entities[id]?.kind === "npc",
    );
    const beforeIds = liveNpcIds(before);
    const participants = beforeIds.length >= 2 ? beforeIds : liveNpcIds(after);
    if (participants.length < 2) return [];

    // 配额收口（PR #147 审阅 P1-3）：引擎同时最多 6 条 active plot，满额时整批会被拒，
    // 私忆随整批回滚、LLM 白调。这里先把"往夜留下的" oldest active 结案腾位；
    // 全是本夜新建的就不调导演、不浪费一次生成（下一夜自然会结案）。
    const closable = this.closablePlots(after);
    if (closable === undefined) {
      console.warn(`[map.tick] active plot 已达上限且无可结案，跳过本夜密谋：${roomId}`);
      return [];
    }

    const session = await this.deps.dialogue.open({
      roomId,
      participants,
      directorId: "npc.plot",
      seed: { locId: before.room.scene.locId },
      maxTurns: 3,
      visibility: "private",
    });
    const proposals: Proposal[] = [];
    let step: DialogueStep;
    do {
      step = await this.deps.dialogue.step(session.id);
      proposals.push(...step.proposals);
    } while (!step.done);
    const summary = await this.deps.dialogue.close(session.id, "night.tick");
    // close() 返回的是同一会话累积的提案；用它就够了（step 循环里只负责推进到 done）。
    const plotProposals = summary.proposals.length > 0 ? summary.proposals : proposals;
    if (plotProposals.length === 0 && closable.length === 0) return [];

    // cause.seq 恒 0 会让私忆 id（mem_<room>_<cause.seq>_<n>）跨夜碰撞，第二夜起被幂等丢弃
    // （PR #147 审阅 P1-1）：用"本批将要落库的下一个 seq"做前缀，夜与夜之间必然不同。
    const seqBefore = this.seqOf(roomId);
    const cause = this.cause(roomId, "dialogue", (seqBefore ?? 0) + 1);
    const applied = await this.deps.arbiter.apply(roomId, [...closable, ...plotProposals], cause, {
      captureState: true,
      ...(seqBefore !== undefined ? { expectedSeq: seqBefore } : {}),
    });
    if (!applied.ok || applied.rejected.length > 0) {
      const first = applied.rejected[0];
      console.warn(`[map.tick] 夜间密谋提案被拒：${first?.detail ?? applied.error?.message ?? "unknown"}`);
      return [];
    }
    // 夜间私忆也要进记忆索引，否则默认 v2 群聊召回要等到 v1 回合/重启才看得到（P1-2）。
    for (const ev of applied.events) this.deps.memory?.ingest?.(ev);
    return applied.events;
  }

  /**
   * 需要腾位时返回"结案提案"，不需要返回空数组，连腾位都做不到返回 undefined。
   * 只结案往夜（createdDay < 今天）的 active plot：本夜刚起的剧情不在同一夜被自己关掉。
   */
  private closablePlots(state: WorldState): Proposal[] | undefined {
    const active = state.plots.filter((p) => p.status === "active");
    const over = active.length - (DEFAULT_LIMITS.plots - 1);
    if (over <= 0) return [];
    const olds = active
      .filter((p) => (p.createdDay ?? 0) < state.clock.day)
      .sort((a, b) => (a.createdDay ?? 0) - (b.createdDay ?? 0) || (a.id < b.id ? -1 : 1));
    if (olds.length < over) return undefined;
    return olds.slice(0, over).map((plot) => ({
      op: "plot.upsert",
      reason: "夜间密谋配额收口：往夜剧情结案",
      by: "tick",
      args: {
        id: plot.id,
        goal: plot.goal,
        actors: plot.actors,
        status: "resolved",
        ...(plot.leverage ? { leverage: plot.leverage } : {}),
        ...(plot.risk !== undefined ? { risk: plot.risk } : {}),
        ...(plot.tone ? { tone: plot.tone } : {}),
        ...(plot.leakPoints ? { leakPoints: plot.leakPoints } : {}),
        ...(plot.forbidReveal ? { forbidReveal: plot.forbidReveal } : {}),
        ...(plot.guard ? { guard: plot.guard } : {}),
      },
    }));
  }

  /** Store 契约只保证回放 API；FileStore/EventSourcedStore 额外提供 seq()，测试替身可能没有 */
  private seqOf(roomId: string): number | undefined {
    const store = this.deps.store as Store & { seq?: (roomId: string) => number };
    return typeof store.seq === "function" ? store.seq(roomId) : undefined;
  }

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

  private cause(roomId: string, type: string, seq = 0): Envelope {
    return {
      v: 1,
      id: `evt_map_${type}_${hex8()}`,
      roomId,
      // 真实 seq 由 Arbiter 按 store 分配；cause.seq 只用于标 room/type/actor，
      // 以及 memory.write 派生 id 的唯一性（P1-1 夜间私忆跨夜碰撞）。
      seq,
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
