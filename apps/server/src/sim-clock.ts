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

export class SimClock {
  private timer?: NodeJS.Timeout;
  private beating = false;
  /** 跨拍仍在跑的 tick：超时只停止等待，不取消底层 Promise；下次拍必须跳过同一房间。 */
  private readonly running = new Map<string, Promise<SimClockTickResult>>();
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
          try {
            const state = await this.deps.store.snapshot(roomId);
            const roomLeft = this.policy.maxTick > 0 ? this.policy.maxTick - state.clock.tick : Number.POSITIVE_INFINITY;
            if (roomLeft <= 0) continue;
            if (this.deps.beforeTick) {
              try {
                await this.deps.beforeTick(roomId);
              } catch (e) {
                this.warn(`[sim-clock] 房间 ${roomId} 决策失败，本拍继续推进：${e instanceof Error ? e.message : String(e)}`);
              }
            }
            const ticks = Math.min(this.policy.ticksPerBeat, roomLeft);
            const result = await this.tickRoom(roomId, ticks);
            if (result === undefined) {
              this.warn(`[sim-clock] 房间 ${roomId} 推进超时（${this.deps.roomTimeoutMs ?? 30_000}ms），本拍跳过`);
            } else if (!result.ok) {
              this.warn(`[sim-clock] 房间 ${roomId} 推进被拒：${result.code ?? "E_UNKNOWN"} ${result.message ?? ""}`.trim());
            }
          } finally {
            release?.();
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

  private async tickRoom(roomId: string, ticks: number): Promise<SimClockTickResult | undefined> {
    const underlying = this.deps.map.tick(roomId, { ticks });
    this.running.set(roomId, underlying);
    // 底层 Promise 结束后才释放占位；超时只结束等待，不释放，避免下一拍重复排队。
    const release = () => {
      if (this.running.get(roomId) === underlying) this.running.delete(roomId);
    };
    void underlying.then(release, release);

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), this.deps.roomTimeoutMs ?? 30_000);
      timer.unref?.();
    });
    try {
      return await Promise.race([underlying, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
