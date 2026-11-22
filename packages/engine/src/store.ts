/**
 * Store：事件日志 + 投影缓存。世界状态不是被"改"出来的，而是把日志折出来的。
 * 因此 snapshot/replay 是同一个函数的两条路径 —— 这是 determinism 的来源。
 *
 * `EventLog` 比契约里的 `Store` 多几个方法，只给 Arbiter / Turn 用（Arbiter 是唯一写入口）。
 * 外部（HTTP / modules / web）只应该拿到 `Store`，看不到 append。
 *
 * 持久化的两个硬约束（Issue #1 复审 BLOCKER-1 / MAJOR-1）：
 *  1. **写盘先行**：先成功落盘，再改内存。写盘失败 → 内存、seq 都不变，调用方按失败处理并重试，
 *     不会出现"客户端收到错误、服务端状态已经变了"的裂脑。
 *  2. **读取前先载入**：`load()` 是唯一的读入口保证；`seq()` 在未载入时返回 0 只是内存视图，
 *     不要拿它做 expectedSeq 校验（重启后第一回合会假报 E_SEQ_GAP）。
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Envelope, RoomId, Store, WorldState } from "../../shared/src/contract/types.ts";
import { applyEvent, createInitialState } from "./projection.ts";
import { decodeRoomLog, projectRoomEvents } from "./room-log.ts";
import { RoomLogWriter, RoomStorageBlockedError, StoreCommitUnknownError } from "./store-write.ts";

export interface StoreOptions {
  worldId?: string;
  locId?: string;
}

/**
 * roomId 会直接进入文件路径（`<dir>/<roomId>.jsonl`），因此必须是纯 id：
 * 字母/数字/下划线/连字符，1~80 字符。禁止 `/`、`\`、`.` 等路径字符，
 * 防止 `..%2F..%2F` 这类 URL 解码后穿越出数据目录。
 * HTTP 层还会再做一次校验（preHandler），这里保留第二道防线。
 */
const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
export function isSafeRoomId(roomId: string): boolean {
  return ROOM_ID_RE.test(roomId);
}

export interface EventLog extends Store {
  /** 确保房间已从持久层载入（内存实现是 no-op），返回载入后的最新 seq（0 = 空房间） */
  load(roomId: RoomId): Promise<number>;
  /** 内存视图里的最新 seq。**未 load 前不可信**（文件实现此时返回 0） */
  seq(roomId: RoomId): number;
  /** 同步视图；返回的对象是内部状态，调用方不得修改（要改就用 snapshot） */
  state(roomId: RoomId): WorldState;
  /**
   * 追加事件并逐条投影。内存实现同步返回；文件实现返回 Promise，**写盘成功后才改内存**。
   * seq 必须连续，不连续说明有第二个写入口（bug）。
   */
  append(roomId: RoomId, envs: Envelope[]): void | Promise<void>;
}

export class EventSourcedStore implements EventLog {
  protected readonly logs = new Map<RoomId, Envelope[]>();
  protected readonly states = new Map<RoomId, WorldState>();
  protected readonly opts: StoreOptions;

  constructor(opts: StoreOptions = {}) {
    this.opts = opts;
  }

  protected initial(roomId: RoomId): WorldState {
    return createInitialState(roomId, { worldId: this.opts.worldId, locId: this.opts.locId });
  }

  state(roomId: RoomId): WorldState {
    let s = this.states.get(roomId);
    if (!s) {
      s = this.initial(roomId);
      this.states.set(roomId, s);
    }
    return s;
  }

  seq(roomId: RoomId): number {
    const log = this.logs.get(roomId);
    return log && log.length ? (log[log.length - 1]?.seq ?? 0) : 0;
  }

  /** 内存实现：数据本来就在内存里，载入是 no-op */
  async load(roomId: RoomId): Promise<number> {
    return this.seq(roomId);
  }

  async flush(_roomId: RoomId): Promise<void> {
    // 纯内存：没有更持久的地方可等
  }

  async snapshot(roomId: RoomId): Promise<WorldState> {
    return structuredClone(this.state(roomId));
  }

  /** 已知房间列表（启动重建记忆索引时用；文件实现扫目录） */
  async listRooms(): Promise<RoomId[]> {
    return [...this.logs.keys()];
  }

  async events(roomId: RoomId, fromSeq: number, limit = Number.POSITIVE_INFINITY): Promise<Envelope[]> {
    const log = this.logs.get(roomId) ?? [];
    return log.filter((e) => e.seq >= fromSeq).slice(0, limit);
  }

  async replay(roomId: RoomId, toSeq?: number): Promise<WorldState> {
    const log = this.logs.get(roomId) ?? [];
    let state = this.initial(roomId);
    for (const env of log) {
      if (toSeq !== undefined && env.seq > toSeq) break;
      state = applyEvent(state, env);
    }
    return state;
  }

  /** 只改内存、不碰持久层；`append` 与持久化实现的"载入"都走它 */
  protected appendMemory(roomId: RoomId, envs: Envelope[]): void {
    if (envs.length === 0) return;
    const log = this.logs.get(roomId) ?? [];
    this.logs.set(roomId, log);
    let state = this.state(roomId);
    for (const env of envs) {
      const expected = (log[log.length - 1]?.seq ?? 0) + 1;
      if (env.seq !== expected) {
        throw new Error(`E_SEQ_GAP: room=${roomId} expected seq ${expected}, got ${env.seq}`);
      }
      log.push(env);
      state = applyEvent(state, env);
    }
    this.states.set(roomId, state);
  }

