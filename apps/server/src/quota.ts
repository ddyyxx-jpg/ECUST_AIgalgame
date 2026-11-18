/**
 * 行动额度账本（收敛稿 B1，docs/03 §5.2.10）：按**限定作用域**的逻辑请求结算。
 * 状态机 reserved → running → committed / failed / unconfirmed。
 * append-only JSONL 投影（重启重建，可丢可重建，不是权威状态）；与历史提交事实对账。
 *
 * 幂等键 = userId + roomId + clientTurnId（P1-1）：单看 clientTurnId 会让不同账号/房间的
 * 同名 ID 互相误判。actorId 额外落库并在复用 ID 时校验，避免同房间不同角色混用同一逻辑 ID。
 * 重启恢复（P1-2）：旧进程遗留的 running 不可能仍在执行 → 转 unconfirmed 待核对；
 * reserved 尚未真正开跑 → 转 failed 释放额度。否则账号会被永久 E_TURN_BUSY / 占额度。
 * 预留过期不自动释放：unconfirmed 需核对到提交事实或管理员 resolve 才结案（#34 未交付的残留风险）。
 */
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

export type LedgerState = "reserved" | "running" | "committed" | "failed" | "unconfirmed";

export interface LedgerEntry {
  clientTurnId: string;
  roomId: string;
  userId: string;
  /** 房间内角色 id；参与复用 ID 的一致性校验（见 reserve） */
  actorId?: string;
  state: LedgerState;
  day: string;
  reservedAt: number;
  settledAt?: number;
  turnId?: string;
  committedSeq?: number;
}

/** 限定作用域：提交/查询/对账/结案都按它定位同一逻辑请求 */
export interface TurnScope {
  userId: string;
  roomId: string;
  actorId?: string;
  clientTurnId: string;
}

export type ReserveResult =
  | { ok: true; entry: LedgerEntry }
  | { ok: false; code: "E_RATE_LIMITED" | "E_TURN_BUSY" | "E_PRECONDITION"; message: string; committedSeq?: number };

function isEntry(v: unknown): v is LedgerEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.clientTurnId === "string" && typeof e.roomId === "string" && typeof e.userId === "string" &&
    typeof e.state === "string" && typeof e.day === "string" && typeof e.reservedAt === "number"
  );
}

