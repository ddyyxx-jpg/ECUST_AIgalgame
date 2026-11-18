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
import type { AuditPolicy, AuditPort } from "./audit.ts";
import { codeOf, errMessage } from "./turn.parse.ts";
import { RETRYABLE } from "../../shared/src/index.ts";
import { buildTurnPrompt } from "./turn.prompt.ts";
import { makeContext } from "./turn.context.ts";
import { TurnLlm, type LlmProduct } from "./turn.llm.ts";
import type { RealityKind, RealityPolicy } from "./reality.ts";
import { DEFAULT_REALITY, detectReality, filterProposals, realityFraming } from "./reality.ts";
import type { TurnJson } from "./turn.parse.ts";
import { AuditGate } from "./audit.gate.ts";
import { createTurnBudget, type DefaultArbiter } from "./arbiter.ts";
import type { EventSourcedMemory } from "./memory.ts";
import type { MemoryDraft } from "../../shared/src/index.ts";
import type { MemoryContext } from "./turn.memory.ts";
import { readMemoryContext } from "./turn.memory.ts";
import { attachAboutUserIds, recentDrafts, seedDrafts, toMemoryProposals } from "./turn.memory.drafts.ts";
import { applyMemoryGates } from "./memory.gate.ts";
import type { Impressions } from "./impressions.ts";
import { impressionFact } from "./impressions.ts";

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
}

