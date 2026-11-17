/**
 * Memory：事件溯源的记忆索引（docs/03 §2.6、docs/07）。
 *
 * 记忆**不进 WorldState**，它和世界状态一样从同一份事件日志投影出来：
 *   memory.written   → 追加一条
 *   memory.tombstoned / memory.written(status=tombstoned) → 把旧条目标成已撤回
 * 这样"重启后记忆还在""回放得到同样的记忆""联机时各端一致"三件事同时成立，
 * 而且不需要第二套持久化机制（P1 的验收点）。
 *
 * 召回的分数公式沿用 v1：0.45*tagOverlap + 0.25*recency + 0.20*salience/5 + 0.10*relation。
 * secret 且 about 命中 → forced：强制注入、不参与打分、不占预算优先级。
 */
import type {
  ActorId,
  Envelope,
  Id,
  Memory,
  MemoryDraft,
  MemoryHit,
  MemoryProfile,
  MemoryQuery,
  MemoryRecord,
  MemoryTier,
  RoomId,
} from "../../shared/src/index.ts";

const W = { tag: 0.45, recency: 0.25, salience: 0.2, relation: 0.1 };
const THRESHOLD = 0.35;
const CHARS_PER_TOKEN = 4;
/** 压缩阈值：超过就把最旧最不重要的 1/3 归档（归档不进 prompt，但还能被检索） */
const COMPACT_AFTER = 60;

/**
 * token 估算：CJK 按 1 字 = 1 token、其余按 4 字 = 1 token（保守上界）。
 * 全仓只此一份实现 —— 提示词预算、注入硬顶都调它，别各自写一套。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x2e80) cjk += 1;
  }
  const rest = text.length - cjk;
  return cjk + Math.ceil(Math.max(0, rest) / CHARS_PER_TOKEN);
}

/** 历史数据 salience 是 0~100，契约 3.1.0 起是 1~5：读时收敛，不丢信息 */
export function normalizeSalience(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 3;
  const clamped = n > 5 ? Math.round(n / 20) : Math.round(n);
  return Math.min(5, Math.max(1, clamped));
}

/** 旧版 visibility 有 "scene"，3.1.0 起统一为 public */
export function normalizeVisibility(v: unknown): "public" | "private" | "secret" {
  if (v === "public" || v === "scene") return "public";
  if (v === "secret") return "secret";
  return "private";
}

function normalizeTier(v: unknown): MemoryTier {
  return v === "permanent" ? "permanent" : v === "long" ? "long" : "short";
}

/** 世界层房间 id：同一 worldId 的所有房间共享一层永久记忆 */
export function worldRoomId(worldId: Id): RoomId {
  return `room_world_${worldId}`;
}

export class EventSourcedMemory implements Memory {
  /** roomId → 按事件顺序排列的记录 */
  private readonly byRoom = new Map<RoomId, MemoryRecord[]>();
  private readonly byId = new Map<Id, MemoryRecord>();
  /** roomId → 已 ingest 到的 seq（增量同步用） */
  private readonly syncedSeq = new Map<RoomId, number>();
  private testSeq = 0;

  /**
   * 重建：清空该房间索引后重放整条日志（重启后由 server 调用；也用于测试"回放一致"）。
   * 只清 roomId 自己的记录，不碰别的房间（世界层与房间层互不影响）。
   */
  rebuild(roomId: RoomId, envs: readonly Envelope[]): void {
    const list = this.byRoom.get(roomId) ?? [];
    for (const rec of list) this.byId.delete(rec.id);
    this.byRoom.set(roomId, []);
    this.syncedSeq.delete(roomId);
    this.sync(roomId, envs);
  }

  /** 从事件日志增量同步（重启后第一次召回前调用；重复调用无副作用） */
  sync(roomId: RoomId, envs: readonly Envelope[]): void {
    const last = this.syncedSeq.get(roomId) ?? 0;
    for (const env of [...envs].sort((a, b) => a.seq - b.seq)) {
      if (env.seq <= last) continue;
      this.ingest(env);
    }
  }

