/**
 * 世界层 canonize 的类型与默认限额（从 canonize.ts 拆出：类型改动频繁，实现文件保持 ≤300 行）。
 * 这里只有声明与常量，没有任何副作用。
 */
import type { Arbiter, Envelope, Id, ImpressionNotice, MemoryRecord, RoomId } from "../../shared/src/index.ts";
import type { PermanentCandidate } from "./canonize.candidates.ts";
import type { EventLog } from "./store.ts";
import type { Memory } from "../../shared/src/index.ts";

/** 引擎需要"读全部记录"来做候选聚合；`Memory` 契约只保证查询接口，故在此收窄 */
export interface MemoryIndex extends Memory {
  /** 落库后把新事件喂给索引（世界房间不进 Turn 的 sync 路径，必须由 canonize 自己同步） */
  ingest?(env: Envelope): void;
  /** 增量喂事件（admin 直接触发 canonize 时保证索引不落后于日志；幂等） */
  sync?(roomId: RoomId, envs: readonly Envelope[]): void;
  /** 重放整条房间日志（启动重建用） */
  rebuild?(roomId: RoomId, envs: readonly Envelope[]): void;
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
  /** 启动时的世界层版本（从 mem.version 读回）；不传 = 0（新世界） */
  startVersion?: number;
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
  /**
   * 协作式中止标记：调用方传入的 signal 已 abort 时为 true。
   * 此时 written 只含中止前已由 Arbiter 落库的批次，不做回滚。
   * 不传 signal 时该字段不会出现，旧调用方行为完全不变。
   */
  aborted?: true;
}

/** 协作式取消参数：不给 signal 时行为与旧签名完全一致 */
export interface CanonizeRunOptions {
  signal?: AbortSignal;
}

/**
 * P2-2：E_SEQ_GAP 有界重试上限（不含首次 attempt）。
 * 重试只在 signal 未 abort 时进行：被 stall 接管的僵尸任务体 signal 已 abort，
 * 遇到 E_SEQ_GAP 直接记错跳过，绝不重新 load 新 seq 后把自己的写入插到新世代之后。
 */
export const SEQ_GAP_MAX_RETRIES = 2;

