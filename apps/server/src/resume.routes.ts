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
import { guardRoom } from "./room-guard.ts";
import { maskNamesDeep, unknownPlaceholders } from "./view-names.ts";

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

    // 权限与其它房间端点同一 gate（issue #33）：成员可读；旧档在强制登录模式默认不开放
    const access = await guardRoom(req, reply, deps, roomId, userIdOf);
    if (!access) return reply;

    let state: WorldState;
    try {
      state = await deps.store.snapshot(roomId);
    } catch (e) {
      // guardRoom 刚刚成功读到过状态：再失败只能是存储故障，不能折叠成"房间不存在"
      console.error(`[resume] 读取房间状态失败：${roomId}`, e);
      return reply.code(503).send({ ok: false, code: "E_STORE_FAULT", message: "房间状态读取失败，请稍后重试" });
    }

    const query = req.query as { fromTurn?: string; before?: string; limit?: string };
    const limit = Number(query.limit ?? 50);
    const page = deps.history
      ? await deps.history.list(roomId, {
          ...(query.fromTurn ? { fromTurn: query.fromTurn } : {}),
          ...(query.before ? { before: query.before } : {}),
          limit: Number.isFinite(limit) ? limit : 50,
        })
      : { lines: [], lastCommittedSeq: 0, hasEarlier: false };
    // userId/clientTurnId 只落盘用于归属/审计/对账，不下发
    const history = page.lines.map((line) => {
      const { userId: _owner, clientTurnId: _logical, ...rest } = line;
      return rest;
    });
// 历史是"脱敏前"写入的原始叙事：回放时按**当前**认识状态重做一次脱敏，
    // 否则续玩/刷新就能看到尚未认识的人的真名（审阅 P0-2）。
    const placeholders = unknownPlaceholders(state, deps.appearance);
    return {
      ok: true, roomId, history: maskNamesDeep(history, placeholders),
      lastCommittedSeq: page.lastCommittedSeq, hasEarlier: page.hasEarlier,
    };
  });
}
