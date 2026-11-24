/**
 * Turn：一个回合的唯一入口。顺序是固定的：
 * accepted → (modules 算数) → (llm 说话，可跳过) → arbiter 裁决 → patch → commit
 *
 * 这里没有任何玩法知识：它不知道"体力"、"图书馆"，只认 op 原语与 Module 契约。
 * 所以加玩法永远不需要改这个文件。
 */
import type {
  ActorId,
  ErrorCode,
  Envelope,
  LlmPort,
  ModuleContext,
  Modules,
  Proposal,
  Registry,
  RoomId,
  Turn,
  TurnEvent,
  TurnRequest,
  Usage,
  WorldState,
} from "../../shared/src/index.ts";
import type { EventLog } from "./store.ts";
import { isRoomSyncFault } from "./store-write.ts";
import type { AuditPolicy, AuditPort } from "./audit.ts";
import { codeOf, errMessage } from "./turn.parse.ts";
import { expectAttrsFor } from "./attr-expect.ts";
import { RETRYABLE } from "../../shared/src/index.ts";
import { buildTurnPrompt } from "./turn.prompt.ts";
import { makeContext } from "./turn.context.ts";
import { TurnLlm } from "./turn.llm.ts";
import type { RealityKind, RealityPolicy } from "./reality.ts";
import { DEFAULT_REALITY, detectReality, filterProposals, realityFraming } from "./reality.ts";
import type { TurnJson } from "./turn.parse.ts";
import { AuditGate } from "./audit.gate.ts";
import { createTurnBudget, type DefaultArbiter } from "./arbiter.ts";
import { evidenceKey, parseCommitEvidence, type TurnCommitEvidence } from "./turn.evidence.ts";
import type { EventSourcedMemory } from "./memory.ts";
import type { MemoryContext } from "./turn.memory.ts";
import { readMemoryContext } from "./turn.memory.ts";
import { buildMemoryPlan } from "./turn.memory.plan.ts";
import type { Impressions } from "./impressions.ts";
import { impressionFact } from "./impressions.ts";

/** 回合后低频 compact（#42）：每 N 个已提交回合触发一次，避免每回合都排序/归档 */
const COMPACT_EVERY = 5;

/**
 * 行动点策略：键名由内容层（content/sim/policy.json）提供，引擎不认具体属性名（I2）。
 * 只在玩家实体已经有这个属性时生效——老存档缺属性不会被凭空拦住。
 */
export interface TurnActionPolicy {
  attrKey: string;
  costPerTurn: number;
}

export interface TurnDeps {
  store: EventLog;
  arbiter: DefaultArbiter;
  registry: Registry;
  modules: Modules;
  memory: EventSourcedMemory;
  llm: LlmPort;
  /**
   * 审核端口：模型叙事在发给玩家之前必须过它。
   * 默认 NoopAudit（放行）—— 线上必须注入真模型实现（apps/server/src/audit.ts）。
   */
  audit?: AuditPort;
  /** 审核策略：分类/阈值/扣分/删档线都在 content/registry/policy.json */
  auditPolicy?: AuditPolicy;
  /**
   * 现实锚定策略：识别"我全知全能"这类诱导性发言并修饰回世界内。
   * 数据在 content/registry/reality.json；不注入时只带基础世界规则、不做类型判定。
   */
  reality?: RealityPolicy;
  /**
   * 世界印象端口：canonize 把这个玩家的事迹写进世界层后，下一回合在 facts 里告诉他"被记住了"。
   * 不注入 = 不投递；投递不调模型、不占叙事文本。
   */
  impressions?: Impressions;
  /** 组装提示词；默认实现见 turn.prompt。**必须**接收并使用第 4 个参数 mem（记忆注入） */
  buildPrompt?: (state: WorldState, actorId: ActorId, input: string, mem?: MemoryContext) => string | Promise<string>;
  /**
   * 房间级提示词补充（作者注 / 关键词触发的世界设定），在组装提示词时按当前状态与输入选取。
   * 只影响"给 LLM 看什么"，不产生状态变更；由 server 的内容加载器实现。
   */
  worldInfo?: (state: WorldState, actorId: ActorId, input: string) => {
    authorNote?: string;
    entries: readonly string[];
  };
  /** 行动点策略；不注入 = 不扣点、不拦截（测试/旧存档兼容） */
  actionPolicy?: TurnActionPolicy;
}

