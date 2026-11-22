/**
 * 审核闸门：把"什么时候拦 / 拦了怎么处置"从 Turn 流水线里拆出来。
 * Turn 只留一行 `gate.review(...)` 与一行 `gate.punish(...)`；
 * 处置逻辑全部是 Proposal —— 审核层同样不能绕过 Arbiter 写状态。
 */
import type { ActorId, Envelope, Proposal, Registry, RoomId, TurnEvent, WorldState } from "../../shared/src/contract/types.ts";
import type { ErrorCode } from "../../shared/src/contract/errors.ts";
import type { AuditPolicy, AuditPort, AuditVerdict } from "./audit.ts";
import { DEFAULT_AUDIT_POLICY, NoopAudit, formatWarning, labelOf } from "./audit.ts";
import type { DefaultArbiter } from "./arbiter.ts";
import type { EventLog } from "./store.ts";
import type { TurnCommitEvidence } from "./turn.evidence.ts";
import { isRoomSyncFault } from "./store-write.ts";

export type AuditGateResult =
  | { kind: "ok" }
  | { kind: "unavailable" }
  | { kind: "blocked"; verdict: AuditVerdict };

export interface AuditGateDeps {
  arbiter: DefaultArbiter;
  store: EventLog;
  registry: Registry;
  audit?: AuditPort;
  policy?: AuditPolicy;
}

export interface ReviewRequest {
  roomId: RoomId;
  actorId: ActorId;
  /** 玩家原话，审核要结合语境 */
  input: string;
  /** 待审文本 = 叙事 + 台词 */
  text: string;
}

export class AuditGate {
  readonly policy: AuditPolicy;
  private readonly audit: AuditPort;

  constructor(private readonly deps: AuditGateDeps) {
    this.audit = deps.audit ?? new NoopAudit();
    this.policy = deps.policy ?? DEFAULT_AUDIT_POLICY;
  }

  /** 档案是否已被删除（审核归零时由 punish 写入场景 props） */
  purged(state: WorldState): boolean {
    const props = state.room.scene.props;
    return Array.isArray(props) && props.includes("purged");
  }

  /**
   * 叙事定稿后的审核：只有"判定违规且达到阈值"才拦。
   * 审核器抛错时 fail-safe：文本不下发、也不惩罚玩家（故障不该由玩家买单）。
   */
  async review(req: ReviewRequest): Promise<AuditGateResult> {
    if (!this.policy.enabled || req.text.trim() === "") return { kind: "ok" };
    try {
      const verdict = await this.audit.review({
        roomId: req.roomId,
        actorId: req.actorId,
        playerInput: req.input,
        text: req.text,
        categories: this.policy.categories,
        blockSeverity: this.policy.blockSeverity,
        categoryLabels: this.policy.categoryLabels,
      });
      if (!verdict.allow && verdict.severity >= this.policy.blockSeverity) return { kind: "blocked", verdict };
      return { kind: "ok" };
    } catch (e) {
      if (process.env.GALGAME_DEBUG) console.error(`[audit] ${e instanceof Error ? e.message : String(e)}`);
      return { kind: "unavailable" };
    }
  }

