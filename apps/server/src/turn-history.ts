/**
 * 回合历史（issue #7）：`data/rooms/<roomId>.history.jsonl`，只记**已提交**的回合。
 *
 * 为什么挂在 Turn 外层而不是 HTTP 路由里：
 * 1) 路由的 `for await` 可能在 turn.commit 后立刻 break（现在的实现就是），
 *    收尾逻辑必须放在生成器的 finally 里，否则"客户端提前断开"就会丢记录；
 * 2) map.travel 也直接调 turn.run（skipLLM），挂在 Turn 外层能一并覆盖。
 *
 * 历史是"读模型的投影"，不是第二份权威状态：写失败只告警，不回滚已提交的回合；
 * 恢复时以事件日志（GET /state）为准，历史只用来重放对话。
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Store, Turn, TurnEvent, TurnRequest } from "../../../packages/shared/src/contract/types.ts";
import type { SaveIndex } from "./saves.ts";

/** 与 docs/09 §3 对齐；narrative/speakers 由引擎事件投影而来 */
export interface TurnHistoryLine {
  formatVersion: 1;
  roomId: string;
  turnId: string;
  committedSeq: number;
  actorId: string;
  userId?: string;
  /** 逻辑请求 ID：仅落盘，用于额度对账与重试核对（不下发） */
  clientTurnId?: string;
  input: string;
  narrative: string;
  /** 预留：当前 3.1 的事件流只有叙事文本，没有逐句 speaker；恢复时按叙事整段重放 */
  speakers: string[];
  facts: string[];
  createdAt: number;
}

export interface HistoryQuery {
  /** 断流恢复时，用回合与角色精确匹配单条历史。 */
  match?: Pick<TurnHistoryLine, "turnId" | "actorId">;
  /** turnId（不含）或 committedSeq 数字（> 该 seq）；向前翻页 */
  fromTurn?: string;
  /** 记录游标或旧版 committedSeq 数字，向后加载更早 */
  before?: string;
  limit?: number;
}

export interface HistoryPage {
  lines: TurnHistoryLine[];
  lastCommittedSeq: number;
  /** 是否还有更早的历史可加载 */
  hasEarlier: boolean;
  earlierCursor?: string;
}

function isHistoryLine(v: unknown): v is TurnHistoryLine {
  if (!v || typeof v !== "object") return false;
  const l = v as Record<string, unknown>;
  return (
    l.formatVersion === 1 &&
    typeof l.roomId === "string" &&
    typeof l.turnId === "string" &&
    typeof l.committedSeq === "number" &&
    typeof l.actorId === "string" &&
    typeof l.input === "string" &&
    typeof l.narrative === "string" &&
    Array.isArray(l.speakers) &&
    Array.isArray(l.facts) &&
    typeof l.createdAt === "number"
  );
}

/** 房间号来自 URL，做白名单；正常 room_* 原样落盘，异常 id 用 hash 防穿越 */
function safeRoomFile(roomId: string): string {
  if (/^[A-Za-z0-9_-]{1,80}$/.test(roomId)) return roomId;
  return `x_${createHash("sha256").update(roomId, "utf8").digest("hex").slice(0, 24)}`;
}

/** 去重作用域与引擎一致：房间内按 actorId + turnId（turnId 已包含 clientTurnId） */
function historyKey(line: Pick<TurnHistoryLine, "actorId" | "turnId">): string {
  return `${line.actorId}\u0000${line.turnId}`;
}

function historyCursor(line: TurnHistoryLine): string {
  return `h_${createHash("sha256").update(historyKey(line)).digest("hex")}`;
}

export class TurnHistory {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly known = new Map<string, Set<string>>();

  constructor(private readonly roomsDir: string) {}

  fileFor(roomId: string): string {
    return path.join(this.roomsDir, `${safeRoomFile(roomId)}.history.jsonl`);
  }

  /** 按 committedSeq 升序返回全部有效行；坏行跳过（历史可丢、状态不可丢） */
  async readAll(roomId: string): Promise<TurnHistoryLine[]> {
    let raw: string;
    try {
      raw = await readFile(this.fileFor(roomId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw Object.assign(new Error("读取回合历史失败", { cause: error }), { code: "E_STORE_FAULT" });
    }
    const lines: TurnHistoryLine[] = [];
    for (const text of raw.split("\n")) {
      const trimmed = text.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isHistoryLine(parsed)) lines.push(parsed);
      } catch {
        // 半截行（进程在写盘中途被杀）：跳过，不影响后续回合
      }
    }
    lines.sort((a, b) => a.committedSeq - b.committedSeq);
    return lines;
  }

