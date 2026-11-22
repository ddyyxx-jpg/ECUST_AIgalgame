/**
 * 玩家视角出站裁剪（PR #147 审阅 P0）：plot 的 GM 字段与 NPC 私忆绝不能出现在
 * 任何玩家可读出口（/state、/events、/map/tick、v1 turn SSE）。
 *
 * 为什么单独成文件：这些字段是"漏一次就毁玩法"的秘密通道，散落在各路由里容易漏改；
 * 收在一处让后续新增出口能复用同一函数，也让测试只需盯一个模块。
 * 与 dev/v2 的 `projectWorldState` / `projectConversationEvents` 同口径
 * （由 packages/engine/src/v2/conversation.view.ts 的 stripPlotSecrets 提供字段清单），
 * 但本模块不裁剪 attrs/links——那些走既有的 maskNamesDeep / 观察者投影。
 */
import type { Envelope, Plot, WorldState } from "../../../packages/shared/src/index.ts";
import { stripPlotSecrets } from "../../../packages/engine/src/v2/index.ts";

/** 玩家能看到的 memory.written：public 广播，或自己的记忆；其余（private/secret）一律不下发 */
function visibleMemory(env: Envelope, viewer: string | undefined): boolean {
  const payload = env.payload as { visibility?: unknown; ownerId?: unknown };
  if (payload.visibility === "public") return true;
  return viewer !== undefined && payload.ownerId === viewer;
}

/** 单条事件裁剪：plot 事件剥 GM 字段，私忆按 owner 过滤；其余事件原样返回 */
export function projectEventForPlayer(env: Envelope, viewer?: string): Envelope | undefined {
  if (env.type === "plot.upserted") {
    const payload = env.payload as { plot?: Plot };
    if (!payload.plot) return env;
    return { ...env, payload: { ...payload, plot: stripPlotSecrets(payload.plot) } };
  }
  if (env.type === "memory.written" && !visibleMemory(env, viewer)) return undefined;
  if (env.type === "turn.patch") {
    // v1 回合补丁把整份 WorldState 放进 payload.state（turn.ts 的 turn.patch），
    // 与 /state 同口径剥 plot 秘密，否则"只是走 SSE"就能绕过 /state 的裁剪。
    const payload = env.payload as { state?: WorldState };
    if (!payload.state) return env;
    return { ...env, payload: { ...payload, state: projectStateForPlayer(payload.state) } };
  }
  return env;
}

/** 事件流出站裁剪（顺序不变，被过滤的私忆直接消失） */
export function projectEventsForPlayer(events: readonly Envelope[], viewer?: string): Envelope[] {
  const out: Envelope[] = [];
  for (const env of events) {
    const projected = projectEventForPlayer(env, viewer);
    if (projected) out.push(projected);
  }
  return out;
}

/** /state 用的状态投影：只剥 plot 的 GM 字段，其余交给出站掩码 */
export function projectStateForPlayer(state: WorldState): WorldState {
  if (state.plots.length === 0) return state;
  return { ...state, plots: state.plots.map(stripPlotSecrets) };
}

/**
 * v1 TurnEvent 流的裁剪：turn.patch 结构是 `{type,state,ops}`（不是 Envelope），
 * 所以单独一个入口；其余 TurnEvent 不含 plot/私忆，原样返回。
 */
export function projectTurnEventForPlayer<T extends { type: string }>(ev: T): T {
  if (ev.type !== "turn.patch") return ev;
  const state = (ev as unknown as { state?: WorldState }).state;
  if (!state) return ev;
  return { ...ev, state: projectStateForPlayer(state) };
}

/**
 * 从状态里解析"玩家本人"的 actorId（服务端签发，不信任 query/body）。
 * 与 map.ts 的 playerActorId 同规则：member.role==="player" → kind=plr 实体 → members[0]。
 */
export function playerOf(state: WorldState, userId?: string): string | undefined {
  // 已登录时先按账号绑定解析（联机多人房每人都该看到"自己"的私忆，而不是 1 号玩家）
  if (userId) {
    const mine = state.room.members.find((m) => m.userId === userId);
    if (mine) return mine.actorId;
  }
  const member = state.room.members.find((m) => m.role === "player");
  if (member) return member.actorId;
  const plr = Object.values(state.entities).find((e) => e.kind === "plr" && e.status === "active");
  return plr?.id ?? state.room.members[0]?.actorId;
}
