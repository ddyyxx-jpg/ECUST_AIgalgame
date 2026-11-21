/**
 * 单轮群聊结算（dev/v2）：从宿主拆出，保持 conversation.ts 在 300 行以内。
 * 这里只做编排：投递 → 并行 NPC 决策 → 审核 → 一次性 Proposal；不直接写状态。
 * 每个私有步骤都控制在 50 行以内（AGENTS.md §6）；runStep 只保留顺序。
 */
import { expectAttrsFor } from "../attr-expect.ts";
import { isRoomSyncFault } from "../store-write.ts";
import type { ArbiterApplyResult } from "../arbiter.ts";
import type {
  ActorId, ConversationEvent, ConversationSessionV2, ConversationTurnInput,
  Delivery, Envelope, Id, MemoryHit, NpcOutcome, Proposal, Utterance, WorldState,
} from "../../../shared/src/index.ts";
import { deliver, validateUtterance } from "./delivery.ts";
import { shouldWake, type SceneManager } from "./scene.ts";
import { fitMemoryContent, mentalFields, mentalProposal, memoryProposals, publicSceneText, utteranceFields } from "./conversation.helpers.ts";
import type { ConversationDeps } from "./conversation.ts";
import { formatDeliveryFor, type HistoryLine, type NpcDecisionResult, type PresentActor } from "./npc-agent.ts";
import type { TalkChannel } from "./talk-budget.ts";

/** 重放一次落盘失败所需的全部输入；宿主重试时用同一 cause + expectedSeq 重新裁决 */
export interface StoreRetry {
  ops: Proposal[];
  cause: Envelope;
  expectedSeq: number;
}

export class StoreFlushError extends Error {
  constructor(
    readonly roomId: string,
    readonly applied: ArbiterApplyResult,
    message = "store.flush failed",
    readonly retry?: StoreRetry,
    readonly fresh: Delivery[] = [],
    readonly outcomes: NpcOutcome[] = [],
  ) {
    super(message);
  }
}

const CHANNEL: TalkChannel = "scene";
/** 每轮上下文只保留最近 K 轮（#131：全局 64 条 → 每位接收者最近 K 轮） */
const MAX_RECENT_ROUNDS = 6;
/** 更早对话的硬字符上限：超出丢最旧的行，避免一个话痨挤爆上下文 */
const HISTORY_MAX_CHARS = 1800;

interface Round {
  turn: number;
  deliveries: Delivery[];
}

/**
 * ① 每个会话记住"已经成功提交的投递"，给下轮 NPC 做上下文。
 * Delivery 自带逐接收方 channels，原文里没有的通道不会出现在这里，可见性天然保持。
 * 用 WeakMap 挂 session：会话被宿主淘汰时条目自动回收，不污染冻结契约。
 */
const recentBySession = new WeakMap<ConversationSessionV2, Round[]>();

export function rememberRecent(s: ConversationSessionV2, turn: number, fresh: readonly Delivery[]): void {
  if (!fresh.length) return;
  const rounds = [...(recentBySession.get(s) ?? []), { turn, deliveries: [...fresh] }];
  recentBySession.set(s, rounds.slice(-MAX_RECENT_ROUNDS));
}

export function __resetRecentForTest(s: ConversationSessionV2): void {
  recentBySession.delete(s);
}

type CommitFn = (s: ConversationSessionV2, applied: ArbiterApplyResult, outcomes: NpcOutcome[]) => Promise<ConversationEvent>;
type NpcResult = NpcDecisionResult & { npcId: ActorId };
type PlayerResult =
  | { aborted: true }
  | { aborted: false; utterance?: Utterance; deliveries: ConversationEvent[] };

interface StepCtx {
  deps: ConversationDeps;
  s: ConversationSessionV2;
  input: ConversationTurnInput;
  out: ConversationEvent[];
  now: number;
  state: WorldState;
  present: readonly ActorId[];
  actors: readonly PresentActor[];
  nameOf: (id: ActorId) => string;
  kindOf: (id: ActorId) => string | undefined;
  playerId?: ActorId;
  seq: number;
  commit: CommitFn;
  proposals: Proposal[];
  /** 本轮通过审核的投递，提交成功后才写入 recentBySession */
  fresh: Delivery[];
  outcomes: NpcOutcome[];
}

