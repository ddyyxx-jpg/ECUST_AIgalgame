/**
 * 群聊会话宿主（dev/v2）：与 v1 DialogueHost 并列的新入口，不改 v1 任何签名。
 * 只做会话生命周期、幂等、落盘重试与房间级串行化；单轮结算在 conversation.step.ts。
 * 世界状态的所有变更仍只有一条路（I1）；本文件不碰 store.append、不碰文件。
 */
import type {
  ApplyResult,
  ConversationEvent,
  ConversationSessionV2,
  ConversationSpecV2,
  ConversationTurnInput,
  ConversationTurnV2,
  Id,
  RoomId,
  UtteranceModeDef,
  ConversationPolicy,
  Registry,
  Delivery,
} from "../../../shared/src/index.ts";
import type { EventLog } from "../store.ts";
import type { DefaultArbiter } from "../arbiter.ts";
import type { EventSourcedMemory } from "../memory.ts";
import { conversationSnapshotSchema, type ConversationSnapshot, type RestoreResult } from "./conversation-snapshot.ts";
import type { SceneManager } from "./scene.ts";
import type { NpcAgent } from "./npc-agent.ts";
import type { ConversationAudit } from "./audit.ts";
import { StoreFlushError, rememberRecent, runStep, type StoreRetry } from "./conversation.step.ts";

export interface ConversationDeps {
  store: EventLog;
  arbiter: DefaultArbiter;
  registry: Registry;
  memory: EventSourcedMemory;
  modes: Map<string, UtteranceModeDef>;
  policy: ConversationPolicy;
  scene: SceneManager;
  npc: NpcAgent;
  audit: ConversationAudit;
  /** dev/v2 可选：与 GossipHost 共用的发言/调用预算 */
  budget?: import("./talk-budget.ts").TalkBudget;
  wakeOnMultiTarget?: boolean;
  wakeOnLocationChange?: boolean;
  now?: () => number;
}

interface PendingFlush {
  roomId: RoomId;
  s: ConversationSessionV2;
  applied: ApplyResult;
  out: ConversationEvent[];
  /** 本轮已审核的投递；只有重放提交成功才进入下一轮上下文 */
  fresh: Delivery[];
  /** 仅 arbiter 写盘失败时存在：提案从未落库，要用同一 cause/expectedSeq 重新裁决 */
  retry?: StoreRetry;
  /** flush 失败前的 lastLocId；仅当期间未被别的回合推进时才用当前快照前移 */
  beforeLocId?: string;
}

const MAX_SEEN = 256;
const MAX_SESSIONS = 256;
const MAX_PENDING = 256;

export class ConversationHostV2 implements ConversationTurnV2 {
  private readonly sessions = new Map<Id, ConversationSessionV2>();
  private readonly seen = new Map<string, ConversationEvent[]>();
  private readonly pendingFlush = new Map<string, PendingFlush>();
  /** 房间级串行：LLM 等待期间不能让第二个 run 用同一份 seq 提交（PR#51 二审 F） */
  private readonly chains = new Map<RoomId, Promise<void>>();
  private nextId = 0;

  constructor(private readonly deps: ConversationDeps) {}

  /** 仅用于测试/观测：缓存条数（全部有界） */
  get idempotencySize(): number {
    return this.seen.size;
  }

  async open(spec: ConversationSpecV2): Promise<ConversationSessionV2> {
    const state = await this.deps.store.snapshot(spec.roomId);
    const locId = state.room.scene.locId;
    const session: ConversationSessionV2 = {
      id: `conv_${++this.nextId}`,
      roomId: spec.roomId,
      participants: [...spec.participants],
      phase: "speaking",
      turn: 0,
      maxTurns: spec.maxTurns ?? this.deps.policy.maxTurns,
      status: "open",
      queue: [],
      injected: [],
      sceneBeats: [],
      lastLocId: locId,
      npcSpeechStreak: 0,
      visibility: spec.visibility ?? "scene",
    };
    this.sessions.set(session.id, session);
    this.trimSessions();
    session.sceneBeats.push(
      await this.deps.scene.open(session.id, spec.roomId, locId ? state.entities[locId]?.name : undefined, spec.participants, locId),
    );
    return session;
  }

