/**
 * View：把权威状态投影成"玩家能看的东西"。
 * 面板完全由 registry 的 display 元数据生成 —— 加属性不用改前端。
 */
import type { ActorId, AttrValue, Entity, Registry, ViewPatch, WorldState } from "../../shared/src/index.ts";

export interface ViewOptions {
  /** 看谁的属性面板；session 模式下靠它决定能看什么 */
  actorId: ActorId;
  /** 是否包含 secret 属性（默认否） */
  includeSecret?: boolean;
}

export function buildView(state: WorldState, registry: Registry, opts: ViewOptions): ViewPatch {
  const me = state.entities[opts.actorId];
  const loc = state.entities[state.room.scene.locId];
  const panels: NonNullable<ViewPatch["panels"]> = {};

  if (me) {
    const rows = registry.attrs()
      .filter((d) => d.scope.includes(me.kind))
      .filter((d) => !d.display.hidden)
      .filter((d) => opts.includeSecret || d.visibility !== "secret")
      .filter((d) => me.attrs[d.key] !== undefined)
      .map((d) => ({ key: d.key, label: d.display.label, value: me.attrs[d.key] as AttrValue, unit: d.display.unit }));
    if (rows.length) panels["状态"] = rows;
  }

  const actors = state.room.scene.presentIds.map((id) => ({
    actorId: id as ActorId,
    name: state.entities[id]?.name ?? id,
    present: true,
  }));

  const exits = state.links
    .filter((l) => l.kind === "located_in" && l.from === state.room.scene.locId)
    .map((l) => ({ locId: l.to, name: state.entities[l.to]?.name ?? l.to }));

  return {
    panels,
    position: loc
      ? { locId: loc.id, name: loc.name, actors, exits }
      : { locId: state.room.scene.locId, name: state.room.scene.locId, actors, exits },
  };
}

/** 给 LLM 用的实体摘要（不含 secret） */
export function describeEntity(e: Entity, registry: Registry): string {
  const parts = registry.attrs()
    .filter((d) => d.scope.includes(e.kind) && d.visibility === "public")
    .filter((d) => e.attrs[d.key] !== undefined)
    .map((d) => `${d.display.label}=${String(e.attrs[d.key])}`);
  return `${e.name}(${e.kind})${parts.length ? " " + parts.join(" ") : ""}`;
}