/** 统一 turn 口径：day*100+tick（#135；写入侧同口径，老存档在 memory 里归一） */
export function turnNow(state: WorldState): number {
  return (state.clock.day ?? 0) * 100 + (state.clock.tick ?? 0);
}

function targetsOf(u: Utterance | undefined): ActorId[] {
  const t = u?.target;
  if (!t || t === "all") return [];
  return Array.isArray(t) ? [...t] : [t];
}

/** ① 插话：切 phase；若同一请求带了台词，就继续走玩家发言流程（#136 不再丢这句话） */
function interject(ctx: StepCtx): boolean {
  const { s, input, out, now, present, kindOf } = ctx;
  if (!input.interject) return false;
  // 插话对象必须是在场 NPC：不能拿任意 id 把会话切进 listening（#136）
  if (!present.includes(input.interject) || kindOf(input.interject) !== "npc") {
    out.push({ type: "conversation.error", sessionId: s.id, code: "E_REF_NOT_FOUND", message: "interject target is not a present NPC" });
    return true;
  }
  s.phase = "listening";
  s.listenSince = now;
  out.push({ type: "conversation.phase", sessionId: s.id, phase: "listening" });
  // 同一请求带了台词就继续走玩家发言流程，不扔这句话（#136）
  return !input.utterance;
}

/** ② 玩家发言：校验 + 审核必须在投递之前，坏话绝不能被别人看见 */
async function playerStep(ctx: StepCtx): Promise<PlayerResult> {
  const { deps, s, input, out, present, nameOf, state, seq } = ctx;
  const raw = input.utterance;
  if (!raw) return { aborted: false, deliveries: [] };
  const v = validateUtterance(raw, deps.modes, deps.policy, present);
  if (!v.ok || !v.value) {
    out.push({
      type: "conversation.error", sessionId: s.id,
      code: v.code ?? "E_SCHEMA_INVALID", message: v.message ?? deps.policy.messages.invalidUtterance,
    });
    return { aborted: true };
  }
  const utterance = v.value;
  const review = await deps.audit.review({
    roomId: s.roomId, actorId: utterance.speaker,
    playerInput: utterance.content ?? utterance.action ?? "", fields: utteranceFields(utterance),
  });
  if (review.kind === "blocked") {
    const p = await deps.audit.punishPlayer({
      roomId: s.roomId, actorId: utterance.speaker, clientTurnId: input.clientTurnId,
      verdict: review.verdict, state, seq,
    });
    out.push({ type: "conversation.notice", text: p.text, facts: p.facts });
    return { aborted: true };
  }
  if (review.kind === "unavailable") {
    out.push({ type: "conversation.error", sessionId: s.id, code: "E_CONTENT_BLOCKED", message: deps.policy.messages.auditUnavailable });
    return { aborted: true };
  }
  const deliveries: ConversationEvent[] = deliver(utterance, { recipients: present, modes: deps.modes, noticeFor: nameOf, nameOf })
    .map((d) => ({ type: "conversation.utterance" as const, delivery: d }));
  return { aborted: false, utterance, deliveries };
}

/** ③ 换地点/多目标唤醒；返回场景事件，顺序由 order 决定 */
async function wakeStep(ctx: StepCtx, utterance: Utterance | undefined, deliveries: ConversationEvent[]): Promise<ConversationEvent[]> {
  const { deps, s, state } = ctx;
  const locationChanged = !!s.lastLocId && s.lastLocId !== state.room.scene.locId;
  const currentLocId = state.room.scene.locId;
  const loc = locationChanged
    ? { ...(currentLocId ? { locId: currentLocId } : {}), ...(currentLocId && state.entities[currentLocId]?.name ? { locName: state.entities[currentLocId]!.name } : {}) }
    : (deps.scene.location(s.id) ?? { locId: currentLocId });
  const wake = shouldWake({
    utterance, locationChanged,
    wakeOnMultiTarget: deps.wakeOnMultiTarget ?? deps.policy.wakeOnMultiTarget,
    wakeOnLocationChange: deps.wakeOnLocationChange ?? deps.policy.wakeOnLocationChange,
  });
  if (!wake) return [];
  // 共享场景总结只读 public 通道：悄悄话/暗号的正文不进 SceneAgent 的 recent
  const received = deliveries.flatMap((e) => (e.type === "conversation.utterance" ? [e.delivery] : []));
  const recent = publicSceneText(received, deps.modes);
  const beat = await deps.scene.wake(s.id, s.roomId, wake, recent, loc);
  s.sceneBeats.push(beat);
  return [{ type: "conversation.scene", beat }];
}