export class DefaultTurn implements Turn {
  private readonly deps: TurnDeps;
  private readonly gate: AuditGate;
  private readonly reality: RealityPolicy;
  private readonly llmStep: TurnLlm;
  /**
   * clientTurnId 幂等缓存：重复提交只重放，不再花一次 LLM 的钱。
   * key 含 roomId/actorId，避免不同房间/不同 actor 用同一个 clientTurnId 时串台（issue #34）。
   * 进程内命中优先；未命中时从 EventLog 的 turn.committed 标记重建（issue #76）。
   */
  private readonly seen = new Map<string, TurnEvent[]>();
  /**
   * 每房间一次的标记扫描（PR #123 P1-4）：缓存 Promise 而不是布尔"已扫描"标志。
   * 并发请求必须 await 同一个扫描，否则后来者会在扫描尚未完成时误判 seen 为空、重复结算；
   * 扫描失败要从表里移除，让下次请求重试，不能让一次瞬时故障永久毒化这个房间。
   */
  private readonly restores = new Map<RoomId, Promise<void>>();
  /** 同 key 并发：后来者等待首个结算完成并重放同一结果，不重复调模型（issue #34） */
  private readonly inFlight = new Map<string, Promise<void>>();
  /** 每房间已提交回合数：只用于低频 compact 限频（进程内计数，重启后重新开始） */
  private readonly committedTurns = new Map<RoomId, number>();

  /**
   * 从 EventLog 重建 seen（#76）：只采信结构合法的 turn.committed 标记。
   * 标记与状态事件同批写入，出现即表示该逻辑回合已真正提交；坏标记跳过。
   */
  private restoreSeen(roomId: RoomId): Promise<void> {
    const pending = this.restores.get(roomId);
    if (pending) return pending;
    const scan = this.scanSeen(roomId);
    const tracked = scan.catch((e: unknown) => {
      // 失败不缓存终态：后续请求必须重新扫描，而不是带着空 seen 继续结算（PR #123 P1-4）
      this.restores.delete(roomId);
      throw e;
    });
    this.restores.set(roomId, tracked);
    return tracked;
  }

  private async scanSeen(roomId: RoomId): Promise<void> {
    for (const env of await this.deps.store.events(roomId, 0)) {
      const evidence = parseCommitEvidence(env);
      if (!evidence) continue;
      const key = evidenceKey(roomId, evidence.actorId, evidence.clientTurnId);
      if (!this.seen.has(key)) {
        // 从最小证据重建用户可见的回合事件序列。turn.patch 不再重放：重启后世界状态
        // 已经折进 snapshot，重复发 patch 只会让前端误以为世界又变了一次。
        const replay: TurnEvent[] = [{ type: "turn.accepted", turnId: evidence.turnId }];
        if (evidence.narrative) replay.push({ type: "turn.delta", field: "narrative", text: evidence.narrative });
        if (evidence.facts && evidence.facts.length > 0) replay.push({ type: "turn.facts", facts: evidence.facts });
        replay.push({
          type: "turn.commit", turnId: evidence.turnId, seq: evidence.committedSeq,
          ...(evidence.usage ? { usage: evidence.usage } : {}),
        });
        this.seen.set(key, replay);
      }
    }
  }

  constructor(deps: TurnDeps) {
    this.deps = deps;
    this.reality = deps.reality ?? DEFAULT_REALITY;
    this.llmStep = new TurnLlm({
      llm: deps.llm,
      reality: this.reality,
      registry: deps.registry,
      ...(deps.buildPrompt ? { buildPrompt: deps.buildPrompt } : {}),
      ...(deps.worldInfo ? { worldInfo: deps.worldInfo } : {}),
    });
    this.gate = new AuditGate({
      arbiter: deps.arbiter,
      store: deps.store,
      registry: deps.registry,
      audit: deps.audit,
      policy: deps.auditPolicy,
    });
  }

