/**
 * 投影：事件 → 世界状态。纯函数，`(state, env) => state`。
 * 为什么不把状态直接改在原对象上：replay/回放/多房间快照都依赖"同日志 ⇒ 同状态"，
 * 任何非确定性（Date.now / random / 遍历顺序）都不许出现在这里。
 * 事件 payload 一律带"结果值"而不是"参数"（attr.changed 带 from/to，
 * clock.advanced 带完整 clock），这样投影不需要 registry、也不需要重算规则。
 */

import type {
  Entity,
  Envelope,
  Link,
  Plot,
  RoomMember,
  RoomState,
  SceneState,
  GameClock,
  WorldState,
} from "../../shared/src/contract/types.ts";
import { SCHEMA_VERSION } from "../../shared/src/contract/version.ts";

export const DEFAULT_LOC = "loc_campus_gate";

export function createInitialState(
  roomId: string,
  opts: { worldId?: string; locId?: string; mode?: RoomState["mode"] } = {},
): WorldState {
  const locId = opts.locId ?? DEFAULT_LOC;
  return {
    schemaVersion: SCHEMA_VERSION,
    room: {
      id: roomId,
      mode: opts.mode ?? "solo",
      worldId: opts.worldId ?? "canon_main",
      members: [],
      scene: { locId, presentIds: [] },
      createdAt: 0,
      lastActiveAt: 0,
    },
    entities: {},
    links: [],
    clock: { day: 1, phase: "morning", tick: 0 },
    plots: [],
    moduleState: {},
  };
}

// ---------------------------------------------------------------- payload 形状
// 事件 payload 是日志的一部分，形状必须稳定；这里显式声明而不是 `as any`。

interface AttrChangedPayload {
  entityId: string;
  key: string;
  from: unknown;
  to: unknown;
  clamped: boolean;
}
interface EntityWrittenPayload {
  entity: Entity;
}
interface EntityTombstonedPayload {
  entityId: string;
  reason?: string;
  at: number;
}
interface LinkCreatedPayload {
  link: Link;
}
interface LinkRemovedPayload {
  linkId: string;
}
interface MovedPayload {
  actorId: string;
  from: string;
  to: string;
}
interface ClockPayload {
  clock: GameClock;
}
interface ScenePayload {
  locId: string;
  presentIds: string[];
  props?: string[];
}
interface PlotPayload {
  plot: Plot;
}

function p<T>(env: Envelope): T {
  return env.payload as T;
}

/** present 边只是 SceneState.presentIds 的投影，由引擎重建（02 §3.2 权威性判定 1） */
export function rebuildPresentLinks(state: WorldState): Link[] {
  const { locId, presentIds } = state.room.scene;
  const others = state.links.filter((l) => l.kind !== "present");
  const present: Link[] = presentIds.map((actorId) => ({
    id: `link_present_${locId}__${actorId}`,
    kind: "present",
    from: locId,
    to: actorId,
    createdAt: state.clock.tick,
  }));
  return [...others, ...present];
}

function withEntity(state: WorldState, entity: Entity): WorldState {
  return { ...state, entities: { ...state.entities, [entity.id]: entity } };
}

/**
 * 唯一的状态演进函数。未知事件类型原样返回（前向兼容：新增事件类型不该炸旧存档），
 * 但调用方（store.replay）可以用 seenTypes 统计未知事件。
 */
export function applyEvent(state: WorldState, env: Envelope): WorldState {
  switch (env.type) {
    case "attr.changed": {
      const e = p<AttrChangedPayload>(env);
      const old = state.entities[e.entityId];
      if (!old) return state;
      const entity: Entity = {
        ...old,
        attrs: { ...old.attrs, [e.key]: e.to as Entity["attrs"][string] },
        updatedAt: env.seq,
      };
      return withEntity(state, entity);
    }
    case "entity.created":
    case "entity.updated": {
      const e = p<EntityWrittenPayload>(env);
      return withEntity(state, e.entity);
    }
    case "entity.tombstoned": {
      const e = p<EntityTombstonedPayload>(env);
      const old = state.entities[e.entityId];
      if (!old) return state;
      return withEntity(state, {
        ...old,
        status: "tombstoned",
        tombstonedAt: e.at,
        updatedAt: env.seq,
      });
    }
    case "link.created": {
      const e = p<LinkCreatedPayload>(env);
      const rest = state.links.filter((l) => l.id !== e.link.id);
      return { ...state, links: [...rest, e.link] };
    }
    case "link.removed": {
      const e = p<LinkRemovedPayload>(env);
      return { ...state, links: state.links.filter((l) => l.id !== e.linkId) };
    }
    case "actor.moved": {
      const e = p<MovedPayload>(env);
      // 角色位置是 located_in 边；scene 只是"镜头"，solo 房间镜头=玩家所在地
      const links = state.links.filter((l) => !(l.kind === "located_in" && l.from === e.actorId));
      links.push({ id: `link_located_in_${e.actorId}__${e.to}`, kind: "located_in", from: e.actorId, to: e.to, createdAt: env.seq });
      const prev = state.room.scene;
      const locId = state.room.mode === "solo" ? e.to : prev.locId;
      const presentIds = locId === e.to
        ? prev.presentIds.includes(e.actorId)
          ? prev.presentIds
          : [...prev.presentIds, e.actorId]
        : prev.presentIds.filter((id) => id !== e.actorId);
      const next: WorldState = {
        ...state,
        links,
        room: { ...state.room, scene: { ...prev, locId, presentIds }, lastActiveAt: env.seq },
      };
      return { ...next, links: rebuildPresentLinks(next) };
    }
    case "clock.advanced": {
      const e = p<ClockPayload>(env);
      return { ...state, clock: { ...e.clock } };
    }
    case "scene.changed": {
      const e = p<ScenePayload>(env);
      const scene: SceneState = { locId: e.locId, presentIds: [...e.presentIds] };
      if (e.props) scene.props = [...e.props];
      const next: WorldState = { ...state, room: { ...state.room, scene } };
      return { ...next, links: rebuildPresentLinks(next) };
    }
    case "plot.upserted": {
      const e = p<PlotPayload>(env);
      const rest = state.plots.filter((x) => x.id !== e.plot.id);
      return { ...state, plots: [...rest, e.plot] };
    }
    case "room.member.joined": {
      // 成员变化也要可回放：联机房间靠它恢复"谁还在房里"
      const m = p<{ member?: RoomMember }>(env).member;
      if (!m || !m.actorId) return state;
      const rest = state.room.members.filter((x) => x.actorId !== m.actorId);
      return { ...state, room: { ...state.room, members: [...rest, m] } };
    }
    case "room.member.left": {
      const actorId = p<{ actorId?: string }>(env).actorId;
      if (!actorId) return state;
      return { ...state, room: { ...state.room, members: state.room.members.filter((x) => x.actorId !== actorId) } };
    }
    case "memory.written":
      // 记忆不落在 WorldState（它由 Memory 服务从同一日志投影），这里保持无副作用，
      // 保证"世界状态"只回答"谁在哪、有什么、关系如何"。
      return state;
    default:
      return state;
  }
}