  /** 应用一条事件；不认识的类型直接忽略（日志里有别的子系统的事件） */
  ingest(env: Envelope): void {
    const roomId = env.roomId;
    const prevSeq = this.syncedSeq.get(roomId) ?? 0;
    if (env.seq > prevSeq) this.syncedSeq.set(roomId, env.seq);
    const p = (env.payload ?? {}) as Record<string, unknown>;
    if (env.type === "memory.written") {
      const id = typeof p.memoryId === "string" ? p.memoryId : "";
      if (!id) return;
      const status: MemoryRecord["status"] =
        p.status === "tombstoned" ? "tombstoned" : p.status === "historical" ? "historical" : "current";
      const existing = this.byId.get(id);
      if (existing) {
        // 幂等：同一 id（contentHash 派生）的重复写入不产生第二条
        if (status === "tombstoned") existing.status = "tombstoned";
        return;
      }
      const record: MemoryRecord = {
        id,
        roomId,
        ownerId: typeof p.ownerId === "string" ? p.ownerId : "mem_world",
        content: typeof p.content === "string" ? p.content : "",
        tags: Array.isArray(p.tags) ? (p.tags as string[]).filter((t): t is string => typeof t === "string") : [],
        salience: normalizeSalience(p.salience),
        about: Array.isArray(p.about) ? (p.about as string[]).filter((t): t is string => typeof t === "string") : [],
        visibility: normalizeVisibility(p.visibility),
        tier: normalizeTier(p.tier),
        turn: typeof p.turn === "number" ? p.turn : typeof p.at === "number" ? p.at : 0,
        createdAt: env.ts,
        status,
      };
      if (typeof p.worldId === "string") record.worldId = p.worldId;
      if (typeof p.userId === "string") record.userId = p.userId;
      if (Array.isArray(p.sourceRefs)) record.sourceRefs = p.sourceRefs as string[];
      if (typeof p.contentHash === "string") record.contentHash = p.contentHash;
      if (Array.isArray(p.aboutUserIds)) record.aboutUserIds = p.aboutUserIds as string[];
      if (typeof p.supersedes === "string") {
        const old = this.byId.get(p.supersedes);
        if (old) old.status = "tombstoned";
      }
      this.byId.set(id, record);
      const list = this.byRoom.get(roomId) ?? [];
      list.push(record);
      this.byRoom.set(roomId, list);
      return;
    }
    if (env.type === "memory.tombstoned") {
      const target = typeof p.memoryId === "string" ? p.memoryId : typeof p.supersedes === "string" ? p.supersedes : "";
      const rec = target ? this.byId.get(target) : undefined;
      if (rec) rec.status = "tombstoned";
    }
  }

  /** 测试用：直接写（不经过 Arbiter，不产事件）；正式路径永远是 Proposal → apply → ingest */
  async write(roomId: RoomId, drafts: MemoryDraft[]): Promise<void> {
    const list = this.byRoom.get(roomId) ?? [];
    for (const d of drafts) {
      if (!d.ownerId || !d.content) continue;
      const id = `mem_test_${++this.testSeq}`;
      const rec: MemoryRecord = {
        id,
        roomId,
        ownerId: d.ownerId,
        content: d.content.slice(0, 500),
        tags: (d.tags ?? []).slice(0, 8),
        salience: normalizeSalience(d.salience),
        about: d.about ?? [],
        visibility: normalizeVisibility(d.visibility),
        tier: normalizeTier(d.tier),
        turn: 0,
        createdAt: Date.now(),
        status: d.status ?? "current",
      };
      if (d.userId) rec.userId = d.userId;
      if (d.aboutUserIds) rec.aboutUserIds = d.aboutUserIds;
      this.byId.set(id, rec);
      list.push(rec);
    }
    this.byRoom.set(roomId, list);
  }

  /** 召回：先按 owner/作用域/账号过滤，再打分与装箱（forced 不占预算） */
  async recall(q: MemoryQuery): Promise<MemoryHit[]> {
    const tiers = q.tiers ?? ["short", "long"];
    const candidates = (this.byRoom.get(q.roomId) ?? []).filter((rec) => {
      if (rec.ownerId !== q.ownerId) return false;
      if (!tiers.includes(rec.tier)) return false;
      if (rec.status === "tombstoned") return false;
      if (rec.archived) return false;
      // 账号隔离：给了 userId 时，别人的**私忆**不可见；世界层公开条目跨账号可读（否则"这个世界记得你"对别人失效）
      const isWorldScope = q.scope === "world";
      if (!isWorldScope && q.userId && rec.userId && rec.userId !== q.userId) return false;
      if (q.scope === "world" && q.worldId && rec.worldId && rec.worldId !== q.worldId) return false;
      return true;
    });
    const about = q.about ?? [];
    const hits: MemoryHit[] = [];
    for (const rec of candidates) {
      const secretForMe = rec.visibility === "secret" && rec.about.some((a) => about.includes(a));
      if (secretForMe) hits.push({ record: rec, score: 1, forced: true });
      else {
        const score = this.score(rec, q);
        if (score >= THRESHOLD) hits.push({ record: rec, score });
      }
    }
    hits.sort((a, b) => Number(!!b.forced) - Number(!!a.forced) || b.score - a.score || a.record.id.localeCompare(b.record.id));
    const out: MemoryHit[] = [];
    let used = 0;
    for (const h of hits) {
      // forced（secret 强制注入）不占预算、不因预算被截断（docs/03 §2.6）
      if (h.forced) {
        out.push(h);
        continue;
      }
      const cost = estimateTokens(h.record.content) + 8;
      if (used + cost > q.budgetTokens) break;
      used += cost;
      out.push(h);
    }
    return out;
  }

