/**
 * 房间级发言/调用预算（dev/v2）：在**调用 LLM 之前**判断，避免"生成后 coerce"白烧钱。
 *
 * 三条彼此独立的闸门（#133）：
 * - `mayCall`：这一波还能不能再调一次 LLM（每波总调用上限 + 该 NPC 本波已调用）。
 * - `maySpeak`：这一轮能不能真的说话（最短回信间隔 + 每小时消息上限）；
 *   被点名的目标只豁免最短间隔，仍受每小时上限约束。
 * - 渠道隔离：群聊（scene）与微信（gossip）各自一份计数，互不影响。
 *
 * 纯内存、确定性、可测试；服务重启后计数清零（与会话一起重建）。
 */
import type { RoomId, ActorId } from "../../../shared/src/index.ts";
import { DEFAULT_CONVERSATION_POLICY, type ConversationPolicy } from "../../../shared/src/index.ts";

export type BudgetReason = "ok" | "min-interval" | "hour-cap" | "call-cap";

/** 渠道：同一实例里群聊与微信各自记账，不互相消耗 */
export type TalkChannel = "scene" | "gossip";

const HOUR_MS = 3_600_000;

export class TalkBudget {
  private readonly lastSent = new Map<string, number>();
  private readonly sentTimes = new Map<string, number[]>();
  /** 每波调用计数：key = room|channel（本波在 beginTick 时清零） */
  private readonly tickCalls = new Map<string, number>();
  /** 每波每个 NPC 的调用计数：key = room|actor|channel */
  private readonly tickActorCalls = new Map<string, number>();
  private readonly now: () => number;
  private readonly cfg: ConversationPolicy["autonomy"];

  constructor(policy: Pick<ConversationPolicy, "autonomy"> = DEFAULT_CONVERSATION_POLICY, now: () => number = Date.now) {
    this.cfg = policy.autonomy;
    this.now = now;
  }

  private actorKey(roomId: RoomId, actorId: ActorId, channel: TalkChannel): string {
    return `${roomId}|${actorId}|${channel}`;
  }

  private channelKey(roomId: RoomId, channel: TalkChannel): string {
    return `${roomId}|${channel}`;
  }

  /** 同一调用窗口（1 小时）内该 NPC 在该渠道已产出几条消息 */
  sentInHour(roomId: RoomId, actorId: ActorId, channel: TalkChannel = "scene", at = this.now()): number {
    return (this.sentTimes.get(this.actorKey(roomId, actorId, channel)) ?? []).filter((t) => at - t < HOUR_MS).length;
  }

  /** 本波该渠道已调用几次 LLM */
  callsThisTick(roomId: RoomId, channel: TalkChannel = "scene"): number {
    return this.tickCalls.get(this.channelKey(roomId, channel)) ?? 0;
  }

  /** 本波该 NPC 在该渠道已调用几次 LLM */
  callsThisTickFor(roomId: RoomId, actorId: ActorId, channel: TalkChannel = "scene"): number {
    return this.tickActorCalls.get(this.actorKey(roomId, actorId, channel)) ?? 0;
  }

  /**
   * 还能不能再为这个 NPC 调一次 LLM（每波总上限 + 该 NPC 本波上限 1 次）。
   * 调用前判、调用时 `recordCall`；两者之间不要 await 别的 NPC 的决策以外的东西。
   */
  mayCall(roomId: RoomId, actorId: ActorId, channel: TalkChannel = "scene"): BudgetReason {
    if (this.callsThisTick(roomId, channel) >= this.cfg.maxNpcCallsPerTick) return "call-cap";
    if (this.callsThisTickFor(roomId, actorId, channel) >= 1) return "call-cap";
    return "ok";
  }

  /**
   * 这一轮能不能真的说话。
   * @param opts.ignoreMinInterval 被点名的目标传 true：点名必须回应，只豁免最短间隔
   */
  canSpeak(
    roomId: RoomId,
    actorId: ActorId,
    channel: TalkChannel = "scene",
    at = this.now(),
    opts: { ignoreMinInterval?: boolean } = {},
  ): BudgetReason {
    const last = this.lastSent.get(this.actorKey(roomId, actorId, channel));
    if (!opts.ignoreMinInterval && last !== undefined && at - last < this.cfg.minReplyIntervalMs) {
      return "min-interval";
    }
    if (this.sentInHour(roomId, actorId, channel, at) >= this.cfg.maxMessagesPerNpcPerHour) return "hour-cap";
    return "ok";
  }

  /** 每个后台波次/每个玩家回合开始时调用：每波调用上限按波次计，不按小时累计 */
  beginTick(roomId: RoomId, channel: TalkChannel = "scene"): void {
    this.tickCalls.delete(this.channelKey(roomId, channel));
    for (const k of [...this.tickActorCalls.keys()]) {
      if (k.startsWith(`${roomId}|`) && k.endsWith(`|${channel}`)) this.tickActorCalls.delete(k);
    }
  }

  /** 上次在该渠道真正说话的时间（调度排序用：最近没说过的人优先） */
  lastSentAt(roomId: RoomId, actorId: ActorId, channel: TalkChannel = "scene"): number | undefined {
    return this.lastSent.get(this.actorKey(roomId, actorId, channel));
  }

  /** 何时可以再试（供调度器决定下次唤醒，避免空转） */
  nextEligible(roomId: RoomId, actorId: ActorId, channel: TalkChannel = "scene", at = this.now()): number {
    const last = this.lastSent.get(this.actorKey(roomId, actorId, channel));
    return last === undefined ? at : last + this.cfg.minReplyIntervalMs;
  }

  /** 调用 LLM 时记一次；实际是否产出消息都要记，防止"反复调用但被判无效"绕过上限 */
  recordCall(roomId: RoomId, actorId: ActorId, channel: TalkChannel = "scene"): void {
    const ck = this.channelKey(roomId, channel);
    this.tickCalls.set(ck, (this.tickCalls.get(ck) ?? 0) + 1);
    const ak = this.actorKey(roomId, actorId, channel);
    this.tickActorCalls.set(ak, (this.tickActorCalls.get(ak) ?? 0) + 1);
  }

  /** 成功发出**非空**消息后记一次（同时推进最短回信间隔）；空 speak 不要调它 */
  recordSent(roomId: RoomId, actorId: ActorId, channel: TalkChannel = "scene"): void {
    const at = this.now();
    const k = this.actorKey(roomId, actorId, channel);
    this.lastSent.set(k, at);
    const list = (this.sentTimes.get(k) ?? []).filter((t) => at - t < HOUR_MS);
    list.push(at);
    this.sentTimes.set(k, list);
  }

  clearRoom(roomId: RoomId): void {
    for (const k of [...this.lastSent.keys()]) if (k.startsWith(`${roomId}|`)) this.lastSent.delete(k);
    for (const k of [...this.sentTimes.keys()]) if (k.startsWith(`${roomId}|`)) this.sentTimes.delete(k);
    for (const k of [...this.tickCalls.keys()]) if (k.startsWith(`${roomId}|`)) this.tickCalls.delete(k);
    for (const k of [...this.tickActorCalls.keys()]) if (k.startsWith(`${roomId}|`)) this.tickActorCalls.delete(k);
  }
}