  append(roomId: RoomId, envs: Envelope[]): void {
    this.appendMemory(roomId, envs);
  }
}

/**
 * 文件版：每房间一个 JSONL（一行一个 Envelope）。
 *
 * 每次提交整份重写（O(n)），同步新文件后替换原日志，再同步目录。
 */
export class FileStore extends EventSourcedStore {
  private readonly loaded = new Set<RoomId>();
  private readonly loading = new Map<RoomId, Promise<void>>();
  private readonly writes = new Map<RoomId, Promise<void>>();
  private readonly dir: string;
  private readonly writer: RoomLogWriter;
  private readonly uncertain = new Map<RoomId, RoomStorageBlockedError>();

  constructor(dir = path.join(process.cwd(), "data", "rooms"), opts: StoreOptions = {}) {
    super(opts);
    this.dir = dir;
    this.writer = new RoomLogWriter(dir);
  }

  private file(roomId: RoomId): string {
    if (!isSafeRoomId(roomId)) {
      // 不把原始输入拼进路径；错误码与路由层保持一致
      throw Object.assign(new Error("非法 roomId（只允许 [A-Za-z0-9_-]{1,80}）"), { code: "E_SCHEMA_INVALID" });
    }
    return path.join(this.dir, `${roomId}.jsonl`);
  }

  /** 读取前先载入：所有读接口都经过这里，杜绝"用未载入的 seq 做校验" */
  override async load(roomId: RoomId): Promise<number> {
    await this.ensure(roomId);
    return this.seq(roomId);
  }

  private ensure(roomId: RoomId): Promise<void> {
    const failure = this.uncertain.get(roomId);
    if (failure) return Promise.reject(failure);
    if (this.loaded.has(roomId)) return Promise.resolve();
    const inflight = this.loading.get(roomId);
    if (inflight) return inflight;
    const task = this.readLog(roomId).finally(() => this.loading.delete(roomId));
    this.loading.set(roomId, task);
    return task;
  }

  /** 坏档保留在原位置，仅在整份日志校验与投影成功后发布缓存。 */
  private async readLog(roomId: RoomId): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.file(roomId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.loaded.add(roomId);
      return;
    }
    const events = decodeRoomLog(text, roomId);
    const state = projectRoomEvents(this.initial(roomId), events);
    if (events.length > 0) this.logs.set(roomId, events);
    this.states.set(roomId, state);
    this.loaded.add(roomId);
  }

  private async writeAll(roomId: RoomId, envs: Envelope[]): Promise<void> {
    try {
      await this.writer.write(this.file(roomId), envs);
    } catch (error) {
      if (error instanceof StoreCommitUnknownError) {
        // 原文件可能已被替换，封住该房间，避免用内存里的旧投影继续结算。
        this.uncertain.set(roomId, new RoomStorageBlockedError(error));
        console.error(`[store] 房间 ${roomId} 的提交结果待核对`, error.cause);
      }
      throw error;
    }
  }

  override append(roomId: RoomId, envs: Envelope[]): Promise<void> {
    if (envs.length === 0) return Promise.resolve();
    const prev = this.writes.get(roomId) ?? Promise.resolve();
    const next = prev.then(async () => {
      await this.ensure(roomId);
      const expected = this.seq(roomId) + 1;
      envs.forEach((env, i) => {
        if (env.seq !== expected + i) {
          throw new Error(`E_SEQ_GAP: room=${roomId} expected seq ${expected + i}, got ${env.seq}`);
        }
      });
      const all = [...(this.logs.get(roomId) ?? []), ...envs];
      await this.writeAll(roomId, all);
      this.appendMemory(roomId, envs);
    });
    // 链上保留一个"永不 reject"的尾，避免一次失败卡死后续提交；真正的错误返回给本次调用方
    this.writes.set(roomId, next.then(() => undefined, () => undefined));
    return next;
  }

  /** 只等队列结清；各批写入的结果由各自的 append 返回。 */
  override async flush(roomId?: RoomId): Promise<void> {
    const waits = roomId ? [this.writes.get(roomId)] : [...this.writes.values()];
    await Promise.all(waits.filter((p): p is Promise<void> => !!p));
  }

  override async snapshot(roomId: RoomId): Promise<WorldState> {
    await this.ensure(roomId);
    return super.snapshot(roomId);
  }

  /** 扫描 data/rooms/*.jsonl：重启后要把这些房间的记忆索引一起重建（审阅 P0-1/P0-3） */
  override async listRooms(): Promise<RoomId[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return names
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => n.slice(0, -".jsonl".length))
      .filter(isSafeRoomId)
      .sort();
  }

  override async events(roomId: RoomId, fromSeq: number, limit?: number): Promise<Envelope[]> {
    await this.ensure(roomId);
    return super.events(roomId, fromSeq, limit);
  }

  override async replay(roomId: RoomId, toSeq?: number): Promise<WorldState> {
    await this.ensure(roomId);
    return super.replay(roomId, toSeq);
  }
}