  /**
   * 违规处置：丢弃本次叙事与模型提案 → 警告 + 扣信誉（+1 警告计数）→ 信誉归零则删档标记。
   * 返回要发给玩家的事件；处置落库失败时返回 turn.error（不抛异常）。
   */
  async punish(
    args: { roomId: RoomId; actorId: ActorId; clientTurnId: string },
    cause: Envelope,
    verdict: AuditVerdict,
    state: WorldState,
    seq: number,
    evidence?: TurnCommitEvidence,
  ): Promise<TurnEvent[]> {
    const policy = this.policy;
    const plr = state.entities[args.actorId];
    // 引擎默认策略里没有属性名：policy.json 没声明就跳过对应处置，不猜字段（I2）
    const repKey = policy.reputationKey.trim();
    const strikeKey = policy.strikesKey.trim();
    const repDef = repKey ? this.deps.registry.attr(repKey) : undefined;
    const before = repKey ? (num(plr?.attrs[repKey]) ?? num(repDef?.default) ?? 0) : 0;
    const strikes = strikeKey ? (num(plr?.attrs[strikeKey]) ?? 0) : 0;
    const nextStrikes = strikes + 1;
    const penalty = repKey ? policy.penalty : 0;
    const after = Math.max(0, before - penalty);
    const purged = repKey !== "" && policy.purgeOnZero && after <= 0;
    const cats = verdict.categories.length > 0 ? verdict.categories : ["unspecified"];

    const ops: Proposal[] = [];
    if (repKey) {
      ops.push({
        op: "attr.delta",
        args: { entityId: args.actorId, key: repKey, delta: -policy.penalty },
        reason: "内容审核拦截：严重违规",
        by: "engine.audit",
      });
    }
    if (strikeKey) {
      ops.push({
        op: "attr.delta",
        args: { entityId: args.actorId, key: strikeKey, delta: 1 },
        reason: "审核警告计数",
        by: "engine.audit",
      });
    }
    ops.push(
      {
        op: "memory.write",
        args: {
          ownerId: args.actorId,
          content: `内容审核拦截（${labelOf(policy, cats)}）：${verdict.reason || "无理由"}`,
          tags: ["audit", "warning"],
          salience: 90,
          visibility: "private",
        },
        reason: "审核留痕",
        by: "engine.audit",
      },
    );
    if (purged) {
      ops.push(
        {
          op: "scene.set",
          args: { props: [...(state.room.scene.props ?? []), "purged"] },
          reason: "信誉归零：标记档案删除",
          by: "engine.audit",
        },
        {
          op: "memory.write",
          args: {
            ownerId: args.actorId,
            content: "信誉归零，玩家档案已删除。",
            tags: ["audit", "purged"],
            salience: 100,
            visibility: "private",
          },
          reason: "删档留痕",
          by: "engine.audit",
        },
      );
    }

    // 处置信封必须是 engine.* 来源：memory.write 的代写资格只看信封，不看 proposal.by
    const applied = await this.deps.arbiter.apply(args.roomId, ops, { ...cause, type: "engine.audit" }, {
      expectedSeq: seq, mode: "atomic", ...(evidence ? { commitEvidence: evidence } : {}), captureState: true,
    });

    const events: TurnEvent[] = [];
    if (!applied.ok) {
      events.push({
        type: "turn.error",
        code: (applied.error?.code as ErrorCode) ?? "E_MODULE_FAULT",
        message: `审核处置未能落库：${applied.error?.message ?? applied.rejected.map((r) => r.code).join(",")}`,
        retryable: false,
      });
      return events;
    }

    events.push({
      type: "turn.delta",
      field: "narrative",
      text: formatWarning(policy, { categories: cats, strikes: nextStrikes, penalty, after, purged }),
    });
    const facts = [
      `审核拦截：${labelOf(policy, cats)}（severity ${verdict.severity}）${verdict.reason ? `：${verdict.reason}` : ""}`,
      strikeKey ? `警告 ${nextStrikes}/${policy.maxWarnings}` : "警告计数未配置（跳过）",
      repKey
        ? `信誉 ${before} → ${after}${purged ? "（归零，档案已删除）" : ""}`
        : "信誉属性未配置（跳过扣分）",
    ];
    events.push({ type: "turn.facts", facts });
    const afterState = applied.stateAfter ?? await this.deps.store.snapshot(args.roomId);
    events.push({ type: "turn.patch", state: afterState, ops: applied.applied });
    try {
      await this.deps.store.flush(args.roomId);
    } catch (e) {
      if (isRoomSyncFault(e)) throw e;
      events.push({
        type: "turn.error",
        code: "E_STORE_FAULT",
        message: `落盘失败：${e instanceof Error ? e.message : String(e)}`,
        retryable: true,
      });
      return events;
    }
    events.push({ type: "turn.commit", turnId: `turn_${args.clientTurnId}`, seq: applied.seq });
    return events;
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
