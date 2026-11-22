/**
 * 房间活动计数（D22 并发门禁）：玩家回合 / 对话回合执行期间标记房间忙，
 * 自动时钟与手动地图 tick 看到忙就跳过或拒绝，避免时间推进插进玩家回合。
 *
 * 为什么不用 MapService 的 tickQueues：那条队列只串行 tick 自己；Turn / Dialogue
 * 走的是另一条链路（routes 的 serializeTurn），两边互不知情。这里用一把轻量计数
 * 把"玩家正在写状态"广播给时钟与 tick。玩家回合用 acquire 等待，时钟用 tryAcquire
 * 拿不到就跳过；锁的范围只覆盖执行期，不覆盖排队等待。
 */
export class RoomActivity {
  private readonly active = new Map<string, number>();

  /** 标记房间进入活动；返回幂等的释放函数。 */
  enter(roomId: string): () => void {
    this.active.set(roomId, (this.active.get(roomId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.active.get(roomId) ?? 1) - 1;
      if (next <= 0) this.active.delete(roomId);
      else this.active.set(roomId, next);
    };
  }

  /**
   * 玩家回合用：等到房间空闲再进入。返回的释放函数与 enter 相同。
   * 自动时钟用 tryAcquire：拿不到就跳过本拍，绝不等待。
   */
  async acquire(roomId: string): Promise<() => void> {
    while (this.isBusy(roomId)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return this.enter(roomId);
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
