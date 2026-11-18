/**
 * 房间授权统一 gate（issue #33）：登录只解决身份，这里解决"这个账号能不能进这个房间"。
 * 所有房间读写入口（state/events/turns/map 系列/gallery/history）共用同一边界：
 *   1. 成员资格：房间成员表里任一 userId 存在 → 当前用户必须在其中；
 *   2. 写操作额外绑定 actorId：必须是本房间 role=player 且 userId=当前用户 的角色；
 *   3. 旧档（成员表无 userId）：强制登录部署默认不开放（403），本地开发保持旧开放度；
 *   4. 管理员例外：有效 x-admin-token 可越过成员/角色绑定（旧档恢复等运维操作）。
 * 存在性校验与授权分别处理（#37）：snapshot 对缺失房间不抛错时这里不额外判存在。
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { WorldState } from "../../../packages/shared/src/contract/types.ts";
import type { AppDeps } from "./routes.ts";
import { tokenEquals, type TokenVerdict } from "./admin-token.ts";

export type UserIdOf = (req: FastifyRequest, deps: AppDeps, body?: { userId?: string }) => string | undefined;

/** 管理员令牌统一从 x-admin-token 头取 */
export function adminTokenOf(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers["x-admin-token"];
  return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
}

export interface RoomAccess {
  state: WorldState;
  userId: string | undefined;
}

function deny(reply: FastifyReply, message: string): null {
  reply.code(403).send({ ok: false, code: "E_FORBIDDEN", message });
  return null;
}

/** 通过返回 {state,userId}；拒绝时已写好 403/404 响应并返回 null，调用方直接 return */
export async function guardRoom(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: AppDeps,
  roomId: string,
  userIdOf: UserIdOf,
  opts: { actorId?: string; body?: { userId?: string } } = {},
): Promise<RoomAccess | null> {
  let state: WorldState;
  try {
    state = await deps.store.snapshot(roomId);
  } catch (e) {
    // 存在性已由 roomGate 判过；这里再炸只能是存档损坏/IO 故障，不能折叠成"房间不存在"——
    // 否则客户端会清掉房间指针，运维也看不到存储故障（复审 P0）。
    console.error(`[room-guard] 读取房间状态失败：${roomId}`, e);
    reply.code(503).send({ ok: false, code: "E_STORE_FAULT", message: "房间状态读取失败，请稍后重试" });
    return null;
  }

  const userId = userIdOf(req, deps, opts.body);

  const token = adminTokenOf(req.headers);
  if (token) {
    const verdict: TokenVerdict = deps.adminVerdict
      ? deps.adminVerdict(req)
      : deps.adminGate
        ? deps.adminGate.check(token, req.ip)
        : { ok: tokenEquals(token, deps.adminToken ?? "") };
    if (verdict.blocked) {
      reply.code(429).send({ ok: false, code: "E_RATE_LIMITED", message: "管理员鉴权失败次数过多，请稍后再试" });
      return null;
    }
    if (verdict.ok) return { state, userId };
  }

  const owners = state.room.members.flatMap((m) => (m.userId ? [m.userId] : []));
  if (owners.length === 0) {
    if (deps.auth?.required) return deny(reply, "旧存档没有归属账号，默认不开放；请联系管理员处理");
  } else if (!userId || !owners.includes(userId)) {
    return deny(reply, "只有本房间成员可以访问");
  }

  // 写操作：actorId 必须是当前账号在本房间的角色，不能拿别人的 actorId 代操作
  if (opts.actorId !== undefined && owners.length > 0) {
    const member = state.room.members.find((m) => m.actorId === opts.actorId && m.role === "player");
    if (!member || member.userId !== userId) {
      return deny(reply, "actorId 不属于当前账号在本房间的角色");
    }
  }

  return { state, userId };
}