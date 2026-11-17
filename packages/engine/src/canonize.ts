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
import type { EventLog } from "./store.ts";
import type { Memory } from "../../shared/src/index.ts";

export interface PermanentCandidate {
  worldId: Id;
  content: string;
  tags: string[];
  about: Id[];
  aboutUserIds?: Id[];
  sourceRefs: Id[];
  status: "current" | "historical";
}

/** 引擎需要"读全部记录"来做候选聚合；`Memory` 契约只保证查询接口，故在此收窄 */
export interface MemoryIndex extends Memory {
  all(roomId: RoomId): MemoryRecord[];
}

export interface CanonizeJudge {
  review(c: PermanentCandidate): Promise<{ allow: boolean; reason?: string }>;
}

export interface CanonizeStats {
  worldId: Id;
  version: number;
  writtenToday: number;
  writtenTotal: number;
  circuitOpen: boolean;
  consecutiveJudgeFailures: number;
}

export interface CanonizeLimits {
  enabled: boolean;
  /** 每日新条目上限（默认 200） */
  dailyCap: number;
  /** 公共性门槛：至少多少位不同见证者（默认 2） */
  minWitness: number;
  /** 单来源（同一条记忆 id）最多贡献几条候选（默认 2） */
  perSourceCap: number;
  /** judge 连续失败多少次熔断（默认 3；熔断当天不再尝试） */
  judgeFailureLimit?: number;
}

export const DEFAULT_CANONIZE_LIMITS: CanonizeLimits = {
  enabled: true,
  dailyCap: 200,
  minWitness: 2,
  perSourceCap: 2,
};

export interface CanonizeDeps {
  /** 房间事件日志（同一实例即可，世界层是另一个 roomId） */
  store: EventLog;
  /** 世界层裁决器：memory.write 的 permanent 规则由它把关 */
  arbiter: Arbiter;
  worldRoom: RoomId;
  worldId: Id;
  memory: MemoryIndex;
  judge: CanonizeJudge;
  limits?: Partial<CanonizeLimits>;
  /** 世界层版本号变更（server 落盘 data/worlds/<id>/mem.version） */
  onVersionBump?: (worldId: Id, next: number) => void | Promise<void>;
  now?: () => number;
  /** 注入时钟日期（测试用）；默认本地日期 YYYY-MM-DD */
  today?: () => string;
  /**
   * 印象入队回调（server 写用户投影文件）。引擎不发事件、不做 IO：
   * "谁被记住了"是派生视图，不是世界状态。
   */
  onImpression?: (notice: ImpressionNotice, roomId: RoomId) => void | Promise<void>;
}

export interface CanonizeReport {
  worldId: Id;
  /** 进入闸门的候选数 */
  candidates: number;
  written: Id[];
  /** 被丢弃的原因统计（同一原因合并计数） */
  skipped: Array<{ reason: string; count: number }>;
  /** 写失败（不应出现：说明 Arbiter 规则与闸门不一致） */
  errors: string[];
  /** 当日已写（含本次） */
  writtenToday: number;
}

const SOURCE_REF = /^(evt_|canon_|fact_|lore_|mem_)/;

/** 隐私扫描：禁语来自活跃 plot；私密记忆原文也不许"换个说法"进世界层 */
function privacyHit(content: string, state: WorldState, secrets: string[]): string | null {
  for (const plot of state.plots as Plot[]) {
    if (plot.status !== "active" || !plot.forbidReveal) continue;
    if (content.includes(plot.forbidReveal)) return `plot:${plot.id}`;
  }
  for (const s of secrets) {
    if (s.length >= 6 && content.includes(s.slice(0, Math.min(20, s.length)))) return "secret_memory";
  }
  return null;
}

