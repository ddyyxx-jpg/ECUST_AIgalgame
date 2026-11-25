/**
 * 房间活动计数（D22 并发门禁）：玩家回合 / 对话回合执行期间标记房间忙，
 * 自动时钟与手动地图 tick 看到忙就跳过或拒绝，避免时间推进插进玩家回合。
 *
 * 为什么不用 MapService 的 tickQueues：那条队列只串行 tick 自己；Turn / Dialogue
 * 走的是另一条链路（routes 的 serializeTurn），两边互不知情。这里用一把轻量计数
 * 把"玩家正在写状态"广播给时钟与 tick。玩家回合用 acquire 等待，时钟用 tryAcquire
 * 拿不到就跳过；锁的范围只覆盖执行期，不覆盖排队等待。
 */
export class RoomBusyError extends Error {
  constructor(roomId: string, message = `房间 ${roomId} 正在推进时间，请稍后重试`) {
    super(message);
    this.name = "RoomBusyError";
  }
}

export class RoomActivity {
  private readonly active = new Map<string, number>();
  /** 房间空闲时要唤醒的等待者；释放到 0 时一次性唤醒。 */
  private readonly waiters = new Map<string, Array<() => void>>();
  /** 最近一次有玩家请求进入该房间的时间（墙钟）；给后台任务判断"死房间"用。 */
  private readonly lastTouch = new Map<string, number>();

  /** 只记活跃、不占忙标记（读接口用：玩家在地图上看着，后台就该继续跑）。 */
  touch(roomId: string): void {
    this.lastTouch.set(roomId, Date.now());
  }

  /** 最近一次玩家进入该房间的时间；从未进入过返回 undefined。 */
  lastTouchedAt(roomId: string): number | undefined {
    return this.lastTouch.get(roomId);
  }

  /** 很久没有玩家进入过的房间：后台时钟/闲聊不该继续为它花钱。 */
  idleSince(roomId: string, ms: number): boolean {
    const at = this.lastTouch.get(roomId);
    return at === undefined || Date.now() - at > ms;
  }

  /** 标记房间进入活动；返回幂等的释放函数。 */
  enter(roomId: string): () => void {
    this.lastTouch.set(roomId, Date.now());
    this.active.set(roomId, (this.active.get(roomId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.active.get(roomId) ?? 1) - 1;
      if (next <= 0) {
        this.active.delete(roomId);
        // 唤醒所有等待者；它们会自行重试 enter（多人竞争时只有一个真正拿到）。
        const waiting = this.waiters.get(roomId);
        if (waiting) {
          this.waiters.delete(roomId);
          for (const wake of waiting) wake();
        }
      } else this.active.set(roomId, next);
    };
  }

  /**
   * 玩家回合用：等到房间空闲再进入。返回的释放函数与 enter 相同。
   * 自动时钟用 tryAcquire：拿不到就跳过本拍，绝不等待。
   */
  async acquire(roomId: string, timeoutMs = 30_000, signal?: AbortSignal): Promise<() => void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) throw new RoomBusyError(roomId, `房间 ${roomId} 等待已取消`);
      if (!this.isBusy(roomId)) return this.enter(roomId);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new RoomBusyError(roomId, `房间 ${roomId} 正在推进时间，等待超时，请稍后重试`);
      }
      await this.waitForRelease(roomId, remaining, signal);
    }
  }

  /** 等房间释放（或超时/取消）；不轮询，释放时由 enter 的释放函数唤醒。 */
  private waitForRelease(roomId: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const done = (err?: Error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const list = this.waiters.get(roomId);
        if (list) {
          const i = list.indexOf(done);
          if (i >= 0) list.splice(i, 1);
          if (list.length === 0) this.waiters.delete(roomId);
        }
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(
        () => done(new RoomBusyError(roomId, `房间 ${roomId} 正在推进时间，等待超时，请稍后重试`)),
        ms,
      );
      timer.unref?.();
      const onAbort = () => done(new RoomBusyError(roomId, `房间 ${roomId} 等待已取消`));
      const list = this.waiters.get(roomId) ?? [];
      list.push(done);
      this.waiters.set(roomId, list);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** 非阻塞获取；房间忙时返回 null。 */
  tryAcquire(roomId: string): (() => void) | null {
    if (this.isBusy(roomId)) return null;
    return this.enter(roomId);
  }

  isBusy(roomId: string): boolean {
    return (this.active.get(roomId) ?? 0) > 0;
  }
}
