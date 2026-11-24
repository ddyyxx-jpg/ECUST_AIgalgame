/**
 * 自动时钟（D22）：只按 `ticks` 推进当前 phase 内的时间刻度，**绝不切 phase**。
 * - 默认关闭（content/sim/policy.json 的 clock.enabled=false），不启动定时器；
 * - 每拍对每个房间串行调用 MapService.tick({ticks})；单房间失败/超时只跳过本房间；
 * - 到达 maxTick 就停，等玩家主动 advance（自动推进不替玩家做跨阶段决定）；
 * - 后台任务（八卦/密谋等）占用房间时跳过，避免两套时间同时写同一房间。
 */
import type { SimClockPolicy } from "./sim.policy.ts";

export interface SimClockStore {
  listRooms(): Promise<string[]>;
  snapshot(roomId: string): Promise<{ clock: { tick: number } }>;
}

export interface SimClockTickResult {
  ok: boolean;
  code?: string;
  message?: string;
}

export interface SimClockMap {
  tick(roomId: string, opts: { ticks: number }): Promise<SimClockTickResult>;
}

export interface SimClockDeps {
  store: SimClockStore;
  map: SimClockMap;
  policy: SimClockPolicy;
  isBusy?: (roomId: string) => boolean;
  /** 非阻塞抢房间锁；返回 null 表示本拍跳过。不传则退回只查 isBusy。 */
  acquire?: (roomId: string) => (() => void) | null;
  /** 每次 tick 前跑一次（NPC 自由活动决策）；失败只 warn，不阻断本拍时间推进。 */
  beforeTick?: (roomId: string) => Promise<void>;
  warn?: (message: string) => void;
  /** 单房间推进超时；防止一个卡死的房间拖住整条时钟 */
  roomTimeoutMs?: number;
}

const BEFORE_TICK_TIMEOUT = Symbol("beforeTick-timeout");

export class SimClock {
  private timer?: NodeJS.Timeout;
  private beating = false;
  /** 跨拍仍在跑的 tick：超时只停止等待，不取消底层 Promise；下次拍必须跳过同一房间。 */
  private readonly running = new Map<string, Promise<SimClockTickResult>>();
  /** 已超时但底层仍未结束的房间：用于告警“锁了多久”，只读不参与调度。 */
  private readonly stuckSince = new Map<string, number>();
  private stuckTicks = 0;
  private readonly policy: SimClockPolicy;
  private readonly warn: (message: string) => void;

  constructor(private readonly deps: SimClockDeps) {
    this.policy = deps.policy;
    this.warn = deps.warn ?? ((m) => console.warn(m));
  }

  start(): void {
    if (!this.policy.enabled || this.policy.intervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => void this.beat(), this.policy.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // 进程关停时清掉“卡死房间”快照；底层 tick 若还在写由进程退出兜底，
    // 不能把上一轮的锁状态留给下一次启动/健康检查。
    this.stuckSince.clear();
    this.stuckTicks = 0;
  }

  /** 给可能挂起的异步步骤加上限；超时返回哨兵，不取消底层（它自己会超时/失败）。 */
  private async withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof BEFORE_TICK_TIMEOUT> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof BEFORE_TICK_TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(BEFORE_TICK_TIMEOUT), ms);
      timer.unref?.();
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 当前仍被卡死 tick 占用的房间与已锁时长，供运维告警/健康检查读取。 */
  stuckRooms(): Array<{ roomId: string; lockedMs: number }> {
    const now = Date.now();
    return [...this.stuckSince].map(([roomId, since]) => ({ roomId, lockedMs: now - since }));
  }

  /** 运维遥测：永久锁房间 + 累计卡死拍数（供 /health 或外部探针读取，不必捞 stdout）。 */
  telemetry(): { stuckRooms: Array<{ roomId: string; lockedMs: number }>; stuckTicks: number } {
    return { stuckRooms: this.stuckRooms(), stuckTicks: this.stuckTicks };
  }