/** ④ 玩家记忆草稿 + 连续 NPC 发言计数 */
function playerMemory(ctx: StepCtx, utterance?: Utterance): void {
  const { s, deps, playerId } = ctx;
  if (utterance) {
    ctx.proposals.push(...memoryProposals(utterance, s.roomId, deps.modes));
    s.npcSpeechStreak = 0;
    s.autoRounds = 0;
    s.listenSince = undefined;
  } else if (playerId) {
    s.npcSpeechStreak += 1;
  }
}

/** 更早对话：按接收者过滤 + 丢最旧行到字符上限（#131） */
function historyFor(ctx: StepCtx, npcId: ActorId): HistoryLine[] {
  const rounds = recentBySession.get(ctx.s) ?? [];
  const lines: HistoryLine[] = [];
  for (const r of rounds) {
    for (const d of r.deliveries) {
      if (d.to !== npcId) continue;
      lines.push({ turn: r.turn, text: formatDeliveryFor(npcId, ctx.actors, d) });
    }
  }
  let total = 0;
  const kept: HistoryLine[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    total += line.text.length;
    if (total > HISTORY_MAX_CHARS) break;
    kept.unshift(line);
  }
  return kept;
}

/** 候选排序 + 准入（#133）：点名目标优先 → 最近没说过的人优先；每波调用上限按人数截断 */
function planCalls(ctx: StepCtx, utterance?: Utterance): { npcId: ActorId; allowSpeak: boolean }[] {
  const { deps, s, present, kindOf, playerId } = ctx;
  const autonomous = deps.policy.autonomousWhenPlayerAbsent || !!playerId || !!ctx.input.auto;
  if (!autonomous) return [];
  const named = new Set(targetsOf(utterance));
  const npcs = present.filter((id) => kindOf(id) === "npc" && id !== utterance?.speaker);
  const rank = (id: ActorId): number => {
    if (named.has(id)) return -1;
    return deps.budget?.lastSentAt(s.roomId, id, CHANNEL) ?? 0;
  };
  const ordered = [...npcs].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const planned: { npcId: ActorId; allowSpeak: boolean }[] = [];
  for (const npcId of ordered) {
    if (!deps.budget) {
      planned.push({ npcId, allowSpeak: true });
      continue;
    }
    const call = deps.budget.mayCall(s.roomId, npcId, CHANNEL);
    if (call !== "ok") {
      ctx.outcomes.push({ npcId, kind: "silent", reason: call });
      continue;
    }
    const speak = deps.budget.canSpeak(s.roomId, npcId, CHANNEL, ctx.now, { ignoreMinInterval: named.has(npcId) });
    if (speak !== "ok") {
      ctx.outcomes.push({ npcId, kind: "silent", reason: speak });
      continue;
    }
    deps.budget.recordCall(s.roomId, npcId, CHANNEL);
    planned.push({ npcId, allowSpeak: true });
  }
  return planned;
}

const MEMORY_LINES_MAX = 5;

/**
 * 记忆注入行（#135）：最近 1–2 条自己的话固定占位，不参与打分排序，
 * 避免「当天刚说的话」被 5 条高分旧记忆挤出窗口（P1-c）。
 */
/** 最近 1–2 条自己的台词（来自本会话已发生的投递；同日 tick 恒 0 时比 maxTurn 可靠） */
export function ownSpeechLines(rounds: readonly Round[], npcId: ActorId): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rounds) {
    for (const d of r.deliveries) {
      if (d.speaker !== npcId) continue;
      // 与 memoryProposals 同一拼法（content + " (action)"）+ 同一 500 字截断，
      // 否则 >500 字符时召回行被截成前缀、自己这行是全文，去重失效、同一句占两行（#146）
      const text = fitMemoryContent(`${d.content ?? ""}${d.action ? ` (${d.action})` : ""}`.trim());
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(`- [第${Math.floor(r.turn / 100) || 1}天] 你说过：${text}`);
    }
  }
  return out.slice(-2).join("\n");
}