/** 从房间记忆里聚合候选：同一条"事"至少被 minWitness 个不同 owner 记住，才算公共知识 */
export function candidatesFromMemories(
  roomId: RoomId,
  records: MemoryRecord[],
  worldId: Id,
): PermanentCandidate[] {
  const groups = new Map<string, MemoryRecord[]>();
  for (const r of records) {
    if (r.visibility !== "public") continue;
    if (r.status !== "current") continue;
    if (r.tier !== "long" && r.tier !== "permanent") continue;
    const key = contentHashOf(r.content);
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const out: PermanentCandidate[] = [];
  for (const [hash, list] of groups) {
    const owners = new Set(list.map((r) => r.ownerId));
    if (owners.size === 0) continue;
    const first = list[0]!;
    out.push({
      worldId,
      content: first.content,
      tags: [...new Set(list.flatMap((r) => r.tags))].slice(0, 8),
      about: [...new Set(list.flatMap((r) => r.about))].slice(0, 8),
      aboutUserIds: [...new Set(list.flatMap((r) => r.aboutUserIds ?? []))].slice(0, 8),
      sourceRefs: [...new Set(list.map((r) => r.id))].slice(0, 8),
      status: "current",
    });
    void hash;
  }
  return out;
}

/** 见证者数：同一内容被几个不同 owner 记住（owner 身份就是"谁亲眼见过"） */
function witnessCount(records: MemoryRecord[], candidate: PermanentCandidate): number {
  const hash = contentHashOf(candidate.content);
  return new Set(records.filter((r) => contentHashOf(r.content) === hash).map((r) => r.ownerId)).size;
}

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

  /** 房间退役：把该房间的公共长期记忆提成候选（docs/08 §6/§7.2） */
  async retireRoom(roomId: RoomId): Promise<CanonizeReport> {
    const events = await this.deps.store.events(roomId, 0);
    void events;
    const records = this.deps.memory.all(roomId);
    const state = this.deps.store.state(roomId);
    return this.publish(state, records, roomId);
  }

  /** 夜间补扫：把已加载世界里所有房间跑一遍（本实现只跑调用方给定的房间集合） */
  async runDaily(rooms: RoomId[]): Promise<CanonizeReport[]> {
    const reports: CanonizeReport[] = [];
    for (const roomId of rooms) reports.push(await this.retireRoom(roomId));
    return reports;
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

  private async publish(state: WorldState, roomRecords: MemoryRecord[], roomId: RoomId): Promise<CanonizeReport> {
    this.rollDay();
    const skipped = new Map<string, number>();
    const errors: string[] = [];
    const written: Id[] = [];
    if (!this.limits.enabled) {
      return { worldId: this.deps.worldId, candidates: 0, written, skipped: [{ reason: "disabled", count: 1 }], errors, writtenToday: this.writtenToday };
    }

    const candidates = candidatesFromMemories(roomId, roomRecords, this.deps.worldId);
    const secrets = roomRecords.filter((r) => r.visibility === "secret").map((r) => r.content);
    // 幂等只看**世界层**已有条目；房间里的记忆当然有同样的内容，那是候选的来源，不是重复
    const existing = new Set(this.worldHashes(await this.deps.store.events(this.deps.worldRoom, 0)));

    if (this.consecutiveJudgeFailures >= this.judgeFailureLimit) {
      return { worldId: this.deps.worldId, candidates: candidates.length, written, skipped: [{ reason: "circuit_open", count: candidates.length }], errors, writtenToday: this.writtenToday };
    }

    for (const candidate of candidates) {
      // ① 来源可追溯
      if (candidate.sourceRefs.length === 0 || !candidate.sourceRefs.every((r) => SOURCE_REF.test(r))) {
        this.skip(skipped, "source_untraceable");
        continue;
      }
      // ② 公共性
      if (witnessCount(roomRecords, candidate) < this.limits.minWitness) {
        this.skip(skipped, "not_public_enough");
        continue;
      }
      // ③ 隐私扫描
      const hit = privacyHit(candidate.content, state, secrets);
      if (hit) {
        this.skip(skipped, `privacy:${hit}`);
        continue;
      }
      // ④ 独立审核（judge 抛错 = 拒绝：fail-closed）
      try {
        const verdict = await this.deps.judge.review(candidate);
        this.consecutiveJudgeFailures = 0;
        if (!verdict.allow) {
          this.skip(skipped, `judge:${verdict.reason ?? "deny"}`);
          continue;
        }
      } catch {
        this.consecutiveJudgeFailures += 1;
        this.skip(skipped, "judge_unavailable");
        continue;
      }
      // ⑤ 幂等（同内容已在世界层）
      const hash = contentHashOf(candidate.content);
      if (existing.has(hash)) {
        this.skip(skipped, "duplicate");
        continue;
      }
      // ⑥ 体量：每日上限 + 单来源上限
      if (this.writtenToday >= this.limits.dailyCap) {
        this.skip(skipped, "daily_cap");
        continue;
      }
      const src = candidate.sourceRefs[0]!;
      if ((this.perSource.get(src) ?? 0) >= this.limits.perSourceCap) {
        this.skip(skipped, "per_source_cap");
        continue;
      }

      // ⑦⑧ 发布（不可变/回滚由 Arbiter 的世界层规则保证）+ 版本号
      const op: Proposal = {
        op: "memory.write",
        reason: `canonize:${src}`,
        args: {
          ownerId: "mem_world",
          worldId: this.deps.worldId,
          content: candidate.content,
          tags: candidate.tags,
          about: candidate.about,
          aboutUserIds: candidate.aboutUserIds,
          sourceRefs: candidate.sourceRefs,
          contentHash: hash,
          tier: "permanent",
          visibility: "public",
          status: candidate.status,
          salience: 5,
        },
      };
      const seq = await this.deps.store.load(this.deps.worldRoom);
      const cause: Envelope = {
        v: 1,
        id: `evt_canonize_${hash.slice(0, 12)}`,
        roomId: this.deps.worldRoom,
        seq: seq + 1,
        ts: this.deps.now ? this.deps.now() : Date.now(),
        actorId: "mem_world",
        type: "canonize",
        payload: { worldId: this.deps.worldId, sourceRefs: candidate.sourceRefs },
      };
      const applied = await this.deps.arbiter.apply(this.deps.worldRoom, [op], cause);
      if (!applied.ok) {
        const code = applied.rejected[0]?.code ?? applied.error?.code ?? "E_MODULE_FAULT";
        errors.push(code);
        this.skip(skipped, `arbiter:${code}`);
        continue;
      }
      let memoryId: Id | undefined;
      for (const ev of applied.events) {
        if (ev.type === "memory.written") {
          const id = (ev.payload as { memoryId?: Id }).memoryId;
          if (id) {
            written.push(id);
            memoryId = id;
          }
        }
      }
      // 印象：只有"关于某个玩家的公开事迹"才通知他（每条约 1 个 userId，按 userId 去重）
      if (memoryId && this.deps.onImpression && candidate.aboutUserIds && candidate.aboutUserIds.length > 0) {
        const npcId = candidate.about.find((id) => id.startsWith("npc_"));
        for (const userId of [...new Set(candidate.aboutUserIds)].slice(0, 4)) {
          const notice = buildImpression({
            memoryId,
            userId,
            worldId: this.deps.worldId,
            content: candidate.content,
            ...(npcId ? { npcId } : {}),
            now: this.deps.now ? this.deps.now() : Date.now(),
          });
          if (notice) await this.deps.onImpression(notice, roomId);
        }
      }
      existing.add(hash);
      this.perSource.set(src, (this.perSource.get(src) ?? 0) + 1);
      this.writtenToday += 1;
      this.writtenTotal += 1;
      this.worldVersion += 1;
      if (this.deps.onVersionBump) await this.deps.onVersionBump(this.deps.worldId, this.worldVersion);
    }

    return {
      worldId: this.deps.worldId,
      candidates: candidates.length,
      written,
      skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })),
      errors,
      writtenToday: this.writtenToday,
    };
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
    const seq = await this.deps.store.load(this.deps.worldRoom);
    const cause: Envelope = {
      v: 1,
      id: `evt_uncanonize_${memoryId}`,
      roomId: this.deps.worldRoom,
      seq: seq + 1,
      ts: this.deps.now ? this.deps.now() : Date.now(),
      actorId: "mem_world",
      type: "canonize",
      payload: { action: "tombstone", memoryId },
    };
    const applied = await this.deps.arbiter.apply(
      this.deps.worldRoom,
      [
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
      ],
      cause,
    );
    if (!applied.ok) return false;
    this.worldVersion += 1;
    if (this.deps.onVersionBump) await this.deps.onVersionBump(this.deps.worldId, this.worldVersion);
    return true;
  }
}