  /** 单飞：上一拍没跑完就跳过本拍，避免房间队列被叠满 */
  async beat(): Promise<void> {
    if (this.beating) return;
    this.beating = true;
    try {
      const rooms = await this.deps.store.listRooms();
      for (const roomId of rooms) {
        // 单房间失败只跳过本房间：一个坏档不能拖住其他房间的时钟。
        try {
          if (this.running.has(roomId)) continue;
          if (this.deps.isBusy?.(roomId)) continue;
          // 先抢房间锁：玩家回合正在执行时直接跳过，绝不与回合交错；拿到锁后
          // beforeTick 与 map.tick 都在锁内，玩家回合会在 acquire 处等本拍结束。
          const release = this.deps.acquire?.(roomId);
          if (this.deps.acquire && !release) continue;
          let handedToTick = false;
          try {
            const state = await this.deps.store.snapshot(roomId);
            const roomLeft = this.policy.maxTick > 0 ? this.policy.maxTick - state.clock.tick : Number.POSITIVE_INFINITY;
            if (roomLeft <= 0) continue;
            if (this.deps.beforeTick) {
              // 决策本身可能调 LLM：必须有上限，否则它一挂，beating 永远不复位，整个时钟停摆。
              const budget = this.deps.roomTimeoutMs ?? 30_000;
              const outcome = await this.withTimeout(
                this.deps.beforeTick(roomId).then(
                  () => undefined,
                  (e: unknown) => e,
                ),
                budget,
              );
              if (outcome === BEFORE_TICK_TIMEOUT) {
                this.warn(`[sim-clock] 房间 ${roomId} 决策超过 ${budget}ms 未返回，本拍放弃决策、直接推进时间`);
              } else if (outcome !== undefined) {
                const message = outcome instanceof Error ? outcome.message : String(outcome);
                this.warn(`[sim-clock] 房间 ${roomId} 决策失败，本拍继续推进：${message}`);
              }
            }
            const ticks = Math.min(this.policy.ticksPerBeat, roomLeft);
            const result = await this.tickRoom(roomId, ticks, release ?? undefined);
            handedToTick = release !== undefined;
            if (result === undefined) {
              this.warn(`[sim-clock] 房间 ${roomId} 推进超时（${this.deps.roomTimeoutMs ?? 30_000}ms），本拍跳过`);
            } else if (!result.ok) {
              this.warn(`[sim-clock] 房间 ${roomId} 推进被拒：${result.code ?? "E_UNKNOWN"} ${result.message ?? ""}`.trim());
            }
          } finally {
            // 已交给 tickRoom 的锁由底层 map.tick settle 后释放；超时只结束等待，
            // 不能在 finally 里提前放锁，否则玩家回合会插进仍在写的 tick。
            if (!handedToTick) release?.();
          }
        } catch (e) {
          this.warn(`[sim-clock] 房间 ${roomId} 推进失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      this.warn(`[sim-clock] 自动推进失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.beating = false;
    }
  }

  private async tickRoom(
    roomId: string,
    ticks: number,
    releaseLock?: () => void,
  ): Promise<SimClockTickResult | undefined> {
    const underlying = this.deps.map.tick(roomId, { ticks });
    this.running.set(roomId, underlying);
    const timeoutMs = this.deps.roomTimeoutMs ?? 30_000;
    let released = false;
    // 底层 Promise 真正结束后才释放占位与房间锁。等待超时只让本次 beat 返回，
    // 不释放锁：否则底层 arbiter 还在写 EventLog 时玩家回合就能进来，两边同时写。
    const settle = () => {
      if (released) return;
      released = true;
      if (this.running.get(roomId) === underlying) this.running.delete(roomId);
      releaseLock?.();
      const stuckAt = this.stuckSince.get(roomId);
      if (stuckAt !== undefined) {
        this.stuckSince.delete(roomId);
        this.warn(`[sim-clock] 房间 ${roomId} 底层 tick 已结束，释放房间锁定（锁定 ${Date.now() - stuckAt}ms）`);
      }
    };
    void underlying.then(settle, settle);

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
      timer.unref?.();
    });
    let result: SimClockTickResult | undefined;
    try {
      result = await Promise.race([underlying, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (result === undefined) {
      // 不强制放锁：宁可让该房间后续回合/推进拿到 409，也不能让两份写入交错。
      // 底层若永久不 settle，这里只告警，房间保持锁定，等运维处理。
      const firstStuck = !this.stuckSince.has(roomId);
      const since = this.stuckSince.get(roomId) ?? Date.now();
      this.stuckSince.set(roomId, since);
      // 只在“本轮首次卡死”时告警并计数：锁会一直保持到 settle，按拍重复刷日志没有信息量。
      if (firstStuck) {
        this.stuckTicks += 1;
        this.warn(
          `[sim-clock] 房间 ${roomId} 底层 tick 超过 ${timeoutMs}ms 未结束，保持房间锁定（已锁定 ${Date.now() - since}ms；simClock.telemetry() 可查）`,
        );
      }
    }
    return result;
  }
}
