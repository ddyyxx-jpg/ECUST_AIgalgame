/**
 * 世界层永久记忆的自动审核（docs/08 §7）。
 *
 * 三段职责分清：
 *   - 候选生成：**只读**房间事件/记忆，不产事件；
 *   - 八道闸门：纯函数 + 一个注入的 judge 端口（审核模型由 server 注入，引擎不读 key）；
 *   - 发布：唯一写路径是 `worldArbiter.apply(room_world_<worldId>, [memory.write tier=permanent])`。
 *
 * 为什么闸门要在代码里而不是只在提示词里：世界层是"所有玩家共享的常识"，写错一次所有人都会记住，
 * 撤回要走 tombstone + 版本号。所以这里宁可错杀（fail-closed）。
 */
import type {
  Arbiter,
  Envelope,
  Id,
  ImpressionNotice,
  MemoryRecord,
  Plot,
  Proposal,
  RoomId,
  WorldState,
} from "../../shared/src/index.ts";
import { contentHashOf } from "./memory.gate.ts";
import { buildImpression } from "./impressions.ts";
import type { PermanentCandidate } from "./canonize.candidates.ts";
import { candidatesFromMemories, privacyHit, witnessCount } from "./canonize.candidates.ts";
import type { PublishMut } from "./canonize.publish.ts";
import { applyWithSeqRetry, publishCandidates } from "./canonize.publish.ts";
import type { CanonizeDeps, CanonizeJudge, CanonizeLimits, CanonizeReport, CanonizeRunOptions, CanonizeStats, MemoryIndex } from "./canonize.types.ts";
import { DEFAULT_CANONIZE_LIMITS } from "./canonize.types.ts";

// 兼容旧导入路径：类型/限额拆到 canonize.types.ts，外部仍从这里取
export type {
  CanonizeDeps,
  CanonizeJudge,
  CanonizeLimits,
  CanonizeReport,
  CanonizeRunOptions,
  CanonizeStats,
  MemoryIndex,
} from "./canonize.types.ts";
export { DEFAULT_CANONIZE_LIMITS } from "./canonize.types.ts";

// 兼容旧导入路径：类型/纯函数已拆到 canonize.candidates.ts，但外部（apps/server、index.ts）仍从这里取
export type { PermanentCandidate } from "./canonize.candidates.ts";
export { candidatesFromMemories, privacyHit, witnessCount } from "./canonize.candidates.ts";
import type { EventLog } from "./store.ts";
import type { Memory } from "../../shared/src/index.ts";


export class CanonizeJob {
  private readonly limits: CanonizeLimits;
  private day: string;
  private writtenToday = 0;
  private readonly perSource = new Map<Id, number>();
  private worldVersion = 0;
  private writtenTotal = 0;
  private consecutiveJudgeFailures = 0;
  /** 熔断：judge 连续不可用 N 次后当天不再尝试（避免每回合白花一次审核调用） */
  private readonly judgeFailureLimit: number;

  constructor(private readonly deps: CanonizeDeps) {
    this.limits = { ...DEFAULT_CANONIZE_LIMITS, ...(deps.limits ?? {}) };
    this.judgeFailureLimit = this.limits.judgeFailureLimit ?? 3;
    // 重启后版本号不能回退：从持久层读回，后续只增（审阅 P0-3）
    this.worldVersion = Math.max(0, deps.startVersion ?? 0);
    this.day = this.today();
  }

  get version(): number {
    return this.worldVersion;
  }

  /** 观测（P4）：给 admin/指标用，别把内部状态散着读 */
  stats(): CanonizeStats {
    return {
      worldId: this.deps.worldId,
      version: this.worldVersion,
      writtenToday: this.writtenToday,
      writtenTotal: this.writtenTotal,
      circuitOpen: this.consecutiveJudgeFailures >= this.judgeFailureLimit,
      consecutiveJudgeFailures: this.consecutiveJudgeFailures,
    };
  }