/** 自己的台词固定前置；与记忆召回行按「正文」去重，避免同一句出现两次 */
export function mergeMemoryText(own: string, recalled: string): string {
  const ownLines = own.split("\n").filter(Boolean);
  // 去掉「- [第N天·地点] 」与可选的「你说过：」前缀再比，避免任一来源缺前缀时去重失效
  const key = (line: string) => line
    .replace(/^-\s*\[[^\]]*\]\s*/, "")
    .replace(/^你说过：/, "")
    .trim();
  const ownKeys = new Set(ownLines.map(key));
  const rest = recalled.split("\n").filter((l) => l && !ownKeys.has(key(l)));
  return [...ownLines, ...rest].slice(0, MEMORY_LINES_MAX + 2).join("\n");
}

export function memoryLinesFor(hits: readonly MemoryHit[], locName?: string): string {
  if (hits.length === 0) return "";
  const maxTurn = hits.reduce((m, h) => Math.max(m, h.record.turn), -1);
  const pinned = hits.filter((h) => h.record.turn === maxTurn).slice(0, 2);
  const rest = hits.filter((h) => !pinned.includes(h));
  return [...pinned, ...rest]
    .slice(0, MEMORY_LINES_MAX)
    .map((h) => {
      const day = Math.floor(h.record.turn / 100) || 1;
      const tag = locName && h.record.tags.includes(locName) ? `·${locName}` : "";
      const mine = h.record.tags.includes("dialogue") ? "你说过：" : "";
      return `- [第${day}天${tag}] ${mine}${h.record.content}`;
    })
    .join("\n");
}

/** ⑤ 每个在场 NPC 各自一次 LLM；玩家不在场时受 autonomousWhenPlayerAbsent 控制 */
async function decideStep(ctx: StepCtx, utterance?: Utterance): Promise<NpcResult[]> {
  const { deps, s, state, nameOf } = ctx;
  const hardCap = !!ctx.playerId && !utterance && !ctx.input.auto && deps.policy.npcHardCap > 0 && s.npcSpeechStreak >= deps.policy.npcHardCap;
  const listening = s.phase === "listening";
  const loc = deps.scene.location(s.id) ?? { locId: state.room.scene.locId };
  const planned = planCalls(ctx, utterance);
  return Promise.all(planned.map(async ({ npcId, allowSpeak }) => {
    const hits = utterance ? deliver(utterance, { recipients: [npcId], modes: deps.modes, noticeFor: nameOf, nameOf }) : [];
    const own = await deps.memory.recall({
      roomId: s.roomId,
      ownerId: npcId,
      budgetTokens: 500,
      nowTurn: turnNow(state),
      ...(loc.locName ? { tags: [loc.locName] } : {}),
      about: [ctx.playerId, utterance?.speaker].filter((x): x is ActorId => typeof x === "string" && x !== ""),
    });
    const memoryText = mergeMemoryText(
      ownSpeechLines(recentBySession.get(s) ?? [], npcId),
      memoryLinesFor(own, loc.locName),
    );
    const r = await deps.npc.decide({
      npcId,
      npcName: nameOf(npcId),
      turnKey: s.turn,
      state,
      deliveries: hits,
      history: historyFor(ctx, npcId),
      sceneText: deps.scene.render(s.id),
      memoryText,
      streak: s.npcSpeechStreak,
      playerPresent: !!ctx.playerId,
      hardCapReached: hardCap || !allowSpeak || listening,
      listening,
      present: ctx.actors,
      loc,
    });
    return { npcId, ...r };
  }));
}

