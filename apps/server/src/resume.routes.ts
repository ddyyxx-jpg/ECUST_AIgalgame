/**
 * 续玩/存档端点（issue #7）：
 *   GET    /api/v1/me/saves                本人存档索引
 *   DELETE /api/v1/me/saves/:roomId        只删索引，不删房间
 *   GET    /api/v1/rooms/:roomId/history   本房成员可读的已提交回合历史
 *
 * 单独成文件：routes.ts 同时被另一个分支改动，新增端点集中在一个区块里减少冲突。
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { WorldState } from "../../../packages/shared/src/contract/types.ts";
import type { AppDeps } from "./routes.ts";

/** 从 routes.ts 注入，避免 routes ↔ resume.routes 的运行时循环依赖 */
export interface ResumeRouteHelpers {
  userIdOf(req: Parameters<typeof import("./routes.ts").userIdOf>[0], deps: AppDeps): string | undefined;
  isWorldRoom(roomId: string): boolean;
  /** 房间存在性（issue #37）：以持久化事实判定，避免 snapshot 对缺失房间返回空状态 */
  roomExists(roomId: string): Promise<boolean>;
}

function missingUser(reply: FastifyReply) {
  return reply.code(400).send({ ok: false, code: "E_SCHEMA_INVALID", message: "缺少 X-User-Id（或 GALGAME_DEV_USER）" });
}

export function registerResumeRoutes(app: FastifyInstance, deps: AppDeps, helpers: ResumeRouteHelpers): void {
  const { userIdOf, isWorldRoom, roomExists } = helpers;
  app.get("/api/v1/me/saves", async (req, reply) => {
    const userId = userIdOf(req, deps);
    if (!userId) return missingUser(reply);
    const saves = deps.saves ? await deps.saves.list(userId) : [];
    return { ok: true, userId, saves };
  });

  app.delete("/api/v1/me/saves/:roomId", async (req, reply) => {
    const userId = userIdOf(req, deps);
    if (!userId) return missingUser(reply);
    const { roomId } = req.params as { roomId?: string };
    if (!roomId) return reply.code(400).send({ ok: false, code: "E_SCHEMA_INVALID", message: "roomId 必填" });
    // 只删索引：房间的事件日志与历史都保留，玩家还能靠 roomId 回去
    const removed = deps.saves ? await deps.saves.remove(userId, roomId) : false;
    return { ok: true, roomId, removed };
  });

  app.get("/api/v1/rooms/:roomId/history", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    if (isWorldRoom(roomId)) {
      return reply.code(404).send({ ok: false, code: "E_ROOM_NOT_FOUND", message: "世界层房间没有可恢复的对话历史" });
    }
    if (!(await roomExists(roomId))) {
      return reply.code(404).send({ ok: false, code: "E_ROOM_NOT_FOUND", message: "房间不存在" });
    }

    // 权限：本房成员可读。老房间（3.1 之前建房、成员表没有 userId）退化为"可读"，
    // 与 /state 的开放程度一致；世界层房间已在上面挡掉。
    let state: WorldState;
    try {
      state = await deps.store.snapshot(roomId);
    } catch {
      return reply.code(404).send({ ok: false, code: "E_ROOM_NOT_FOUND", message: "房间不存在或事件日志不可读" });
    }
    const owners = state.room.members.flatMap((member) => (member.userId ? [member.userId] : []));
    const userId = userIdOf(req, deps);
    if (owners.length > 0 && (!userId || !owners.includes(userId))) {
      return reply.code(403).send({ ok: false, code: "E_FORBIDDEN", message: "只有本房间成员可以读取历史" });
    }

    const query = req.query as { fromTurn?: string; limit?: string };
    const limit = Number(query.limit ?? 50);
    const page = deps.history
      ? await deps.history.list(roomId, {
          ...(query.fromTurn ? { fromTurn: query.fromTurn } : {}),
          limit: Number.isFinite(limit) ? limit : 50,
        })
      : { lines: [], lastCommittedSeq: 0 };
    // userId 只落盘用于归属/审计，不下发：合作房间里不向他人暴露账号 id
    const history = page.lines.map((line) => {
      const { userId: _owner, ...rest } = line;
      return rest;
    });
    return { ok: true, roomId, history, lastCommittedSeq: page.lastCommittedSeq };
  });
}