  get(sessionId: Id): ConversationSessionV2 | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * #104：主动关闭会话（路由层淘汰 room→sessionId 映射时调用）。
   * 标记 closed 并回收该会话的幂等缓存；pendingFlush 代表尚未落盘的提交，保留以免丢数据。
   */
  close(sessionId: Id): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.status = "closed";
    for (const [key, events] of this.seen) {
      if (events.some((e) => "sessionId" in e && e.sessionId === sessionId)) this.seen.delete(key);
    }
    return true;
  }

  /** 重启后"继续同房间群聊"：取该房间最后一个仍 open 的会话 */
  getByRoom(roomId: RoomId): ConversationSessionV2 | undefined {
    let found: ConversationSessionV2 | undefined;
    for (const s of this.sessions.values()) if (s.roomId === roomId && s.status === "open") found = s;
    return found;
  }

  /** 导出会话快照（深拷贝，不写文件；落盘由调用方负责，见 conversation-snapshot.ts） */
  exportSessions(roomId?: RoomId): ConversationSnapshot {
    const sessions = [...this.sessions.values()]
      .filter((s) => !roomId || s.roomId === roomId)
      .map((s) => structuredClone(s));
    const ids = new Set(sessions.map((s) => s.id));
    // #123 P1-1：把本房会话的幂等缓存一并导出；重启后同 key 才能原样重放而不重新结算。
    const idempotency = [...this.seen.entries()]
      .filter(([key]) => {
        try {
          const [sid] = JSON.parse(key) as [string];
          return ids.has(sid);
        } catch {
          return false;
        }
      })
      .slice(-MAX_SEEN)
      .map(([key, events]) => ({ key, events: structuredClone(events) as unknown[] }));
    return {
      version: 1, savedAt: this.deps.now?.() ?? Date.now(), sessions,
      ...(idempotency.length > 0 ? { idempotency } : {}),
    };
  }

  /**
   * 导入快照（重启恢复）。坏档/版本不符 → 降级：当前会话全部 closed，调用方须 open() 新会话。
   * 同 id 已存在则跳过（重复导入幂等）；turn 达上限的会话强制 closed。
   * #106：显式校验快照里的 session.roomId 与当前房间一致——不一致直接跳过并计入 degraded，
   * 防止把别的房间的会话挂进当前 host（若 snapshot 文件被串房间写入时 fail-closed）。
   */
  restoreSessions(raw: unknown, roomId?: RoomId): RestoreResult {
    const parsed = conversationSnapshotSchema.safeParse(raw);
    if (!parsed.success) {
      // #123 P1-5：坏快照只降级它影响的房间，不能把所有房间的会话一起关掉。
      for (const s of [...this.sessions.values()]) {
        if (!roomId || s.roomId === roomId) s.status = "closed";
      }
      return { restored: 0, degraded: true, sessions: [] };
    }
    const restored: string[] = [];
    let mismatched = false;
    for (const s of parsed.data.sessions) {
      // 显式校验：传入 roomId 时，会话的 roomId 必须与之完全一致，否则视为错档（#106）
      if (roomId && s.roomId !== roomId) { mismatched = true; continue; }
      if (this.sessions.has(s.id)) continue;
      if (s.turn >= s.maxTurns) s.status = "closed";
      this.sessions.set(s.id, s);
      const n = Number(s.id.replace(/^conv_/, ""));
      if (Number.isFinite(n) && n > this.nextId) this.nextId = n;
      restored.push(s.id);
    }
    // 只要出现 roomId 不一致的会话就降级：调用方应告警/重新加载正确快照（不静默吞掉）
    // #123 P1-1：幂等缓存随快照恢复；只恢复仍 open、且属于本房间的条目。
    for (const entry of parsed.data.idempotency ?? []) {
      try {
        const [sid] = JSON.parse(entry.key) as [string];
        const s = this.sessions.get(sid);
        if (!s || s.status === "closed") continue;
        if (roomId && s.roomId !== roomId) continue;
        this.seen.set(entry.key, entry.events as ConversationEvent[]);
      } catch {
        // 坏 key 跳过：缓存是加速/幂等投影，单条坏了不影响会话本体
      }
    }
    this.trim(this.seen, MAX_SEEN);
    return { restored: restored.length, degraded: mismatched, sessions: restored };
  }

  /** 插话超时恢复；返回被恢复的会话 id（保留旧签名供 server tick 使用） */
  resumeExpired(now = this.deps.now?.() ?? Date.now()): Id[] {
    return this.resumeExpiredEvents(now).flatMap((e) => (e.type === "conversation.phase" ? [e.sessionId] : []));
  }

  /**
   * 与 resumeExpired 同源，但带回可下发给前端的 phase 事件。
   * ④ 带 sessionId 时只恢复该会话：全局 tick 仍可扫全部，但某会话的回合流不能混入别人的超时事件。
   */
  resumeExpiredEvents(now = this.deps.now?.() ?? Date.now(), sessionId?: Id): ConversationEvent[] {
    const out: ConversationEvent[] = [];
    for (const s of this.sessions.values()) {
      if (sessionId !== undefined && s.id !== sessionId) continue;
      if (s.phase === "listening" && s.listenSince !== undefined && now - s.listenSince >= this.deps.policy.listenTimeoutMs) {
        s.phase = "speaking";
        s.listenSince = undefined;
        out.push({ type: "conversation.phase", sessionId: s.id, phase: "speaking" });
      }
    }
    return out;
  }

  async *run(sessionId: Id, input: ConversationTurnInput): AsyncIterable<ConversationEvent> {
    const roomId = this.sessions.get(sessionId)?.roomId ?? "";
    const events = await this.exclusive(roomId, () => this.runInner(sessionId, input));
    for (const ev of events) yield ev;
  }

  private exclusive<T>(roomId: RoomId, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(roomId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.then(() => undefined, () => undefined);
    this.chains.set(roomId, tail);
    void tail.finally(() => {
      if (this.chains.get(roomId) === tail) this.chains.delete(roomId);
    });
    return next;
  }

  private async runInner(sessionId: Id, input: ConversationTurnInput): Promise<ConversationEvent[]> {
    const actorId = input.utterance?.speaker ?? input.interject ?? "sys";
    const key = JSON.stringify([sessionId, actorId, input.clientTurnId]);
    const cached = this.seen.get(key);
    if (cached) return [...cached];

    const s = this.sessions.get(sessionId);
    if (!s || s.status === "closed") {
      return [{ type: "conversation.error", sessionId, code: "E_DIALOGUE_NOT_FOUND", message: this.deps.policy.messages.sessionNotFound }];
    }
    // 放在幂等命中与会话校验之后：重放旧回合不应清空另一个 host 正在用的波次预算
    this.deps.budget?.beginTick(s.roomId);

    // 落盘重试：flush 失败时只重试 flush；arbiter 写盘失败时提案从未落库，用同一 cause 重新裁决
    const pending = this.pendingFlush.get(key);
    if (pending) {
      let applied = pending.applied;
      if (pending.retry) {
        applied = await this.deps.arbiter.apply(pending.roomId, pending.retry.ops, pending.retry.cause, { expectedSeq: pending.retry.expectedSeq });
        if (!applied.ok) {
          const retryable = applied.error?.code === "E_STORE_FAULT";
          if (!retryable) this.pendingFlush.delete(key);
          return [{
            type: "conversation.error", sessionId,
            code: applied.error?.code ?? "E_STORE_FAULT",
            message: applied.error?.message ?? this.deps.policy.messages.storeUnavailable,
            retryable,
          }];
        }
        for (const ev of applied.events) this.deps.memory.ingest(ev);
      }
      try {
        await this.deps.store.flush(pending.roomId);
      } catch {
        return [{ type: "conversation.error", sessionId, code: "E_STORE_FAULT", message: this.deps.policy.messages.storeUnavailable, retryable: true }];
      }
      // 用当前快照而非失败当时的快照：若期间别的回合已推进地点，不回写旧值
      if (pending.beforeLocId !== undefined && pending.s.lastLocId === pending.beforeLocId) {
        pending.s.lastLocId = (await this.deps.store.snapshot(pending.roomId)).room.scene.locId;
      }
      const done = await this.commitWithState(pending.s, applied);
      const all = [...pending.out, done];
      rememberRecent(pending.s, pending.fresh);
      this.remember(key, all);
      this.pendingFlush.delete(key);
      return all;
    }

    const now = this.deps.now?.() ?? Date.now();
    // ④ 只把本会话到期的 phase 事件塞进本回合返回流
    const out: ConversationEvent[] = [...this.resumeExpiredEvents(now, sessionId)];
    try {
      await runStep(this.deps, s, input, out, now, (ss, a) => this.commitWithState(ss, a));
    } catch (e) {
      if (e instanceof StoreFlushError) {
        // 先冻结 out 再追加错误，重试时才不会重复 yield 上一轮的 E_STORE_FAULT
        this.pendingFlush.set(key, {
          roomId: e.roomId, s, applied: e.applied, out: [...out], fresh: e.fresh,
          beforeLocId: s.lastLocId, retry: e.retry,
        });
        this.trim(this.pendingFlush, MAX_PENDING);
        // ③ 外部事件只在提交成功后发布：失败时只回可重试错误
        out.length = 0;
        out.push({ type: "conversation.error", sessionId, code: "E_STORE_FAULT", message: e.message, retryable: true });
      } else {
        out.push({
          type: "conversation.error",
          sessionId,
          code: "E_MODULE_FAULT",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (!out.some((e) => e.type === "conversation.error" && e.retryable)) this.remember(key, out);
    return out;
  }

  private trim<T>(map: Map<string, T>, max: number): void {
    while (map.size > max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) return;
      map.delete(oldest);
    }
  }

  /** 会话淘汰不能踢掉仍有 pendingFlush 的会话（三审 P3-⑤） */
  private trimSessions(): void {
    while (this.sessions.size > MAX_SESSIONS) {
      const pendingIds = new Set([...this.pendingFlush.values()].map((p) => p.s.id));
      const all = [...this.sessions.values()];
      const victim = all.find((ss) => ss.status === "closed" && !pendingIds.has(ss.id))
        ?? all.find((ss) => !pendingIds.has(ss.id));
      if (!victim) return; // 全部都有 pendingFlush，宁可暂时超限也不能丢待重试会话
      this.sessions.delete(victim.id);
    }
  }

  private remember(key: string, events: ConversationEvent[]): void {
    this.seen.set(key, events);
    this.trim(this.seen, MAX_SEEN);
  }

  private async commitWithState(s: ConversationSessionV2, applied: ApplyResult): Promise<ConversationEvent> {
    const turn = ++s.turn;
    if (turn >= s.maxTurns) s.status = "closed";
    return {
      type: "conversation.committed",
      sessionId: s.id,
      turn,
      proposals: applied.applied,
      state: await this.deps.store.snapshot(s.roomId),
    };
  }
}