/** ⑥ 扩面审核：不合规只丢这一位；心理活动含 plan */
async function auditStep(ctx: StepCtx, decisions: NpcResult[], utterance?: Utterance): Promise<void> {
  const { deps, s, out, present, nameOf } = ctx;
  for (const d of decisions) {
    const fields = d.decision.kind === "speak" ? utteranceFields(d.decision.utterance)
      : d.decision.kind === "think" ? mentalFields(d.decision.mental) : [];
    if (fields.length === 0) {
      ctx.outcomes.push(outcomeOf(d, "silent"));
      continue;
    }
    const review = await deps.audit.review({ roomId: s.roomId, actorId: d.npcId, playerInput: utterance?.content ?? "", fields });
    if (review.kind !== "ok") {
      // 审核拒绝/不可用要说清楚原因，不能和模型主动沉默混在一起（#132 可观测）
      ctx.outcomes.push({ ...outcomeOf(d, "silent"), reason: review.kind === "blocked" ? "audit_blocked" : "audit_unavailable" });
      continue;
    }
    if (d.decision.kind === "speak") {
      const u = d.decision.utterance;
      const spoken = deliver(u, { recipients: present, modes: deps.modes, noticeFor: nameOf, nameOf });
      // 空 speak（所有通道都没内容）不投、也不占冷却（#133）
      if (spoken.length === 0) {
        ctx.outcomes.push({ ...outcomeOf(d, "silent"), reason: "empty" });
        continue;
      }
      deps.budget?.recordSent(s.roomId, d.npcId, CHANNEL);
      for (const delivery of spoken) out.push({ type: "conversation.utterance", delivery });
      ctx.fresh.push(...spoken);
      ctx.proposals.push(...memoryProposals(u, s.roomId, deps.modes, deps.scene.location(s.id)?.locName));
      ctx.outcomes.push(outcomeOf(d, "speak"));
    } else if (d.decision.kind === "think") {
      out.push({ type: "conversation.mental", actorId: d.npcId, mental: d.decision.mental });
      ctx.proposals.push(mentalProposal(d.npcId, d.decision.mental));
      ctx.outcomes.push(outcomeOf(d, "think"));
    }
  }
}

/** reason 只取受控枚举：模型自由文本可能含私密台词（审阅 P2） */
const OUTCOME_REASONS = new Set([
  "llm_unavailable", "truncated", "format", "empty", "bad_utterance", "bad_mental",
  "phase_or_cap", "no_speech", "E_LLM_FORMAT", "E_LLM_TRUNCATED", "audit_blocked", "audit_unavailable",
  "call-cap", "min-interval", "hour-cap", "listening",
]);
export function sanitizeReason(reason?: string): string | undefined {
  if (!reason) return undefined;
  return OUTCOME_REASONS.has(reason) ? reason : "other";
}

function outcomeOf(d: NpcResult, kind: NpcOutcome["kind"]): NpcOutcome {
  return {
    npcId: d.npcId,
    kind,
    ...(d.reason ? { reason: sanitizeReason(d.reason) } : {}),
    ...(d.finishReason ? { finishReason: d.finishReason } : {}),
    ...(d.latencyMs !== undefined ? { latencyMs: d.latencyMs } : {}),
    ...(d.usage ? { promptTokens: d.usage.promptTokens, completionTokens: d.usage.completionTokens } : {}),
  };
}

/** ⑦ 玩家发言后若 phase=listening，恢复 speaking */
function restorePhase(ctx: StepCtx, utterance?: Utterance, listening = false): void {
  const { s, out } = ctx;
  if (!listening || !utterance) return;
  s.phase = "speaking";
  s.listenSince = undefined;
  out.push({ type: "conversation.phase", sessionId: s.id, phase: "speaking" });
}

