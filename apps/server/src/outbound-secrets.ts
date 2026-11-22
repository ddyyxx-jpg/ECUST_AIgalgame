/**
 * 玩家视角出站裁剪（PR #147 审阅 P0）：plot 的 GM 字段与 NPC 私忆绝不能出现在
 * 任何玩家可读出口（/state、/events、/map/tick、v1 turn SSE）。
 *
 * 为什么单独成文件：这些字段是"漏一次就毁玩法"的秘密通道，散落在各路由里容易漏改；
 * 收在一处让后续新增出口能复用同一函数，也让测试只需盯一个模块。
 * 与 dev/v2 的 `projectWorldState` / `projectConversationEvents` 同口径
 * （由 packages/engine/src/v2/conversation.view.ts 的 stripPlotSecrets 提供字段清单）。
 * attrs 基本原样返回（docs/03 §5.2.5 的 issue #74 口径），唯一例外是引擎内部属性
 * `sim_lease`：它是 NPC 的动作租约（含下一步目标/剩余 tick），不属于玩家可见状态，
 * 任何出站投影都必须剥掉；否则 /state、/events、turn.patch 都会泄露 NPC 下一步。
 */
import type { Envelope, Plot, Proposal, WorldState } from "../../../packages/shared/src/index.ts";
import { projectProposals, stripPlotSecrets } from "../../../packages/engine/src/v2/index.ts";

/** 引擎内部属性：只给 tick/对话/调试用，任何玩家可读出口都必须剥掉。 */
const ENGINE_INTERNAL_ATTRS = ["sim_lease"] as const;
const INTERNAL_ATTR_SET = new Set<string>(ENGINE_INTERNAL_ATTRS);

/** 玩家能看到的 memory.written：public 广播，或自己的记忆；其余（private/secret）一律不下发 */
function visibleMemory(env: Envelope, viewer: string | undefined): boolean {
  const payload = env.payload as { visibility?: unknown; ownerId?: unknown };
  if (payload.visibility === "public") return true;
  return viewer !== undefined && payload.ownerId === viewer;
}

/** 单条事件裁剪：plot 事件剥 GM 字段，私忆按 owner 过滤；其余事件原样返回 */
export function projectEventForPlayer(env: Envelope, viewer?: string): Envelope | undefined {
  // attr.changed 的 payload 带 key/to；sim_lease 是内部租约（下一步目标/剩余 tick），
  // 不能靠 /state 剥了就算完——历史事件和 map.tick 的 events 都走这里。
  if (env.type === "attr.changed") {
    const key = (env.payload as { key?: unknown }).key;
    if (typeof key === "string" && INTERNAL_ATTR_SET.has(key)) return undefined;
  }
  if (env.type === "plot.upserted") {
    const payload = env.payload as { plot?: Plot };
    if (!payload.plot) return env;
    return { ...env, payload: { ...payload, plot: stripPlotSecrets(payload.plot) } };
  }
  if (env.type === "memory.written" && !visibleMemory(env, viewer)) return undefined;
  // 撤回事件不能白送旧私忆：memory.tombstoned 的 payload.reason 就是被撤回记忆的正文
  // （arbiter.ops.ts 的 memory.write(status:"tombstoned") 把 content 塞进 reason）。
  // 玩家只需要知道"某条记忆被撤回"，正文一律不给（PR #149 审阅 P0-3）。
  if (env.type === "memory.tombstoned") {
    const { reason: _oldContent, ...payload } = env.payload as Record<string, unknown>;
    return { ...env, payload };
  }
  if (env.type === "turn.patch") {
    // v1 回合补丁把整份 WorldState 放进 payload.state（turn.ts 的 turn.patch），
    // 与 /state 同口径剥 plot 秘密，否则"只是走 SSE"就能绕过 /state 的裁剪。
    // ops 同样要裁：turn.patch.ops 是 applied.applied（含 NPC 私忆与 investigate 的
    // plot.upsert 原始 args），客户端并不依赖它，留一份玩家可见版本即可（PR #149 P0-2）。
    const payload = env.payload as { state?: WorldState; ops?: readonly Proposal[] };
    const next: Record<string, unknown> = { ...payload };
    if (payload.state) next.state = projectStateForPlayer(payload.state);
    if (Array.isArray(payload.ops)) next.ops = projectProposals(payload.ops);
    return { ...env, payload: next };
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

/** 剥掉引擎内部属性；不改原对象，返回同一引用当且仅当没有可剥字段。 */
function stripEngineInternalAttrs(state: WorldState): WorldState {
  let changed = false;
  const entities: WorldState["entities"] = {};
  for (const [id, entity] of Object.entries(state.entities)) {
    const attrs = entity.attrs as Record<string, unknown>;
    if (!ENGINE_INTERNAL_ATTRS.some((key) => key in attrs)) {
      entities[id] = entity;
      continue;
    }
    const nextAttrs = { ...attrs };
    for (const key of ENGINE_INTERNAL_ATTRS) delete nextAttrs[key];
    entities[id] = { ...entity, attrs: nextAttrs as typeof entity.attrs };
    changed = true;
  }
  return changed ? { ...state, entities } : state;
}

/** /state 用的状态投影：剥 plot 的 GM 字段与引擎内部属性，其余交给出站掩码 */
export function projectStateForPlayer(state: WorldState): WorldState {
  const clean = stripEngineInternalAttrs(state);
  if (clean.plots.length === 0) return clean;
  return { ...clean, plots: clean.plots.map(stripPlotSecrets) };
}

/**
 * v1 TurnEvent 流的裁剪：turn.patch 结构是 `{type,state,ops}`（不是 Envelope），
 * 所以单独一个入口；其余 TurnEvent 不含 plot/私忆，原样返回。
 */
export function projectTurnEventForPlayer<T extends { type: string }>(ev: T): T {
  if (ev.type !== "turn.patch") return ev;
  const patch = ev as unknown as { state?: WorldState; ops?: readonly Proposal[] };
  const next: Record<string, unknown> = { ...(ev as unknown as Record<string, unknown>) };
  if (patch.state) next.state = projectStateForPlayer(patch.state);
  // ops 里有 NPC 私忆、撤回正文与 plot 的 GM args；客户端不用它，统一按玩家视角重建
  if (Array.isArray(patch.ops)) next.ops = projectProposals(patch.ops);
  return next as T;
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