  async list(roomId: string, query: HistoryQuery = {}): Promise<HistoryPage> {
    const all = await this.readAll(roomId);
    const rawLimit = query.limit ?? 50;
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 50, 1), 200);
    let end = all.length;
    let start = Math.max(0, end - limit);
    if (query.match) {
      const { turnId, actorId } = query.match;
      const index = all.findIndex((item) => item.turnId === turnId && item.actorId === actorId);
      start = Math.max(0, index);
      end = index + 1;
    } else if (query.before?.trim()) {
      const before = query.before;
      if (before.startsWith("h_")) {
        end = Math.max(0, all.findIndex((line) => historyCursor(line) === before));
      } else {
        const seq = Number(before);
        const index = all.findIndex((line) => line.committedSeq >= seq);
        if (Number.isFinite(seq) && index >= 0) end = index;
      }
      start = Math.max(0, end - limit);
    } else if (query.fromTurn) {
      const seq = Number(query.fromTurn);
      if (Number.isFinite(seq) && query.fromTurn.trim() !== "") {
        start = all.findIndex((line) => line.committedSeq > seq);
      } else {
        const index = all.findIndex((line) => line.turnId === query.fromTurn);
        start = index < 0 ? all.length : index + 1;
      }
      if (start < 0) start = all.length;
      end = start + limit;
    }
    const lines = all.slice(start, end);
    const first = lines[0];
    return {
      lines,
      lastCommittedSeq: all.length ? all[all.length - 1]!.committedSeq : 0,
      hasEarlier: Boolean(first && start > 0),
      ...(first && start > 0 ? { earlierCursor: historyCursor(first) } : {}),
    };
  }

  /** 同一作用域（actorId + turnId）幂等：Turn 的 seen 缓存重放会再次产出 turn.commit，不能重复记账 */
  append(line: TurnHistoryLine): Promise<void> {
    const prev = this.chains.get(line.roomId) ?? Promise.resolve();
    const task = prev.then(() => this.doAppend(line));
    this.chains.set(line.roomId, task.catch(() => undefined));
    return task;
  }

  private async doAppend(line: TurnHistoryLine): Promise<void> {
    const known = await this.knownFor(line.roomId);
    const key = historyKey(line);
    if (known.has(key)) return;
    const file = this.fileFor(line.roomId);
    await mkdir(path.dirname(file), { recursive: true });
    // 每条记录前先写换行：上次崩溃/短写留下的半截尾行不会粘住这条新历史
    await appendFile(file, `\n${JSON.stringify(line)}\n`, "utf8");
    known.add(key);
  }

  private async knownFor(roomId: string): Promise<Set<string>> {
    const cached = this.known.get(roomId);
    if (cached) return cached;
    const set = new Set((await this.readAll(roomId)).map(historyKey));
    this.known.set(roomId, set);
    return set;
  }
}

/** 供 createApp 装配：包在 Turn 外层，提交后记账，失败只告警 */
export interface TurnRecordingDeps {
  history: TurnHistory;
  saves: SaveIndex;
  store: Store;
  now?: () => number;
  warn?: (message: string, error: unknown) => void;
}

export function withTurnRecording(inner: Turn, deps: TurnRecordingDeps): Turn {
  const warn = deps.warn ?? ((message, error) => console.warn(`[history] ${message}`, error));
  const now = deps.now ?? Date.now;
  return {
    run(req: TurnRequest): AsyncIterable<TurnEvent> {
      return recordRun(inner, req, deps, warn, now);
    },
  };
}

async function* recordRun(
  inner: Turn,
  req: TurnRequest,
  deps: TurnRecordingDeps,
  warn: (message: string, error: unknown) => void,
  now: () => number,
): AsyncIterable<TurnEvent> {
  const facts: string[] = [];
  let narrative = "";
  let committed: { turnId: string; seq: number } | undefined;

  try {
    for await (const event of inner.run(req)) {
      if (event.type === "turn.delta" && event.field === "narrative") {
        narrative = narrative ? `${narrative}\n${event.text}` : event.text;
      } else if (event.type === "turn.facts") {
        facts.push(...event.facts);
      } else if (event.type === "turn.commit") {
        committed = { turnId: event.turnId, seq: event.seq };
      }
      yield event;
    }
  } finally {
    // 消费者 break 时这里由 return() 触发；await 会延迟 return() 完成，
    // 所以路由 reply.raw.end() 之前历史已经落盘。
    if (committed) {
      const userId = await resolveUserId(req, deps.store);
      const line: TurnHistoryLine = {
        formatVersion: 1,
        roomId: req.roomId,
        turnId: committed.turnId,
        committedSeq: committed.seq,
        actorId: req.actorId,
        ...(userId ? { userId } : {}),
        ...(req.clientTurnId ? { clientTurnId: req.clientTurnId } : {}),
        input: req.input,
        narrative,
        speakers: [],
        facts,
        createdAt: now(),
      };
      try {
        await deps.history.append(line);
      } catch (e) {
        warn("回合历史写入失败（回合已提交，不阻塞响应）", e);
      }
      if (userId) {
        try {
          await deps.saves.touch(userId, req.roomId, committed.turnId, committed.seq);
        } catch (e) {
          warn("存档索引更新失败（回合已提交，不阻塞响应）", e);
        }
      }
    }
  }
}

/** 账号兜底：单机房间的成员表里有 userId（3.1.0 起），与 Turn 的解析口径一致 */
async function resolveUserId(req: TurnRequest, store: Store): Promise<string | undefined> {
  if (req.userId) return req.userId;
  try {
    const state = await store.snapshot(req.roomId);
    return state.room.members.find((member) => member.actorId === req.actorId)?.userId;
  } catch {
    return undefined;
  }
}
