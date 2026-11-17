/**
 * 图鉴 / 开局剧本的只读端点（docs/03 §5.2.5、§5.2.6）。
 *
 * 为什么独立成文件而不塞进 routes.ts：这一块只依赖 store+registry，和回合/地图无关；
 * 单独成文件也让并行开发的分支尽量少在同一段代码上打架。
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Registry, Store } from "../../../packages/shared/src/contract/types.ts";
import { buildGalleryView } from "./gallery.ts";
import type { ScenarioCatalog } from "./scenarios.ts";

/** 与 routes.ts 的 isWorldRoom 同口径：世界层房间不是玩家房间，不对外提供玩家视图 */
const WORLD_ROOM_PREFIX = "room_world_";

export interface ViewRouteDeps {
  store: Pick<Store, "snapshot">;
  registry: Registry;
  scenarios: ScenarioCatalog;
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ ok: false, code: "E_ROOM_NOT_FOUND", message: "房间不存在" });
}

export function registerViewRoutes(app: FastifyInstance, deps: ViewRouteDeps): void {
  // ---------------------------------------------------------------- 开局剧本（内容数据，§5.2.6）
  /** 只读内容下发：开局文案 + NPC 公开档案；前端不再硬编码（issue #3） */
  app.get("/api/v1/scenarios", async () => ({
    ok: true,
    openings: deps.scenarios.openings,
    npcs: deps.scenarios.npcs,
  }));

  // ---------------------------------------------------------------- 图鉴（服务端 View，§5.2.5）
  /** 按 registry 的 visibility 口径生成读数；secret 只给分档，绝不回精确值 */
  app.get("/api/v1/rooms/:roomId/gallery", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    if (roomId.startsWith(WORLD_ROOM_PREFIX)) return notFound(reply);
    let state;
    try {
      state = await deps.store.snapshot(roomId);
    } catch {
      return notFound(reply);
    }
    return {
      ok: true,
      gallery: buildGalleryView({ roomId, state, registry: deps.registry, profiles: deps.scenarios.npcs }),
    };
  });
}
