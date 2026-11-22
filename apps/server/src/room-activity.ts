/**
 * 房间活动计数（D22 并发门禁）：玩家回合 / 对话回合执行期间标记房间忙，
 * 自动时钟与手动地图 tick 看到忙就跳过或拒绝，避免时间推进插进玩家回合。
 *
 * 为什么不用 MapService 的 tickQueues：那条队列只串行 tick 自己；Turn / Dialogue
 * 走的是另一条链路（routes 的 serializeTurn），两边互不知情。这里用一把轻量计数
 * 把"玩家正在写状态"广播给时钟与 tick，锁的范围只覆盖回合执行期，不覆盖排队等待。
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

  isBusy(roomId: string): boolean {
    return (this.active.get(roomId) ?? 0) > 0;
  }
}