  async *run(req: TurnRequest): AsyncIterable<TurnEvent> {
    const key = evidenceKey(req.roomId, req.actorId, req.clientTurnId);
    // 重启后 seen 为空：先从 EventLog 的 turn.committed 标记重建，避免同 ID 再跑一遍（#76）
    await this.restoreSeen(req.roomId);
    const cached = this.seen.get(key);
    if (cached) {
      for (const ev of cached) yield ev;
      return;
    }
    // 同 key 的并发请求等首个结算完成，再重放它的事件（不各自重试、不重复扣钱）
    const waiting = this.inFlight.get(key);
    if (waiting) {
      await waiting;
      const replay = this.seen.get(key);
      if (replay) {
        for (const ev of replay) yield ev;
        return;
      }
    }
    let release!: () => void;
    this.inFlight.set(key, new Promise<void>((resolve) => { release = resolve; }));
    try {
    const events: TurnEvent[] = [];
    const emit = (ev: TurnEvent): TurnEvent => {
      events.push(ev);
      return ev;
    };

    const turnId = `turn_${req.clientTurnId}`;
    // 提交证据：在裁决前构造，replay 取当前已 emit 事件的快照（#76）。
    // 标记与状态事件同批 append；只有真正落盘的那批 apply 会写出它。
    const evidence: TurnCommitEvidence = {
      clientTurnId: req.clientTurnId, turnId, actorId: req.actorId,
      committedSeq: 0, // Arbiter 在 append 时按实际位置改写
    };
    // 先载入再读 seq：文件存储在重启后 seq 是懒加载的（MAJOR-1）
    const seqNow = await this.deps.store.load(req.roomId);

    if (req.options?.expectedSeq !== undefined && req.options.expectedSeq !== seqNow) {
      yield emit({ type: "turn.rejected", code: "E_SEQ_GAP", message: `期望 seq ${req.options.expectedSeq}，实际 ${seqNow}`, retryable: false });
      return;
    }

    // 档案已删：不再接待这个玩家（信誉归零时由审核处置写入）
    const state0 = await this.deps.store.snapshot(req.roomId);
    if (this.gate.purged(state0)) {
      yield emit({ type: "turn.error", code: "E_FORBIDDEN", message: "该玩家档案已因多次严重违规被删除，无法继续游戏。", retryable: false });
      return;
    }

    // 行动点：只对"实体已经有这个属性"的玩家生效（老存档缺属性不拦）；归零必须休息，
    // 休息入口是地图 tick（advance=true），由服务端按同一份策略回满。
    const actionPolicy = this.deps.actionPolicy;
    const actionKey = actionPolicy?.attrKey;
    const actionCost = actionPolicy?.costPerTurn ?? 0;
    const actionNow = actionKey ? state0.entities[req.actorId]?.attrs[actionKey] : undefined;
    const chargeAction = typeof actionNow === "number" && actionCost > 0;
    if (chargeAction && actionNow < actionCost) {
      yield emit({
        type: "turn.error",
        code: "E_PRECONDITION",
        message: `行动点不足（${actionNow}/${actionCost}），请先休息推进时段。`,
        retryable: false,
      });
      return;
    }
    const costOps: Proposal[] = chargeAction && actionKey
      ? [{
        op: "attr.delta",
        args: { entityId: req.actorId, key: actionKey, delta: -actionCost, mustKeep: true },
        reason: "行动消耗",
      }]
      : [];

    yield emit({ type: "turn.accepted", turnId });

    // 记忆与状态同源：先把本房间的事件补进记忆索引（重启后第一次进来也成立），再召回
    this.deps.memory.sync(req.roomId, await this.deps.store.events(req.roomId, 0));
    const mem = await readMemoryContext(this.deps.memory, state0, req);

    const kind = detectReality(this.reality, req.input);
    const cause = this.cause(req, seqNow);
    const causeForBudget = { ...cause, causedBy: turnId };
    // 整回合预算：同一回合的三次 apply（主批 / 去记忆重提 / 修复重提）共享同一份计数，
    // 并把审核处置（gate.punish 内部 apply）也纳入本回合——它只拿到 causeForBudget，靠登记者共享
    const turnBudget = createTurnBudget();
    let usage: Usage | undefined;
    const moduleProposals: Proposal[] = [];
    const llmProposals: Proposal[] = [];
    let memoryProposals: Proposal[] = [];
    let narrative = "";
    let droppedByReality = 0;
    let memoryDropped = 0;
    let memoryRejected = false;

    try {
      const state = state0;
      const ctx = makeContext(this.deps.registry, this.deps.llm, req, state);
      const modOut = await this.deps.modules.dispatchIntent(ctx);
      moduleProposals.push(...modOut.proposals);

      if (!req.options?.skipLLM) {
        const first = await this.llmStep.ask(req, state, kind, mem);
        usage = first.usage;
        evidence.narrative = first.narrative;
        evidence.facts = [];
        evidence.usage = first.usage;
        droppedByReality += first.dropped;
        const gate = await this.gate.review({ roomId: req.roomId, actorId: req.actorId, input: req.input, text: first.text });
        if (gate.kind === "blocked") {
          // P1-3：被拦的首版叙事不能进 marker，否则跨重启重建的历史行会把它读回 /events
          evidence.narrative = undefined;
          evidence.facts = undefined;
          const punishArgs = { roomId: req.roomId, actorId: req.actorId, clientTurnId: req.clientTurnId };
          const punishEvents = await this.gate.punish(punishArgs, causeForBudget, gate.verdict, state, seqNow, evidence);
          for (const ev of punishEvents) emit(ev);
          // P0-B：HTTP 消费器收到 turn.commit 即刻 break；yield 之后的代码不会执行，
          // 幂等键必须在这里（提交已发生、第一个 yield 之前）写好。惩罚没落库时
          // 返回的是 turn.error：不登记，让调用方重试，绝不吞掉一次该罚未罚的处置。
          if (punishEvents.some((ev) => ev.type === "turn.commit")) this.seen.set(key, events);
          for (const ev of punishEvents) yield ev;
          return;
        }
        if (gate.kind === "ok") {
          llmProposals.push(...first.proposals);
          narrative = first.text;
          // 记忆写侧统一流水线（#39）：种子/模型记忆/工作记忆都从这里过闸门。
          // repair 成功后会整份重建，因此这里建的计划在被拒时不会落库（atomic 整批回滚）。
          const memoryPlan = buildMemoryPlan({
            mem,
            state,
            req,
            narrative: first.narrative,
            dialogue: first.dialogue,
            modelDrafts: first.memory,
          });
          memoryProposals = memoryPlan.proposals;
          memoryDropped = memoryPlan.dropped;
        } else {
          // 审核器故障：文本不下发、提案不采信（可能是被诱导的产物），模块提案照旧
          narrative = this.gate.policy.unavailableText;
        }
      }

      // ① 裁决：默认 atomic —— 任何一条被拒，整批不落库。
      // 两阶段兜底：记忆写坏了不该毁掉整回合（玩家行动本身是合法的），去掉记忆重提一次。
      const applyBatch = async (ops: Proposal[], expectedSeq: number) => {
        // #138：提案基于 state0 的属性快照算出；apply 前在房间串行链内复核这些属性，
        // 值变了就整批拒绝（E_PRECONDITION），不把"按旧值算的 delta"叠到新值上。
        let result = await this.deps.arbiter.apply(req.roomId, ops, causeForBudget, {
          expectedSeq, turnBudget, commitEvidence: evidence, captureState: true,
          expectAttrs: expectAttrsFor(state0, ops),
        });
        if (!result.ok && memoryProposals.length > 0 && result.rejected.length > 0) {
          const onlyMemory = result.rejected.every((r) => memoryProposals.includes(r.proposal));
          if (onlyMemory) {
            memoryRejected = true;
            const retryOps = [...costOps, ...moduleProposals, ...llmProposals];
            result = await this.deps.arbiter.apply(req.roomId, retryOps, causeForBudget, {
              expectedSeq, turnBudget, commitEvidence: evidence, captureState: true,
              expectAttrs: expectAttrsFor(state0, retryOps),
            });
          }
        }
        return result;
      };

      let applied = await applyBatch([...costOps, ...moduleProposals, ...llmProposals, ...memoryProposals], seqNow);

      // ② 一次修复：只有"模型给的提案"坏了才值得再问一次；模块的提案坏了属于代码 bug
      let repairError = "";
      if (!applied.ok && applied.rejected.length > 0 && moduleProposals.length === 0) {
        const badLlm = applied.rejected.every((r) => llmProposals.includes(r.proposal));
        if (badLlm) {
          const repaired = await this.llmStep.repair(req, state, applied.rejected, kind, mem);
          if (repaired && !repaired.ok) {
            repairError = repaired.error; // 修复本身失败（网络/格式）：别静默吞掉，写进最终错误
          } else if (repaired) {
            usage = repaired.usage;
            // P1-2：marker 必须记修复版产物。首版叙事/usage 已被 Arbiter 拒绝，
            // 若留在证据里，跨重启重建的历史行会显示被拒版本（PR #123 P1-2）。
            evidence.narrative = repaired.narrative;
            evidence.usage = repaired.usage;
            droppedByReality += repaired.dropped;
            const gate = await this.gate.review({ roomId: req.roomId, actorId: req.actorId, input: req.input, text: repaired.text });
            if (gate.kind === "blocked") {
              evidence.narrative = undefined;
              evidence.facts = undefined;
              const punishArgs = { roomId: req.roomId, actorId: req.actorId, clientTurnId: req.clientTurnId };
              const punishEvents = await this.gate.punish(punishArgs, causeForBudget, gate.verdict, state, this.deps.store.seq(req.roomId), evidence);
              for (const ev of punishEvents) emit(ev);
              // P0-B：与首版阻断同样，必须在消费器 break 的 turn.commit 之前登记幂等键
              if (punishEvents.some((ev) => ev.type === "turn.commit")) this.seen.set(key, events);
              for (const ev of punishEvents) yield ev;
              return;
            }
            narrative = gate.kind === "ok" ? repaired.text : this.gate.policy.unavailableText;
            llmProposals.length = 0;
            // #39：修复成功后必须用**修复版产物**重建整份记忆计划；被拒首版的记忆不落库。
            memoryProposals = [];
            memoryDropped = 0;
            memoryRejected = false;
            if (gate.kind === "ok") {
              llmProposals.push(...repaired.proposals);
              const memoryPlan = buildMemoryPlan({
                mem,
                state,
                req,
                narrative: repaired.narrative,
                dialogue: repaired.dialogue,
                modelDrafts: repaired.memory,
              });
              memoryProposals = memoryPlan.proposals;
              memoryDropped = memoryPlan.dropped;
            }
            applied = await applyBatch(
              [...costOps, ...moduleProposals, ...llmProposals, ...memoryProposals],
              this.deps.store.seq(req.roomId),
            );
          }
        }
      }

      // ②.5 整批层面的失败：没有"哪条 proposal 被拒"可说
      if (applied.error) {
        if (applied.error.code === "E_SEQ_GAP") {
          yield emit({ type: "turn.rejected", code: "E_SEQ_GAP", message: applied.error.message, retryable: false });
        } else {
          yield emit({ type: "turn.error", code: codeOf({ code: applied.error.code }), message: applied.error.message, retryable: true });
        }
        return;
      }

      // ③ 仍然不 ok：不提交、不叙事，把原因交回编排层
      if (!applied.ok) {
        const fromModule = applied.rejected.some((r) => moduleProposals.includes(r.proposal));
        const first = applied.rejected[0];
        yield emit({
          type: "turn.error",
          code: fromModule ? "E_MODULE_FAULT" : ((first?.code as ErrorCode) ?? "E_MODULE_FAULT"),
          message: `提案被拒（${applied.rejected.length} 条）：${applied.rejected.map((r) => `${r.code}`).join(",")}${repairError ? `；修复也失败：${repairError}` : ""}`,
          retryable: false,
        });
        return;
      }

      // ④ 叙事在裁决之后才发：先宣布成功再回滚是这个系统最不能有的 bug
      if (narrative) yield emit({ type: "turn.delta", field: "narrative", text: narrative });
      const facts = [...(modOut.facts ?? [])];
      if (droppedByReality > 0) {
        facts.push(`世界观校准：${droppedByReality} 条不合现实的提议已忽略${kind ? `（${kind.label}）` : ""}`);
      }
      if (!mem.available) facts.push("记忆暂不可用：本回合按第一次见面处理。");
      if (memoryDropped > 0) facts.push(`记忆校准：${memoryDropped} 条未被采信。`);
      if (memoryRejected) facts.push("记忆写入被拒，本次行动照常生效。");
      // 世界印象：只读端口 + 投递后置标记；失败不影响本回合（印象是锦上添花）
      let deliveredNotices: import("../../shared/src/index.ts").ImpressionNotice[] = [];
      if (this.deps.impressions && req.userId) {
        try {
          const notices = await this.deps.impressions.pending(req.userId, req.roomId, 2);
          for (const notice of notices) {
            const npcName = notice.npcId ? state.entities[notice.npcId]?.name : undefined;
            facts.push(impressionFact(notice, npcName));
            deliveredNotices.push(notice);
          }
        } catch {
          deliveredNotices = [];
        }
      }
      evidence.facts = [...facts];
      if (facts.length > 0) yield emit({ type: "turn.facts", facts });
      if (modOut.ui) yield emit({ type: "turn.ui", view: modOut.ui });

      // 落库成功才更新记忆索引：读路径与写路径共用同一份事件日志（可回放）
      for (const ev of applied.events) this.deps.memory.ingest(ev);

      if (applied.events.length > 0) {
        const after = applied.stateAfter ?? await this.deps.store.snapshot(req.roomId);
        yield emit({ type: "turn.patch", state: after, ops: applied.applied });
      }

      // ⑤ 内存提交 ≠ 可靠存档：等落盘成功才算 commit
      try {
        await this.deps.store.flush(req.roomId);
      } catch (e) {
        if (isRoomSyncFault(e)) throw e;
        yield emit({ type: "turn.error", code: "E_STORE_FAULT", message: `落盘失败：${errMessage(e)}`, retryable: true });
        return;
      }

      const seq = applied.seq;
      // issue #34：apps/server 的消费者在收到 turn.commit 后立即 `break` 生成器，
      // yield 之后的语句不会执行；所有提交记账必须在 yield 之前完成。
      this.seen.set(key, events);
      // #42：低频 compact 只发生在已提交回合之后；失败不影响本回合结果
      this.maybeCompact(req.roomId, mem);
      // 印象只在回合真正提交后标记已投递（否则崩在中途会"说过又没说过"）
      if (deliveredNotices.length > 0 && this.deps.impressions) {
        try {
          await this.deps.impressions.markDelivered(deliveredNotices);
        } catch {
          // 印象是锦上添花：投递标记失败下次可能重复提示一次，可接受
        }
      }
      yield emit({ type: "turn.commit", turnId, seq, usage });
    } catch (e) {
      if (isRoomSyncFault(e)) throw e;
      const code = codeOf(e);
      // 可重试 = 契约 RETRYABLE（格式/超时/限流）+ E_STORE_FAULT（写盘失败，本回合未 commit，重试安全，docs/03 §7）；
      // E_MODULE_FAULT 这类硬失败重试也没用，不该给前端重试按钮（issue #21-3 / PR #23 复审）
      const retryable = RETRYABLE.includes(code) || code === "E_STORE_FAULT";
      yield emit({ type: "turn.error", code, message: errMessage(e), retryable });
    } finally {
      // 不论成功、失败还是抛异常，都释放本回合预算（否则预算表只增不减）
      this.deps.arbiter.endTurn(turnId);
    }
    } finally {
      // issue #34：即便上游在 turn.commit 处 break 生成器，也要释放同 key 并发等待者
      release();
      this.inFlight.delete(key);
    }
  }

  /**
   * 回合提交后的低频压缩（#42）。
   * 限频原因：compact 要对 owner 的记忆排序并按 salience 归档 1/3，每回合都做没有必要；
   * 位置原因：只有已提交的事件才进了记忆索引，失败/回滚的回合不该触发压缩。
   */
  private maybeCompact(roomId: RoomId, mem: MemoryContext): void {
    const n = (this.committedTurns.get(roomId) ?? 0) + 1;
    this.committedTurns.set(roomId, n);
    if (n % COMPACT_EVERY !== 0) return;
    const owners = mem.npcs.length > 0 ? mem.npcs.map((v) => v.npcId) : [mem.ownerId];
    for (const ownerId of owners) {
      // compact 是容量优化：失败只影响后续能否继续写，不应该让一个已提交的回合报错
      void this.deps.memory.compact(roomId, ownerId).catch(() => {});
    }
  }

  private cause(req: TurnRequest, seq: number): Envelope {
    return { v: 1, id: `evt_${req.clientTurnId}`, roomId: req.roomId, seq: seq + 1, ts: Date.now(), actorId: req.actorId, type: "turn.input", payload: { input: req.input } };
  }
}
