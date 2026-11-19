/**
 * 图鉴 / 开局剧本的只读端点（docs/03 §5.2.5、§5.2.6）。
 *
 * 为什么独立成文件而不塞进 routes.ts：这一块只依赖 store+registry，和回合/地图无关；
 * 单独成文件也让并行开发的分支尽量少在同一段代码上打架。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Registry, RoomId, Store, WorldState } from "../../../packages/shared/src/contract/types.ts";
import { buildGalleryView } from "./gallery.ts";
import type { ScenarioCatalog } from "./scenarios.ts";
import { toPublicNpcEntries } from "./scenarios.ts";

/** 与 routes.ts 的 isWorldRoom 同口径：世界层房间不是玩家房间，不对外提供玩家视图 */
const WORLD_ROOM_PREFIX = "room_world_";

export interface ViewRouteDeps {
  store: {
    snapshot(roomId: RoomId): Promise<WorldState>;
    /**
     * 房间存在性（`FileStore.listRooms`）。必须有：`snapshot` 对不存在的房间
     * 返回空 WorldState 而不抛错，靠它才能把"未知房间"判成 404 而不是 200+空图鉴。
     */
    listRooms(): Promise<RoomId[]>;
  };
  registry: Registry;
  scenarios: ScenarioCatalog;
  /** 房间授权 gate（issue #33）：拒绝时已写好响应并返回 false；缺省 = 不做成员校验（单元测试替身） */
  authorize?: (req: FastifyRequest, reply: FastifyReply, roomId: string) => Promise<boolean>;
  /** npcId → 外貌描述（未认识时的占位名） */
  appearance?: Map<string, string>;
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ ok: false, code: "E_ROOM_NOT_FOUND", message: "房间不存在" });
}

export function registerViewRoutes(app: FastifyInstance, deps: ViewRouteDeps): void {
  // ---------------------------------------------------------------- 开局剧本（内容数据，§5.2.6）
  /** 只读内容下发：开局文案 + NPC 公开字段（id/appearance）；完整档案只在 /gallery 且 met 时给（issue #54） */
  app.get("/api/v1/scenarios", async () => ({
    ok: true,
    openings: deps.scenarios.openings,
    npcs: toPublicNpcEntries(deps.scenarios.npcs),
  }));

  // ---------------------------------------------------------------- 图鉴（服务端 View，§5.2.5）
  /** 按 registry 的 visibility 口径生成读数；secret 只给分档，绝不回精确值 */
  app.get("/api/v1/rooms/:roomId/gallery", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    // 世界层先判：它的 id 也不会出现在 listRooms 里，但明确区分"不是玩家房间"
    if (roomId.startsWith(WORLD_ROOM_PREFIX)) return notFound(reply);

    let rooms: RoomId[];
    try {
      rooms = await deps.store.listRooms();
    } catch (e) {
      // listRooms 失败是存储故障，不是"房间不存在"；折叠成 404 会让客户端误清房间指针
      console.error("[view] 读取房间列表失败", e);
      return reply.code(503).send({ ok: false, code: "E_STORE_FAULT", message: "房间列表读取失败，请稍后重试" });
    }
    if (!rooms.includes(roomId)) return notFound(reply);

    if (deps.authorize && !(await deps.authorize(req, reply, roomId))) return reply;

    let state: WorldState;
    try {
      state = await deps.store.snapshot(roomId);
    } catch (e) {
      // 房间已由 listRooms 证实存在：这里再失败是存档损坏/IO 故障，不能报"房间不存在"
      console.error(`[view] 读取房间状态失败：${roomId}`, e);
      return reply.code(503).send({ ok: false, code: "E_STORE_FAULT", message: "房间状态读取失败，请稍后重试" });
    }
    return {
      ok: true,
      gallery: buildGalleryView({ roomId, state, registry: deps.registry, profiles: deps.scenarios.npcs, appearance: deps.appearance }),
    };
  });
}
