/**
 * ② 玩家视角投影（dev/v2，供 HTTP/SSE 接线用，纯函数）。
 * 宿主内部事件带全量信息；下发前必须用已鉴权的观察者身份 + 会话成员名单裁剪。
 * 心理活动永远留在服务端；提交结果（proposals + state）按可见性再裁一次。
 *
 * 本文件只提供 helper，不改 Envelope/ConversationEvent 契约（packages/shared 不动）。
 */
import type {
  ActorId, ConversationEvent, Id, Plot, Proposal, Registry, WorldState,
} from "../../../shared/src/index.ts";

/** 心理/私密记忆标签：即便 memory.write 写了 public 也不能把这些 tag 下发 */
const SECRET_MEMORY_TAGS = new Set(["mental", "secret"]);
/** Plot 里属于 GM 的字段，玩家视角一律抹掉 */
const SECRET_PLOT_KEYS = ["forbidReveal", "leakPoints", "guard", "leverage", "risk", "goal"] as const;

/** GM 字段剥离；导出以便 dev/v1/HTTP 出口复用同一份字段清单（PR #147 审阅 P0） */
export function stripPlotSecrets(plot: Plot): Plot {
  const clean: Plot = { ...plot };
  for (const key of SECRET_PLOT_KEYS) delete clean[key];
  return clean;
}

/** 提交结果里的 Proposal 裁剪：私忆与 GM 字段不下发，其余 op 原样保留 */
export function projectProposals(proposals: readonly Proposal[]): Proposal[] {
  return proposals.flatMap((p) => {
    if (p.op === "memory.write") {
      const tags = Array.isArray(p.args.tags) ? p.args.tags : [];
      const secret = tags.some((t) => typeof t === "string" && SECRET_MEMORY_TAGS.has(t));
      if (secret || p.args.visibility !== "public") return [];
    }
    if (p.op === "plot.upsert") {
      const args = { ...p.args };
      for (const key of SECRET_PLOT_KEYS) delete args[key];
      return [{ ...p, args }];
    }
    return [p];
  });
}

/** WorldState 裁剪：私有关系边、模块私有状态、GM 字段按视角剔除；registry 存在时再裁 attrs */
export function projectWorldState(
  state: WorldState,
  viewer: ActorId,
  members: readonly ActorId[],
  registry?: Registry,
): WorldState {
  const memberSet = new Set<ActorId>(members);
  const seen = memberSet.has(viewer);
  const canSee = (audience: readonly ActorId[] | undefined): boolean =>
    !audience?.length || (seen && audience.includes(viewer));
  const entities: WorldState["entities"] = {};
  for (const [id, entity] of Object.entries(state.entities)) {
    if (!registry) { entities[id] = entity; continue; }
    const attrs: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(entity.attrs)) {
      if (registry.attr(key)?.visibility === "public") attrs[key] = value;
    }
    entities[id] = { ...entity, attrs };
  }
  return {
    ...state,
    entities,
    links: state.links.filter((l) => canSee(l.audience)),
    plots: state.plots.map(stripPlotSecrets),
    moduleState: {},
  };
}

/**
 * 按观察者投影事件流。members 来自会话成员名单（不是客户端自称），
 * 因此目标 NPC 的悄悄话只有目标自己的 viewer 能收到，旁观者只收到自己那条（可能只有动作）。
 */
export function projectConversationEvents(
  events: readonly ConversationEvent[],
  viewer: ActorId,
  members: readonly ActorId[],
  registry?: Registry,
): ConversationEvent[] {
  const memberSet = new Set<Id>(members);
  const allowed = memberSet.has(viewer);
  const out: ConversationEvent[] = [];
  for (const ev of events) {
    switch (ev.type) {
      // 心理活动只做调试/审计，任何视角都不下发
      case "conversation.mental":
        break;
      case "conversation.utterance":
        if (allowed && ev.delivery.to === viewer) {
          // 只有被指名的那一方能看到 target；旁听者拿到 target 等于泄露"谁在跟谁说悄悄话"
          const { target, ...rest } = ev.delivery;
          out.push({ ...ev, delivery: viewer === target ? ev.delivery : rest });
        }
        break;
      case "conversation.committed":
        out.push({
          ...ev,
          proposals: projectProposals(ev.proposals),
          state: projectWorldState(ev.state, viewer, members, registry),
        });
        break;
      default:
        out.push(ev);
    }
  }
  return out;
}