  /** 人工抽样复审：返回世界层最近的永久记忆（新→旧） */
  sample(limit = 20): MemoryRecord[] {
    const records = typeof this.deps.memory.all === "function" ? this.deps.memory.all(this.deps.worldRoom) : [];
    return records
      .filter((r) => r.tier === "permanent" && r.status === "current")
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, Math.max(0, limit));
  }

  /**
   * 房间退役：把该房间的公共长期记忆提成候选（docs/08 §6/§7.2）。
   *
   * 中止是**协作式**的：在每个 IO/LLM 调用前与循环迭代之间检查 signal，abort 后尽快返回
   * `aborted: true`。已经过 Arbiter 落库的批次保持真实、不回滚；未开始的候选直接跳过。
   * 不传 signal 时行为与旧签名完全一致。
   */
  async retireRoom(roomId: RoomId, opts: CanonizeRunOptions = {}): Promise<CanonizeReport> {
    // 房间日志必须先载入（FileStore 懒加载）：重启后直接 admin canonize 也要看到完整事件
    await this.deps.store.load(roomId);
    if (opts.signal?.aborted) return this.abortedReport(roomId);
    // P2-2：一次运行开始时记下世界房 seq（不是 apply 前临时 load），作为整批写入的基线；
    // 被 stall 接管的新世代若推进了世界房 seq，旧任务体后续 apply 必被 E_SEQ_GAP 拒绝。
    const basedOnSeq = await this.deps.store.load(this.deps.worldRoom);
    if (opts.signal?.aborted) return this.abortedReport(roomId);
    // 索引可能落后于日志（比如刚重启、或这房间还没跑过回合）：先增量同步再取候选。
    // 用 sync 而不是 rebuild：外部已经显式喂过的记录不该被清掉（测试与"预置候选"场景）。
    const envs = await this.deps.store.events(roomId, 0);
    if (opts.signal?.aborted) return this.abortedReport(roomId);
    if (this.deps.memory.sync) this.deps.memory.sync(roomId, envs);
    else this.deps.memory.rebuild?.(roomId, envs);
    const records = this.deps.memory.all(roomId);
    const state = this.deps.store.state(roomId);
    return this.publish(state, records, roomId, opts.signal, basedOnSeq);
  }

  /** 夜间补扫：把已加载世界里所有房间跑一遍（本实现只跑调用方给定的房间集合） */
  async runDaily(rooms: RoomId[], opts: CanonizeRunOptions = {}): Promise<CanonizeReport[]> {
    const reports: CanonizeReport[] = [];
    for (const roomId of rooms) {
      if (opts.signal?.aborted) break;
      reports.push(await this.retireRoom(roomId, opts));
    }
    return reports;
  }

  /** 中止时的报告：written 为空表示本次没有落库；此前批次不受影响（不回滚） */
  private abortedReport(roomId: RoomId): CanonizeReport {
    return { worldId: this.deps.worldId, candidates: 0, written: [], skipped: [], errors: [], writtenToday: this.writtenToday, aborted: true };
  }

  private today(): string {
    if (this.deps.today) return this.deps.today();
    const d = new Date(this.deps.now ? this.deps.now() : Date.now());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  private rollDay(): void {
    const day = this.today();
    if (day !== this.day) {
      this.day = day;
      this.writtenToday = 0;
      this.perSource.clear();
    }
  }

  private skip(skipped: Map<string, number>, reason: string): void {
    skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  }

  private async publish(state: WorldState, roomRecords: MemoryRecord[], roomId: RoomId, signal: AbortSignal | undefined, basedOnSeq: number): Promise<CanonizeReport> {
    this.rollDay();
    const mut: PublishMut = {
      writtenToday: this.writtenToday,
      writtenTotal: this.writtenTotal,
      perSource: this.perSource,
      worldVersion: this.worldVersion,
      judgeFailures: this.consecutiveJudgeFailures,
    };
    const report = await publishCandidates({
      deps: this.deps,
      limits: this.limits,
      judgeFailureLimit: this.judgeFailureLimit,
      mut,
      state,
      roomRecords,
      roomId,
      signal,
      basedOnSeq,
      worldHashes: (envs) => this.worldHashes(envs),
    });
    this.writtenToday = mut.writtenToday;
    this.writtenTotal = mut.writtenTotal;
    this.worldVersion = mut.worldVersion;
    this.consecutiveJudgeFailures = mut.judgeFailures;
    return report;
  }


  private worldHashes(events: Envelope[]): string[] {
    const out: string[] = [];
    for (const ev of events) {
      if (ev.type !== "memory.written") continue;
      const hash = (ev.payload as { contentHash?: string }).contentHash;
      if (hash) out.push(hash);
    }
    return out;
  }

  /** 撤回：tombstone 立即生效，世界层版本 +1（docs/08 §7.3 第 8 条） */

  async tombstone(memoryId: Id, reason: string): Promise<boolean> {
    return (await this.tombstoneWithReason(memoryId, reason)).ok;
  }

  /**
   * 与 `tombstone` 同一条写入路径，但把失败原因带出来：`E_SEQ_GAP` 是**并发冲突**
   * （世界层正被别人写），运维应当重试；`E_MEMORY_IMMUTABLE` 才是真的不可变。
   * HTTP 层原先只拿 boolean，把两者都报成 409「已撤回或不可变」（PR #149 审阅 P2-4）。
   */
  async tombstoneWithReason(memoryId: Id, reason: string): Promise<{ ok: boolean; code?: string }> {
    // P2-2：运行开始时 load 的 seq 作为基线；applyWithSeqRetry 内部只在活动任务（无 signal）
    // 遇到 E_SEQ_GAP 时有界重试，被 stall 接管的旧任务体不会重算新 seq 后写入。
    const basedOnSeq = await this.deps.store.load(this.deps.worldRoom);
    const applied = await applyWithSeqRetry(
      this.deps,
      {
        op: "memory.write",
        reason,
        args: {
          ownerId: "mem_world",
          worldId: this.deps.worldId,
          content: "（已撤回）",
          contentHash: contentHashOf(`tombstone:${memoryId}`),
          sourceRefs: [memoryId],
          tier: "permanent",
          visibility: "public",
          status: "tombstoned",
          supersedes: memoryId,
          salience: 5,
        },
      },
      (causeSeq) => ({
        v: 1,
        id: `evt_uncanonize_${memoryId}`,
        roomId: this.deps.worldRoom,
        seq: causeSeq,
        ts: this.deps.now ? this.deps.now() : Date.now(),
        actorId: "mem_world",
        type: "canonize",
        payload: { action: "tombstone", memoryId },
      }),
      basedOnSeq,
    );
    if (!applied.applied.ok) {
      // 与 canonize.publish.ts 保持同一取码口径：批次级 error 优先，再退到首条被拒提案
      const code = applied.applied.error?.code ?? applied.applied.rejected[0]?.code;
      return { ok: false, ...(code ? { code } : {}) };
    }
    for (const ev of applied.applied.events) this.deps.memory.ingest?.(ev);
    this.worldVersion += 1;
    if (this.deps.onVersionBump) await this.deps.onVersionBump(this.deps.worldId, this.worldVersion);
    return { ok: true };
  }
}
