/**
 * Memory：按 docs/03 §2.6 的契约实现打分召回。
 * score = 0.45*tagOverlap + 0.25*recency + 0.20*salience/5 + 0.10*relationWeight
 * secret 且 about 命中 → forced（强制注入，不参与打分、不占预算优先级最低）。
 */
import type {
  ActorId,
  Memory,
  MemoryDraft,
  MemoryHit,
  MemoryQuery,
  MemoryRecord,
  RoomId,
} from "../../shared/src/index.ts";

const W = { tag: 0.45, recency: 0.25, salience: 0.2, relation: 0.1 };
const THRESHOLD = 0.35;
const CHARS_PER_TOKEN = 4;

export class InMemoryMemory implements Memory {
  private readonly byRoom = new Map<RoomId, MemoryRecord[]>();
  private nextId = 0;

  async write(roomId: RoomId, drafts: MemoryDraft[]): Promise<void> {
    const list = this.byRoom.get(roomId) ?? [];
    for (const d of drafts) {
      if (!d.ownerId || !d.content) continue;
      list.push({
        id: `mem_${++this.nextId}`,
        roomId,
        ownerId: d.ownerId,
        content: d.content.slice(0, 500),
        tags: (d.tags ?? []).slice(0, 8),
        salience: Math.min(5, Math.max(0, d.salience ?? 1)),
        about: d.about ?? [],
        visibility: d.visibility ?? "private",
        tier: d.tier ?? "short",
        turn: 0,
        createdAt: Date.now(),
      });
    }
    this.byRoom.set(roomId, list);
  }

  async recall(q: MemoryQuery): Promise<MemoryHit[]> {
    const list = (this.byRoom.get(q.roomId) ?? []).filter((m) => m.ownerId === q.ownerId);
    const hits: MemoryHit[] = [];
    for (const rec of list) {
      const about = q.about ?? [];
      const secretForMe = rec.visibility === "secret" && rec.about.some((a) => about.includes(a));
      const score = this.score(rec, q);
      if (secretForMe) hits.push({ record: rec, score: 1, forced: true });
      else if (score >= THRESHOLD) hits.push({ record: rec, score });
    }
    // 强制命中的先放，其余按分排序；再按 token 预算装箱
    hits.sort((a, b) => Number(!!b.forced) - Number(!!a.forced) || b.score - a.score);
    const out: MemoryHit[] = [];
    let used = 0;
    for (const h of hits) {
      const cost = Math.ceil(h.record.content.length / CHARS_PER_TOKEN) + 8;
      if (used + cost > q.budgetTokens && !h.forced) break;
      used += cost;
      out.push(h);
    }
    return out;
  }

  async compact(roomId: RoomId, ownerId: ActorId): Promise<{ impressions: number; archived: number }> {
    const list = this.byRoom.get(roomId) ?? [];
    const mine = list.filter((m) => m.ownerId === ownerId && !m.archived);
    if (mine.length <= 60) return { impressions: 0, archived: 0 };
    // 超过 60 条：把最旧最不重要的 1/3 归档（真实实现会先让 LLM 摘要，M0 只标记）
    mine.sort((a, b) => a.salience - b.salience || a.createdAt - b.createdAt);
    const take = Math.floor(mine.length / 3);
    for (const m of mine.slice(0, take)) m.archived = true;
    return { impressions: mine.length, archived: take };
  }

  /** 3.1.0 骨架：P2 才真正实现（纯派生，不写状态） */
  async profile(): Promise<null> {
    return null;
  }

  /** 测试用 */
  all(roomId: RoomId): MemoryRecord[] {
    return [...(this.byRoom.get(roomId) ?? [])];
  }

  private score(rec: MemoryRecord, q: MemoryQuery): number {
    const wantTags = q.tags ?? [];
    const overlap = wantTags.length === 0
      ? (rec.tags.length ? 0.3 : 0)
      : wantTags.filter((t) => rec.tags.includes(t)).length / wantTags.length;
    const dt = Math.max(0, q.nowTurn - rec.turn);
    const recency = Math.exp(-dt / 25);
    const salience = rec.salience / 5;
    const rel = q.about && q.about.length ? (rec.about.some((a) => q.about!.includes(a)) ? 1 : 0) : 0.3;
    return W.tag * overlap + W.recency * recency + W.salience * salience + W.relation * rel;
  }
}