export class DefaultTurn implements Turn {
  private readonly deps: TurnDeps;
  private readonly gate: AuditGate;
  private readonly reality: RealityPolicy;
  private readonly llmStep: TurnLlm;
  /**
   * 幂等缓存（issue #34）：key = JSON([roomId, actorId, clientTurnId])，同一个 id
   * 在不同房间 / 不同 actor 下互不干扰；重复提交只重放，不再花一次 LLM 的钱。
   *
   * 边界：这是**进程内**缓存，重启后清空。事件日志里没有独立的"回合已提交"事件，
   * 且零提案回合根本没有落库痕迹，因此在不改 store / 契约的最小改动下无法可靠重建
   * 跨进程的 commit marker —— 重启后的重复 clientTurnId 仍可能二次结算。
   * 要补齐这一点需要给 EventLog 增加持久化的回合标记（引擎契约变更），不在本次范围内。
   */
  private readonly seen = new Map<string, TurnEvent[]>();
  /** 同 key 正在结算的 promise：并发请求等它完成后再回放，保证只结算一次 */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(deps: TurnDeps) {
    this.deps = deps;
    this.reality = deps.reality ?? DEFAULT_REALITY;
    this.llmStep = new TurnLlm({
      llm: deps.llm,
      reality: this.reality,
      registry: deps.registry,
      ...(deps.buildPrompt ? { buildPrompt: deps.buildPrompt } : {}),
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
    // 幂等键 = room + actor + clientTurnId（issue #34）：同一个 clientTurnId 在不同房间 /
    // 不同 actor 下应各自结算，不能互相顶掉。
    const key = JSON.stringify([req.roomId, req.actorId, req.clientTurnId]);

    // 同 key 并发只结算一次：后来者等第一份结果落地，再回放它（per-key in-flight 锁）
    for (;;) {
      const cached = this.seen.get(key);
      if (cached) {
        for (const ev of cached) yield ev;
        return;
      }
      const prior = this.inFlight.get(key);
      if (!prior) break;
      await prior;
    }
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.inFlight.set(key, done);

    const events: TurnEvent[] = [];
    const emit = (ev: TurnEvent): TurnEvent => {
      events.push(ev);
      return ev;
    };

    const turnId = `turn_${req.clientTurnId}`;

    try {
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

      /**
       * 首问与业务修复成功后走**同一条**收口路径（issue #39）：叙事 / 台词 / 情节记忆
       * 全部取自这一份 product。修复时传的是 repaired，被拒的第一版一个字都不留；
       * 重建也会重置记忆计数，避免把第一版的草稿再写一遍（不双重写记忆）。
       */
      const takeLlmProduct = (product: LlmProduct): void => {
        narrative = product.text;
        llmProposals.length = 0;
        llmProposals.push(...product.proposals);
        memoryDropped = 0;
        memoryRejected = false;
        // 记忆归属：多 NPC 场景每个在场 NPC 各记一份（#20）；0 NPC 时仍记在玩家名下（旧行为）
        const units = mem.npcs.length > 0
          ? mem.npcs.map((v) => ({ ownerId: v.npcId, recent: v.recent, ownedCount: v.ownedCount }))
          : [{ ownerId: mem.ownerId, recent: mem.recent, ownedCount: mem.ownedCount }];
        // 模型记忆草稿的 ownerId 是空串（由闸门按 owner 重建）；种子草稿已经带 ownerId
        const baseDrafts = attachAboutUserIds([...seedDrafts(mem, state0, req), ...product.memory], state0);
        // 工作记忆（最近对话）：滚动替换旧条 + 叙事/台词分别取（PR #24 P2-1/P2-2）；
        // tombstone 排在新的 memory.write 之前，同一批内先撤回再写。
        const working = recentDrafts(mem, state0, req, product.narrative, product.dialogue);
        const accepted: MemoryDraft[] = [];
        for (const unit of units) {
          // about → aboutUserIds：canonize/印象靠它反查"这件事该告诉哪个账号"
          const drafts = [
            ...baseDrafts.filter((d) => d.ownerId === unit.ownerId || d.ownerId === ""),
            ...working.drafts.filter((d) => d.ownerId === unit.ownerId),
          ];
          const gated = applyMemoryGates({
            state: state0,
            actorId: req.actorId,
            ownerId: unit.ownerId,
            ...(mem.userId ? { userId: mem.userId } : {}),
            drafts,
            recent: unit.recent,
            ownedCount: unit.ownedCount,
          });
          memoryDropped += gated.dropped.length;
          accepted.push(...gated.accepted);
        }
        memoryProposals = [...working.tombstones, ...toMemoryProposals(accepted)];
      };

      /** 主批 / 修复批共用的两阶段裁决：只有记忆被拒时去掉记忆重提，不毁掉玩家行动 */
      const applyBatch = async (withMemory: boolean, expectedSeq: number) => {
        const batch = withMemory
          ? [...moduleProposals, ...llmProposals, ...memoryProposals]
          : [...moduleProposals, ...llmProposals];
        const result = await this.deps.arbiter.apply(req.roomId, batch, causeForBudget, {
          expectedSeq,
          turnBudget,
        });
        if (!result.ok && withMemory && memoryProposals.length > 0 && result.rejected.length > 0) {
          const onlyMemory = result.rejected.every((r) => memoryProposals.includes(r.proposal));
          if (onlyMemory) {
            memoryRejected = true;
            return await this.deps.arbiter.apply(req.roomId, [...moduleProposals, ...llmProposals], causeForBudget, {
              expectedSeq,
              turnBudget,
            });
          }
        }
        return result;
      };

      try {
        const state = state0;
        const ctx = makeContext(this.deps.registry, this.deps.llm, req, state);
        const modOut = await this.deps.modules.dispatchIntent(ctx);
        moduleProposals.push(...modOut.proposals);

        if (!req.options?.skipLLM) {
          const first = await this.llmStep.ask(req, state, kind, mem);
          usage = first.usage;
          droppedByReality += first.dropped;
          const gate = await this.gate.review({ roomId: req.roomId, actorId: req.actorId, input: req.input, text: first.text });
          if (gate.kind === "blocked") {
            const punishArgs = { roomId: req.roomId, actorId: req.actorId, clientTurnId: req.clientTurnId };
            for (const ev of await this.gate.punish(punishArgs, causeForBudget, gate.verdict, state, seqNow)) {
              emit(ev);
              yield ev;
            }
            this.seen.set(key, events);
            return;
          }
          if (gate.kind === "ok") {
            // 首问成功：叙事/台词/记忆统一由 takeLlmProduct 收口（修复成功后复用同一函数）
            takeLlmProduct(first);
          } else {
            // 审核器故障：文本不下发、提案不采信（可能是被诱导的产物），模块提案照旧
            narrative = this.gate.policy.unavailableText;
            memoryProposals = [];
          }
        }

        // ① 裁决：默认 atomic —— 任何一条被拒，整批不落库；记忆写坏时由 applyBatch 降级重提
        let applied = await applyBatch(true, seqNow);

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
              droppedByReality += repaired.dropped;
              const gate = await this.gate.review({ roomId: req.roomId, actorId: req.actorId, input: req.input, text: repaired.text });
              if (gate.kind === "blocked") {
                const punishArgs = { roomId: req.roomId, actorId: req.actorId, clientTurnId: req.clientTurnId };
                for (const ev of await this.gate.punish(punishArgs, causeForBudget, gate.verdict, state, this.deps.store.seq(req.roomId))) {
                  emit(ev);
                  yield ev;
                }
                this.seen.set(key, events);
                return;
              }
              if (gate.kind === "ok") {
                // 修复成功：必须用**修复后**的叙事/台词/记忆重建收口（issue #39），
                // 被拒的第一版叙事和记忆都不许留下来；takeLlmProduct 会重置记忆计数避免双写。
                takeLlmProduct(repaired);
              } else {
                // 审核器故障：文本不下发、提案不采信；被拒第一版的记忆同样不采信
                narrative = this.gate.policy.unavailableText;
                llmProposals.length = 0;
                memoryProposals = [];
              }
              applied = await applyBatch(true, this.deps.store.seq(req.roomId));
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
        if (facts.length > 0) yield emit({ type: "turn.facts", facts });
        if (modOut.ui) yield emit({ type: "turn.ui", view: modOut.ui });

        // 落库成功才更新记忆索引：读路径与写路径共用同一份事件日志（可回放）
        for (const ev of applied.events) this.deps.memory.ingest(ev);

        const after = await this.deps.store.snapshot(req.roomId);
        if (applied.events.length > 0) {
          yield emit({ type: "turn.patch", state: after, ops: applied.applied });
        }

        // ⑤ 内存提交 ≠ 可靠存档：等落盘成功才算 commit
        try {
          await this.deps.store.flush(req.roomId);
        } catch (e) {
          yield emit({ type: "turn.error", code: "E_STORE_FAULT", message: `落盘失败：${errMessage(e)}`, retryable: true });
          return;
        }

        // 提交前把所有收尾记账做完（issue #34）：HTTP 侧在 turn.commit 处 break，
        // 生成器 yield 之后的代码不会执行，seen 注册和印象投递标记必须放在这里。
        this.seen.set(key, events);

        // 印象只在回合真正提交后标记已投递（否则崩在中途会"说过又没说过"）
        if (deliveredNotices.length > 0 && this.deps.impressions) {
          try {
            await this.deps.impressions.markDelivered(deliveredNotices);
          } catch {
            // 印象是锦上添花：投递标记失败下次可能重复提示一次，可接受
          }
        }

        const seq = this.deps.store.seq(req.roomId);
        yield emit({ type: "turn.commit", turnId, seq, usage });
        return;
      } catch (e) {
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
      // 消费者可能在 commit 处 break 上游生成器；finally 仍会执行，绝不把同 key 的
      // 后来者永久卡在 inFlight 上（reset/early return/throw 同理）
      if (this.inFlight.get(key) === done) this.inFlight.delete(key);
      release();
    }
  }

  private cause(req: TurnRequest, seq: number): Envelope {
    return { v: 1, id: `evt_${req.clientTurnId}`, roomId: req.roomId, seq: seq + 1, ts: Date.now(), actorId: req.actorId, type: "turn.input", payload: { input: req.input } };
  }
}
