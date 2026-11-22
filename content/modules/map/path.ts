/**
 * map 模块的纯路径计算（docs/06 §3）：located_in 双向邻接、BFS 最短路、地点输入解析。
 * 只读 ctx、不产 Proposal；module.ts 负责把路径翻译成 move.to/attr.set/scene.set。
 */
import type { Entity, ModuleContext } from "../../../packages/shared/src/contract/types.ts";

const VERB_PREFIX = /^(?:我)?(?:想要|想|要)?(?:去|到|往|回|进|前往|移动到|走向|走到)/;

/** 只吃实体/边的地点图视图：模块与 server 的 travel 预检共用同一套 BFS。 */
export interface LocGraph {
  entities: Record<string, Pick<Entity, "kind" | "status">>;
  links: Array<Pick<{ kind: string; from: string; to: string }, "kind" | "from" | "to">>;
}

export function liveLocIdsOf(graph: LocGraph): string[] {
  return Object.entries(graph.entities)
    .filter(([, e]) => e.kind === "loc" && e.status === "active")
    .map(([id]) => id)
    .sort();
}

/** `located_in` 双向邻接（只连 live loc，角色/NPC 的 located_in 不进地点图） */
export function buildAdjacencyOf(graph: LocGraph): Map<string, string[]> {
  const adj = new Map<string, string[]>(liveLocIdsOf(graph).map((id) => [id, []]));
  const connect = (a: string, b: string) => {
    if (!adj.has(a) || !adj.has(b) || a === b) return;
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  };
  for (const link of graph.links) {
    if (link.kind !== "located_in") continue;
    const from = graph.entities[link.from];
    const to = graph.entities[link.to];
    if (from?.kind === "loc" && to?.kind === "loc" && from.status === "active" && to.status === "active") {
      connect(link.from, link.to);
    }
  }
  // 邻居排序 → BFS 在等长路径间也确定性
  for (const list of adj.values()) list.sort();
  return adj;
}

export function liveLocIds(ctx: ModuleContext): string[] {
  return liveLocIdsOf(ctx.state);
}

export function buildAdjacency(ctx: ModuleContext): Map<string, string[]> {
  return buildAdjacencyOf(ctx.state);
}

/** 最短路径（含起终点）；不可达返回 undefined */
export function bfs(adj: Map<string, string[]>, from: string, to: string): string[] | undefined {
  if (from === to) return [from];
  if (!adj.has(from) || !adj.has(to)) return undefined;
  const prev = new Map<string, string>();
  const seen = new Set<string>([from]);
  const queue: string[] = [from];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, cur);
      if (next === to) {
        const path = [to];
        for (let p = to; prev.has(p); p = prev.get(p)!) path.unshift(prev.get(p)!);
        return path;
      }
      queue.push(next);
    }
  }
  return undefined;
}

/** 从 "map.travel loc_x" / "去一食堂" 里认出目标 live loc；按最长名字匹配，避免短名截胡 */
export function resolveTarget(ctx: ModuleContext, input: string): Entity | undefined {
  const raw = input.replace(/^\s*(?:map\.)?travel\b/i, "").trim();
  const text = raw.replace(VERB_PREFIX, "").trim() || raw;
  if (!text) return undefined; // 只说「map.travel」没给目标：弃权，别瞎挑一个地点
  const locs = liveLocIds(ctx)
    .map((id) => ctx.query.entity(id)!)
    .filter(Boolean);
  const exact =
    locs.find((e) => e.id === text) ??
    locs.find((e) => e.name === text) ??
    locs.find((e) => e.id === raw) ??
    locs.find((e) => e.name === raw);
  if (exact) return exact;
  const byName = locs
    .filter((e) => e.name.length > 0 && (text.includes(e.name) || e.name.includes(text)))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (byName) return byName;
  return locs.find((e) => text.includes(e.id) || raw.includes(e.id));
}