  /** 纯派生：不写状态、不产事件；没有任何记录时返回 null（调用方据此决定要不要种子） */
  async profile(userId: Id, ownerId: ActorId, roomId: RoomId): Promise<MemoryProfile | null> {
    const mine = (this.byRoom.get(roomId) ?? []).filter(
      (r) => r.ownerId === ownerId && (!userId || !r.userId || r.userId === userId) && r.status !== "tombstoned",
    );
    const short = mine.filter((r) => r.tier === "short");
    const long = mine.filter((r) => r.tier === "long");
    const permanent = mine.filter((r) => r.tier === "permanent");
    if (mine.length === 0 && permanent.length === 0) return null;
    let impressions = 0;
    const impressionIds: Id[] = [];
    for (const list of this.byRoom.values()) {
      for (const r of list) {
        if (r.tier !== "permanent" || r.status === "tombstoned") continue;
        if (r.aboutUserIds?.includes(userId)) {
          impressions += 1;
          if (r.roomId === roomId) impressionIds.push(r.id);
        }
      }
    }
    const turns = mine.map((r) => r.turn).filter((t) => t > 0);
    const topics = [...mine]
      .sort((a, b) => b.turn - a.turn || b.createdAt - a.createdAt)
      .flatMap((r) => r.tags)
      .filter((t, i, arr) => arr.indexOf(t) === i)
      .slice(0, 5);
    const profile: MemoryProfile = {
      userId,
      roomId,
      ownerId,
      familiarity: Math.min(1, (short.length + 2 * long.length) / 20),
      impressionIds,
      impressions,
      lastTopics: topics,
      seenImpressionIds: [],
    };
    if (turns.length > 0) profile.firstMetTurn = Math.min(...turns);
    return profile;
  }

  async compact(roomId: RoomId, ownerId: ActorId): Promise<{ impressions: number; archived: number }> {
    const list = this.byRoom.get(roomId) ?? [];
    const mine = list.filter((m) => m.ownerId === ownerId && !m.archived && m.status !== "tombstoned");
    if (mine.length <= COMPACT_AFTER) return { impressions: 0, archived: 0 };
    mine.sort((a, b) => a.salience - b.salience || a.createdAt - b.createdAt);
    const take = Math.floor(mine.length / 3);
    for (const m of mine.slice(0, take)) m.archived = true;
    return { impressions: mine.length, archived: take };
  }

  /** 世界层/私忆通用：按 id 取（canonize 幂等与不可变校验用） */
  get(id: Id): MemoryRecord | undefined {
    return this.byId.get(id);
  }

  has(id: Id): boolean {
    return this.byId.has(id);
  }

  /** 测试与调试 */
  all(roomId: RoomId): MemoryRecord[] {
    return [...(this.byRoom.get(roomId) ?? [])];
  }

  private score(rec: MemoryRecord, q: MemoryQuery): number {
    const wantTags = q.tags ?? [];
    const overlap = wantTags.length === 0 ? (rec.tags.length ? 0.3 : 0) : wantTags.filter((t) => rec.tags.includes(t)).length / wantTags.length;
    const dt = Math.max(0, q.nowTurn - rec.turn);
    const recency = Math.exp(-dt / 25);
    const salience = rec.salience / 5;
    const rel = q.about && q.about.length ? (rec.about.some((a) => q.about!.includes(a)) ? 1 : 0) : 0.3;
    return W.tag * overlap + W.recency * recency + W.salience * salience + W.relation * rel;
  }
}

/**
 * @deprecated 旧名。实现已改为事件溯源（EventSourcedMemory），保留别名只是为了不动旧测试。
 */
export { EventSourcedMemory as InMemoryMemory };
