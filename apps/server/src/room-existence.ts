/**
 * 房间存在性统一预检（issue #37）。
 *
 * 为什么不能用 `snapshot` 成功当"房间存在"：`FileStore.snapshot` 对未知 roomId
 * 会返回初始 WorldState 而不抛错，于是 state/map/tick 拿到空状态后还会写出
 * "幽灵存档"（无 seed/members 的事件日志）。存在性只认持久化的事实——
 * `FileStore.listRooms()` 扫 `data/rooms/*.jsonl`。
 *
 * 这里只判"房间在不在"，不判"谁能访问"：鉴权（账号/成员/令牌）由调用方或
 * 另一层负责，两者不要混在一个检查里。
 */
import type { FastifyReply } from "fastify";

const WORLD_ROOM_PREFIX = "room_world_";

/** 测试替身可能只实现 Store 的四个必选方法，listRooms 是 FileStore/InMemoryStore 的实现细节 */
type RoomLister = { listRooms?: () => Promise<string[]> };

/** 世界层房间是永久记忆存储，不是玩家房间；保留既有边界语义 */
export function isWorldRoom(roomId: string): boolean {
  return roomId.startsWith(WORLD_ROOM_PREFIX);
}

export function roomNotFound(reply: FastifyReply, message = "房间不存在") {
  return reply.code(404).send({ ok: false, code: "E_ROOM_NOT_FOUND", message });
}

/**
 * 未知房间 / 世界层 / 列表读取失败一律 false（fail-closed）。
 * 明确不读 snapshot：空投影不等于房间存在。
 */
export async function roomExists(store: object, roomId: string): Promise<boolean> {
  if (isWorldRoom(roomId)) return false;
  const lister = store as RoomLister;
  if (typeof lister.listRooms !== "function") return false;
  try {
    const rooms = await lister.listRooms.call(store);
    return Array.isArray(rooms) && rooms.includes(roomId);
  } catch {
    return false;
  }
}

/** 路由用：存在性预检失败时已经写过 404 响应，调用方直接 `return` */
export async function requireExistingRoom(
  reply: FastifyReply,
  store: object,
  roomId: string,
  opts?: { worldMessage?: string; message?: string },
): Promise<boolean> {
  if (isWorldRoom(roomId)) {
    roomNotFound(reply, opts?.worldMessage ?? "房间不存在");
    return false;
  }
  if (!(await roomExists(store, roomId))) {
    roomNotFound(reply, opts?.message ?? "房间不存在");
    return false;
  }
  return true;
}
