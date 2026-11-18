/**
 * 房间存在性判定（issue #37）：以持久化事实为准，而不是"snapshot 不抛错"。
 *
 * 背景：`FileStore.snapshot` 对不存在的房间返回空 `WorldState`（不抛错），旧实现因此把
 * 任何未知 roomId 当成 200 空房间；更糟的是 `/turns` 与 `/map/tick` 会先起 SSE / 跑模块，
 * 把"幽灵日志"写进磁盘。存在性统一走 `Store.listRooms()`（契约外的可选能力，
 * `FileStore`/`EventSourcedStore` 都已实现），测试替身缺 `listRooms` 时退化为一页事件探针。
 * 两条路径都只读：不会隐式落盘建房。
 */
import type { Store } from "../../../packages/shared/src/contract/types.ts";

type StoreWithRooms = Store & { listRooms?: () => Promise<string[]> };

export type RoomExists = (roomId: string) => Promise<boolean>;

export function makeRoomExists(store: Store): RoomExists {
  const withRooms = store as StoreWithRooms;
  if (typeof withRooms.listRooms === "function") {
    const listRooms = withRooms.listRooms.bind(store);
    return async (roomId: string) => (await listRooms()).includes(roomId);
  }
  // 内存替身（无 listRooms）：探测事件日志。建房必有种子事件，空日志按"不存在"处理。
  return async (roomId: string) => (await store.events(roomId, 0, 1)).length > 0;
}
