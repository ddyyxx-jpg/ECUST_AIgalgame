import type { FileStore } from "../../../packages/engine/src/index.ts";

/** 后台扫描逐房处理。一个房间的 I/O 或任务失败不会跳过其余房间。 */
export async function scanRoomJobs(
  store: Pick<FileStore, "listRooms" | "load">, excludedRoom: string, name: string, run: (roomId: string) => Promise<unknown>,
): Promise<void> {
  try {
    for (const roomId of await store.listRooms()) {
      if (roomId === excludedRoom) continue;
      try {
        // 部分任务直接读内存投影，因此先经过存档的可读性检查。
        await store.load(roomId);
        await run(roomId);
      } catch (error) {
        console.warn(`[${name}] 房间 ${roomId} 后台任务失败：`, error instanceof Error ? error.message : error);
      }
    }
  } catch (error) {
    console.warn(`[${name}] 读取后台扫描房间列表失败：`, error instanceof Error ? error.message : error);
  }
}