/** 幂等键：账号 + 房间 + 逻辑请求 ID（\\u0000 分隔，避免拼接歧义） */
function scopeKey(s: { userId: string; roomId: string; clientTurnId: string }): string {
  return `${s.userId}\u0000${s.roomId}\u0000${s.clientTurnId}`;
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 占用每日额度的状态：failed 释放，其余（含待核对）保守占用直到结案 */
const OCCUPYING: ReadonlySet<LedgerState> = new Set(["reserved", "running", "committed", "unconfirmed"]);

/** 账本存在但读不出来（权限/IO 故障）：不能当新账本继续，否则幂等记录丢失会重复执行已提交行动 */
export class LedgerUnreadableError extends Error {
  constructor(file: string, cause: unknown) {
    super(`额度账本不可读，拒绝启动以免丢失幂等记录：${file}（${cause instanceof Error ? cause.message : String(cause)}）`);
    this.name = "LedgerUnreadableError";
  }
}

/** 管理员结案：仅待核对可结案；不存在/状态不符都要能区分，不能静默覆盖 */
export type ResolveResult =
  | { ok: true; entry: LedgerEntry }
  | { ok: false; code: "E_REF_NOT_FOUND" | "E_ILLEGAL_OP" | "E_STORE_FAULT"; message: string };

export class TurnLedger {
  private readonly entries = new Map<string, LedgerEntry>();
  private chain: Promise<unknown> = Promise.resolve();
  /** 结案/对账的"检查状态 → 落盘 → 更新内存"必须整体串行，否则并发请求会互相覆盖 */
  private decisionChain: Promise<unknown> = Promise.resolve();
  private skippedFromLoad = 0;

  constructor(private readonly filePath: string) {}

  /**
   * 启动加载时被跳过的行数：>0 说明上次进程可能非正常退出（尾部半行）或账本被破坏。
   * 被跳过的条目不会参与幂等/对账（已提交行动可能被当新请求），所以必须对运维可见。
   */
  get skippedLines(): number {
    return this.skippedFromLoad;
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (e) {
      // 只有"确实不存在"才是新账本；其它读取失败必须中止启动（复审 P1）
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new LedgerUnreadableError(this.filePath, e);
    }
    let skipped = 0;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!isEntry(parsed)) throw new Error("账本行结构不符");
        // P1-2：旧进程在途状态不可能还活着。running（已开跑，结果未知）→ 待核对；
        // reserved（还没真正开跑）→ failed 释放额度。避免重启后账号被永久阻塞。
        const entry: LedgerEntry =
          parsed.state === "running" ? { ...parsed, state: "unconfirmed", settledAt: Date.now() } :
          parsed.state === "reserved" ? { ...parsed, state: "failed", settledAt: Date.now() } :
          parsed;
        this.entries.set(scopeKey(entry), entry);
      } catch {
        // 坏行（多为崩溃留下的半截尾行）跳过，但计数告警：静默会掩盖"已提交记录丢失"
        skipped += 1;
      }
    }
    this.skippedFromLoad = skipped;
    if (skipped > 0) {
      console.warn(`[quota] 额度账本有 ${skipped} 行无法解析，已跳过（上次进程可能非正常退出）：${this.filePath}`);
    }
  }

  /** 等待所有排队/进行中的写盘落定（读后写一致性；测试用它替代 sleep） */
  async flush(): Promise<void> {
    await this.chain;
  }

  /** 按限定作用域查找；传字符串则按 clientTurnId 全表唯一匹配（管理员/测试便捷入口） */
  get(query: TurnScope | string): LedgerEntry | undefined {
    if (typeof query === "string") {
      const key = this.uniqueKey(query);
      return key ? this.entries.get(key) : undefined;
    }
    return this.entries.get(scopeKey(query));
  }

  list(filter: { userId?: string; state?: LedgerState } = {}): LedgerEntry[] {
    return [...this.entries.values()].filter(
      (e) => (!filter.userId || e.userId === filter.userId) && (!filter.state || e.state === filter.state),
    );
  }

  todayTurns(userId: string, now = Date.now()): number {
    const day = dayKey(now);
    let count = 0;
    for (const e of this.entries.values()) {
      if (e.userId === userId && e.day === day && OCCUPYING.has(e.state)) count += 1;
    }
    return count;
  }

  reserve(opts: { userId: string; roomId: string; actorId?: string; clientTurnId: string; dailyLimit: number | null; actionsEnabled: boolean; now?: number }): ReserveResult {
    const now = opts.now ?? Date.now();
    if (!opts.actionsEnabled) {
      return { ok: false, code: "E_RATE_LIMITED", message: "本轮体验已暂停新行动" };
    }
    const existing = this.entries.get(scopeKey(opts));
    if (existing) {
      // 同一账号+房间+ID 但换了角色：拒绝，避免两个角色混用同一逻辑 ID
      if (existing.actorId && opts.actorId && existing.actorId !== opts.actorId) {
        return { ok: false, code: "E_PRECONDITION", message: "该行动 ID 已用于本房间的其他角色" };
      }
      if (existing.state === "committed") {
        return { ok: false, code: "E_PRECONDITION", message: "该行动已提交，请刷新后继续", committedSeq: existing.committedSeq };
      }
      if (existing.state === "running") return { ok: false, code: "E_TURN_BUSY", message: "该行动仍在执行" };
      if (existing.state === "unconfirmed") return { ok: false, code: "E_PRECONDITION", message: "该行动结果待核对，请先确认" };
      // failed：允许以同一逻辑 ID 重试
    }
    for (const e of this.entries.values()) {
      if (e.userId === opts.userId && e.state === "running") {
        return { ok: false, code: "E_TURN_BUSY", message: "上一个行动尚未结束" };
      }
    }
    if (opts.dailyLimit !== null && this.todayTurns(opts.userId, now) >= opts.dailyLimit) {
      return { ok: false, code: "E_RATE_LIMITED", message: "本轮体验额度已用完" };
    }
    const entry: LedgerEntry = {
      clientTurnId: opts.clientTurnId, roomId: opts.roomId, userId: opts.userId,
      ...(opts.actorId ? { actorId: opts.actorId } : {}),
      state: "reserved", day: dayKey(now), reservedAt: now,
    };
    this.entries.set(scopeKey(entry), entry);
    void this.append(entry);
    return { ok: true, entry };
  }

  transition(query: TurnScope | string, state: LedgerState, extra: { turnId?: string; committedSeq?: number } = {}): LedgerEntry | undefined {
    const key = typeof query === "string" ? this.uniqueKey(query) : scopeKey(query);
    if (!key) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const next: LedgerEntry = { ...entry, state, settledAt: Date.now(), ...extra };
    this.entries.set(key, next);
    void this.append(next);
    return next;
  }

  /**
   * 关键状态（running）必须确认落盘后才允许开跑：写失败向调用方抛错，由调用方在 head 之前中止。
   * 普通 transition 只排队写、错误被吞（账本是可重建投影），不足以证明「磁盘上已是 running」——
   * 否则中断时磁盘只有 reserved，重启会误判 failed 并允许重试已开跑的回合。
   */
  async transitionDurable(query: TurnScope, state: LedgerState, extra: { turnId?: string; committedSeq?: number } = {}): Promise<LedgerEntry | undefined> {
    const key = scopeKey(query);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const next: LedgerEntry = { ...entry, state, settledAt: Date.now(), ...extra };
    this.entries.set(key, next);
    await this.append(next);
    return next;
  }

  /** 管理员人工对账：**仅** `unconfirmed` 可结案；running/committed 不可被覆盖（复审 P2） */
  async resolve(query: TurnScope | string, resolution: "committed" | "failed", committedSeq?: number): Promise<ResolveResult> {
    return this.decide(async () => {
      const key = typeof query === "string" ? this.uniqueKey(query) : scopeKey(query);
      const entry = key ? this.entries.get(key) : undefined;
      if (!key || !entry) return { ok: false, code: "E_REF_NOT_FOUND", message: "没有该行动记录" };
      if (entry.state !== "unconfirmed") {
        return { ok: false, code: "E_ILLEGAL_OP", message: `仅待核对（unconfirmed）可结案，当前状态 ${entry.state}` };
      }
      return this.writeSettlement(key, entry, resolution, { committedSeq });
    });
  }

  /**
   * 历史自动对账：与人工结案共用同一串行队列和状态转换规则。
   * 已 committed 幂等返回；仅 unconfirmed/running/reserved 且历史确有提交事实时推进到 committed。
   */
  async reconcileCommitted(query: TurnScope, extra: { turnId?: string; committedSeq?: number } = {}): Promise<ResolveResult> {
    return this.decide(async () => {
      const key = scopeKey(query);
      const entry = this.entries.get(key);
      if (!entry) return { ok: false, code: "E_REF_NOT_FOUND", message: "没有该行动记录" };
      if (entry.state === "committed") return { ok: true, entry };
      if (entry.state !== "unconfirmed" && entry.state !== "running" && entry.state !== "reserved") {
        return { ok: false, code: "E_ILLEGAL_OP", message: `当前状态 ${entry.state} 不能按历史对账结案` };
      }
      return this.writeSettlement(key, entry, "committed", extra);
    });
  }

  /** 同一账本的结案决策串行执行（不阻塞普通回合 transition 的写队列） */
  private decide<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.decisionChain.then(fn);
    this.decisionChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 先落盘再改内存：写失败时保持原状态，调用方返回 E_STORE_FAULT 供重试 */
  private async writeSettlement(
    key: string,
    entry: LedgerEntry,
    resolution: "committed" | "failed",
    extra: { turnId?: string; committedSeq?: number } = {},
  ): Promise<ResolveResult> {
    const next: LedgerEntry = {
      ...entry, state: resolution, settledAt: Date.now(),
      ...(resolution === "committed" && extra.committedSeq !== undefined ? { committedSeq: extra.committedSeq } : {}),
      ...(extra.turnId ? { turnId: extra.turnId } : {}),
    };
    try {
      await this.append(next);
    } catch {
      return { ok: false, code: "E_STORE_FAULT", message: "额度账本写入失败，未结案，可重试" };
    }
    this.entries.set(key, next);
    return { ok: true, entry: next };
  }

  /** 字符串查询：clientTurnId 全表恰好一条才返回键；多条=歧义，要求调用方带上作用域 */
  private uniqueKey(clientTurnId: string): string | undefined {
    let found: string | undefined;
    let count = 0;
    for (const [key, entry] of this.entries) {
      if (entry.clientTurnId === clientTurnId) {
        found = key;
        count += 1;
      }
    }
    return count === 1 ? found : undefined;
  }

  private append(entry: LedgerEntry): Promise<void> {
    const run = this.chain.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      // appendFile 到 OS 缓存就返回，崩溃断电会丢掉"已承诺落盘"的最后一条；
      // transitionDurable 的语义要求 fsync 之后才算写完。
      const fh = await open(this.filePath, "a");
      try {
        // 每条记录前先写换行：即使上一次写入只落了半行（短写/崩溃/外部损坏），
        // 新记录也从行首开始，不会被半截尾行粘成新的坏行。空行在加载时被忽略。
        await fh.writeFile(`\n${JSON.stringify(entry)}\n`, "utf8");
        await fh.sync();
      } finally {
        await fh.close();
      }
    });
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }
}