/** ⑧ 唯一写入口：整批 Proposal 一次裁决；无提案也发 committed 让对端收口 */
async function commitStep(ctx: StepCtx, utterance?: Utterance): Promise<boolean> {
  const { deps, s, input, out, now, seq } = ctx;
  const { store, arbiter, memory, policy } = deps;
  const cause = {
    v: 1 as const, id: `evt_conv_${input.clientTurnId}`, roomId: s.roomId, seq: seq + 1,
    ts: now, actorId: utterance?.speaker ?? "sys", type: "dialogue.speak" as const, payload: {},
  };
  // lastLocId 只在提交成功后前移，失败时下轮仍能检测换地点（三审 P3-⑥）
  const finish = async (applied: ArbiterApplyResult): Promise<void> => {
    out.push(await ctx.commit(s, applied, ctx.outcomes));
    s.lastLocId = ctx.state.room.scene.locId;
  };
  if (!ctx.proposals.length) {
    await finish({ ok: true, mode: "atomic", seq: seq + 1, stateAfter: ctx.state, applied: [], rejected: [], events: [] });
    return true;
  }
  // #138：提案基于本步开头的 ctx.state 快照算出；交裁决前复核被改动的属性，
  // 若期间被别的提交改过（后台 tick / 另一请求）→ 整批 E_PRECONDITION，不叠加旧值 delta。
  const applied = await arbiter.apply(s.roomId, ctx.proposals, cause, {
    expectedSeq: seq, captureState: true, expectAttrs: expectAttrsFor(ctx.state, ctx.proposals),
  });
  if (!applied.ok) {
    // ③ 写盘失败是暂时故障：必须走 retryable 分支，绝不能进 seen 缓存
    if (applied.error?.code === "E_STORE_FAULT") {
      throw new StoreFlushError(s.roomId, applied, deps.policy.messages.storeFlushFailed, {
        ops: ctx.proposals, cause, expectedSeq: seq,
      }, ctx.fresh, ctx.outcomes);
    }
    out.push({
      type: "conversation.error", sessionId: s.id,
      code: applied.error?.code ?? applied.rejected[0]?.code ?? "E_MODULE_FAULT",
      message: applied.error?.message ?? policy.messages.memoryRejected,
    });
    return false;
  }
  for (const ev of applied.events) memory.ingest(ev); // PR#4 P0-1：写了必须能读到
  try {
    await store.flush(s.roomId);
  } catch (error) {
    if (isRoomSyncFault(error)) throw error;
    throw new StoreFlushError(s.roomId, applied, deps.policy.messages.storeFlushFailed, undefined, ctx.fresh, ctx.outcomes);
  }
  await finish(applied);
  return true;
}

export async function runStep(
  deps: ConversationDeps,
  s: ConversationSessionV2,
  input: ConversationTurnInput,
  out: ConversationEvent[],
  now: number,
  commit: CommitFn,
): Promise<void> {
  const state = await deps.store.snapshot(s.roomId);
  const present = state.room.scene.presentIds ?? [];
  const actors: PresentActor[] = present.map((id) => {
    const e = state.entities[id];
    return {
      id,
      // #131：玩家显示「玩家」，不能露出实体名「你」
      name: e?.kind === "plr" ? "玩家" : (e?.name ?? id),
      kind: e?.kind ?? "unknown",
    };
  });
  const ctx: StepCtx = {
    deps, s, input, out, now, state, present, actors,
    // 审阅 #144：玩家实体名是「你」，投递行/点名通知一律显示「玩家」
    nameOf: (id) => {
      const e = state.entities[id];
      if (!e) return id;
      return e.kind === "plr" ? "玩家" : e.name;
    },
    kindOf: (id) => state.entities[id]?.kind,
    playerId: present.find((id) => state.entities[id]?.kind === "plr"),
    seq: await deps.store.load(s.roomId),
    commit,
    proposals: [],
    fresh: [],
    outcomes: [],
  };
  if (interject(ctx)) return;
  const player = await playerStep(ctx);
  if (player.aborted) return;
  const sceneEvents = await wakeStep(ctx, player.utterance, player.deliveries);
  const first = sceneEvents[0];
  out.push(...(first?.type === "conversation.scene" && first.beat.order === "before"
    ? [...sceneEvents, ...player.deliveries] : [...player.deliveries, ...sceneEvents]));
  playerMemory(ctx, player.utterance);
  ctx.fresh.push(...player.deliveries.flatMap((e) => (e.type === "conversation.utterance" ? [e.delivery] : [])));
  const listening = s.phase === "listening";
  // #136：插话后玩家终于开口——必须先切回 speaking，否则 decideStep 把 hardCapReached
  // 置真，NPC 只能 think/silent，末句当轮没人回应（P1-b）
  restorePhase(ctx, player.utterance, listening);
  const decisions = await decideStep(ctx, player.utterance);
  await auditStep(ctx, decisions, player.utterance);
  if (await commitStep(ctx, player.utterance)) rememberRecent(s, s.turn, ctx.fresh);
}

export type { Id };
