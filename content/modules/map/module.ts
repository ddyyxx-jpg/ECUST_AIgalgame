/**
 * map —— 校园地图模块（docs/06-地图模块.md §3）。只读 `data/*.json`、只算路径、只返回 Proposal：
 * 玩家 `map.travel` 沿 `located_in` 双向 BFS 逐跳 `move.to`；NPC 日程 `tick` 同理。
 * 不 import 引擎、不调 LLM、不写文件；坐标复用 registry 声明的 coord_x/coord_y（docs/06 §1）。
 */
import type {
  Entity,
  Module,
  ModuleContext,
  ModuleOutcome,
  Phase,
  Proposal,
  ViewPatch,
} from "../../../packages/shared/src/contract/types.ts";
import worldMapJson from "./data/world_map.json" with { type: "json" };
import { LEASE, PHASES, clockIndex, parseLease, type Lease } from "./lease.ts";
import schedulesJson from "./data/npc-schedules.json" with { type: "json" };
import { bfs, buildAdjacency, liveLocIds, resolveTarget } from "./path.ts";

interface SceneLinkSeed {
  kind: "module" | "npc" | "dialogue" | "scene";
  id: string;
  label?: string;
}
interface DialogueSeed {
  id: string;
  npcId: string;
  title: string;
  lines: string[];
}
interface SceneSeed {
  id: string;
  name: string;
  x: number;
  y: number;
  desc: string;
  tags?: string[];
  links?: SceneLinkSeed[];
  dialogues?: DialogueSeed[];
}
interface WorldMapSeed {
  schemaVersion: number;
  worldId: string;
  width: number;
  height: number;
  startLocId: string;
  scenes: SceneSeed[];
}
interface SchedulesSeed {
  schemaVersion: number;
  schedules: Record<string, Partial<Record<Phase, string>>>;
}

const WORLD = worldMapJson as WorldMapSeed;
const SCHEDULES = schedulesJson as SchedulesSeed;
const SCENE_SEED = new Map(WORLD.scenes.map((s) => [s.id, s]));

const BY = "mod.map";
// 属性键来自 docs/06 §1：坐标复用 registry 的 coord_x / coord_y，不在代码里发明新字段。
const COORD_X = "coord_x";
const COORD_Y = "coord_y";

/** 带中文动词前缀的输入：去/到/往/回/进/前往…，用于从自然语言里剥出地点词 */
const TRAVEL_RE = /^(?:map\.travel\b|travel\b|去|到|往|回|进|前往|移动到|走向|走到)/i;
const LOOK_RE = /(?:\blook\b|看看|看一下|观察|环顾|四周|地图|有什么|在哪)/i;
/**
 * 交易意图（审阅 M5）：map 的移动/观察关键词很宽（"去食堂买面包"含"去"、"看看面包多少钱"含"看看"），
 * 按 priority 顺序 map 会先被问到并认领，trade 就永远轮不到。识别到交易意图时主动弃权，
 * 让 dispatch 继续问 trade——这是模块间的路由让位，不涉及状态，不改引擎。
 */
const TRADE_HINT_RE = /(?:买|卖|退|多少钱|价格|付钱|来一[个份杯瓶]|要一[个份杯瓶])/;

function liveLoc(ctx: ModuleContext, id: string): Entity | undefined {
  const e = ctx.query.entity(id);
  return e && e.kind === "loc" && e.status === "active" ? e : undefined;
}

function sceneSeedOf(id: string): SceneSeed | undefined {
  return SCENE_SEED.get(id);
}

function nameOf(ctx: ModuleContext, id: string): string {
  return ctx.query.entity(id)?.name ?? sceneSeedOf(id)?.name ?? id;
}

/** 坐标优先级（docs/06 §4 坐标来源）：场景数据 → 实体 attrs → (0,0) */
function coordOf(ctx: ModuleContext, id: string): { x: number; y: number } {
  const seed = sceneSeedOf(id);
  if (seed) return { x: seed.x, y: seed.y };
  const attrs = ctx.query.entity(id)?.attrs;
  const x = attrs?.[COORD_X];
  const y = attrs?.[COORD_Y];
  if (typeof x === "number" && typeof y === "number") return { x, y };
  return { x: 0, y: 0 };
}

/** 角色的实时位置：located_in 边 from=actor → to=loc（引擎 actor.moved 的投影） */
function locatedAt(ctx: ModuleContext, actorId: string): string | undefined {
  return ctx.query.links("located_in", actorId).find((l) => liveLoc(ctx, l.to))?.to;
}

function playerIdOf(ctx: ModuleContext): string {
  return ctx.state.room.members.find((m) => m.role === "player")?.actorId ?? ctx.actorId;
}

function liveNpcs(ctx: ModuleContext): Entity[] {
  return Object.values(ctx.state.entities)
    .filter((e) => e.kind === "npc" && e.status === "active")
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** 某地点当前的 NPC（只认 located_in，不猜） */
function npcsAt(ctx: ModuleContext, locId: string): string[] {
  return liveNpcs(ctx)
    .filter((e) => locatedAt(ctx, e.id) === locId)
    .map((e) => e.id);
}

function travelOutcome(ctx: ModuleContext, input: string, forcedLocId?: string): ModuleOutcome {
  const target = forcedLocId === undefined ? resolveTarget(ctx, input) : liveLoc(ctx, forcedLocId);
  if (!target) {
    const missing = forcedLocId ?? input.trim();
    return { ok: false, proposals: [], error: { code: "E_REF_NOT_FOUND", message: `地图上没有可去的地点 ${missing}` } };
  }
  const here = ctx.state.room.scene.locId;
  if (here === target.id) {
    return { ok: true, proposals: [], facts: [`你已经在${target.name}了。`] };
  }
  const path = bfs(buildAdjacency(ctx), here, target.id);
  if (!path || path.length < 2) {
    // 不可达：认领这次移动（避免别的模块乱猜），但不产任何非法 op
    return { ok: true, proposals: [], facts: [`从${nameOf(ctx, here)}到${target.name}没有可走的路。`] };
  }

  const proposals: Proposal[] = path.slice(1).map((hop) => ({
    op: "move.to",
    args: { actorId: ctx.actorId, locId: hop },
    reason: `前往${nameOf(ctx, hop)}`,
    by: BY,
  }));
  const coord = coordOf(ctx, target.id);
  proposals.push({ op: "attr.set", args: { entityId: ctx.actorId, key: COORD_X, value: coord.x }, reason: "落点坐标", by: BY });
  proposals.push({ op: "attr.set", args: { entityId: ctx.actorId, key: COORD_Y, value: coord.y }, reason: "落点坐标", by: BY });
  // solo 镜头由最近一次 move.to 决定；逐跳移动后必须显式把镜头/在场集合放回目标场景
  proposals.push({
    op: "scene.set",
    args: { locId: target.id, presentIds: [ctx.actorId, ...npcsAt(ctx, target.id)] },
    reason: "落点恢复镜头",
    by: BY,
  });
  return { ok: true, proposals, facts: [`你走了 ${path.length - 1} 段路，来到${target.name}。`] };
}

/** map.look：只读，返回事实（场景名/坐标/描述/在场者/可做链接） */
function lookOutcome(ctx: ModuleContext): ModuleOutcome {
  const here = ctx.state.room.scene.locId;
  const seed = sceneSeedOf(here);
  const coord = coordOf(ctx, here);
  const present = ctx.query.present().map((id) => nameOf(ctx, id));
  const links = seed?.links ?? [];
  const facts = [
    `【${nameOf(ctx, here)}】(${coord.x},${coord.y})${seed?.desc ? ` ${seed.desc}` : ""}`,
    present.length > 0 ? `在这里：${present.join("、")}` : "这里没有别人。",
    links.length > 0 ? `可做：${links.map((l) => `${l.label ?? l.id}(${l.kind})`).join("、")}` : "可做：暂时没有。",
  ];
  return { ok: true, proposals: [], facts };
}

/** 全量只读视图：场景列表 + NPC 位置（前端真实数据仍以服务端 /map 为准） */
function mapView(ctx: ModuleContext): ViewPatch {
  const seeded = new Set(WORLD.scenes.map((s) => s.id));
  const scenes: { id: string; name: string; coord: { x: number; y: number } }[] = [
    ...WORLD.scenes.map((s) => ({ id: s.id, name: s.name, coord: { x: s.x, y: s.y } })),
    ...liveLocIds(ctx)
      .filter((id) => !seeded.has(id))
      .map((id) => ({ id, name: nameOf(ctx, id), coord: coordOf(ctx, id) })),
  ];
  const npcItems = liveNpcs(ctx).map((e) => ({
    key: e.id,
    text: e.name,
    meta: { locId: locatedAt(ctx, e.id) ?? "" },
  }));
  return {
    lists: [
      {
        id: "map",
        title: "校园地图",
        items: scenes.map((s) => ({
          key: s.id,
          text: s.name,
          meta: { x: s.coord.x, y: s.coord.y, presentNpcIds: npcsAt(ctx, s.id) },
        })),
      },
      { id: "npc", title: "NPC 位置", items: npcItems },
    ],
  };
}

function leaseProposal(npcId: string, lease: Lease | null, reason: string): Proposal {
  return {
    op: "attr.set",
    args: { entityId: npcId, key: LEASE, value: lease === null ? "" : JSON.stringify(lease) },
    reason,
    by: BY,
  };
}

/**
 * 日程 + 动作租约（D22 / WorldX 的 action lease）：
 * - 有租约且未到期：只递减/清空，不接新动作（NPC 正在占用时间）；
 * - 到达目标：停留 2 个 tick，再重新排日程；
 * - 需要移动：一次走完整条最短路，随后占用 1 个 tick 结算；
 * - phase 变了：旧租约作废，按新 phase 重排。
 * 一个 tick 只处理一次，保证"自动推进不切 phase"时 NPC 也不会每 tick 重新决策。
 */
function tickProposals(ctx: ModuleContext, phase: Phase): Proposal[] {
  if (!PHASES.includes(phase)) return [];
  const adj = buildAdjacency(ctx);
  const proposals: Proposal[] = [];
  const finalLoc = new Map<string, string>();

  // 日程名单 ∪ 仍持有租约的 active NPC：非日程 NPC 一旦被决策/对话写入租约，
  // 也必须由同一个 tick 消费或清掉，否则会永远占着租约不再被选。
  const npcIds = new Set<string>(Object.keys(SCHEDULES.schedules));
  for (const e of liveNpcs(ctx)) {
    if (parseLease(e.attrs[LEASE])) npcIds.add(e.id);
  }

  for (const npcId of [...npcIds].sort()) {
    const npc = ctx.query.entity(npcId);
    if (npc?.kind !== "npc" || npc.status !== "active") continue;
    const from = locatedAt(ctx, npcId);
    if (!from) continue;

    const old = parseLease(npc.attrs[LEASE]);
    // 玩家对话中：冻结动作，不递减、不接新动作；对话结束由服务端恢复原租约。
    // 跨 phase / 超时的 talk 租约视为过期：不先单独写一条清空，而是让本次重排的
    // 新租约直接覆盖它，避免同一批出现“清空 + 新租约”两条 attr.set 噪声。
    if (old?.action === "talk") {
      const expired = old.expiresAt !== undefined && clockIndex(ctx.clock) > old.expiresAt;
      if (old.phase === phase && !expired) continue;
    }
    // 租约优先于日程：NPC 自由活动/对话恢复可能把目标改到非日程地点。
    // 只要求目标仍是 live loc、phase 未变，避免旧存档/被删场景把 NPC 卡死。
    const lease = old && old.action !== "talk" && old.phase === phase && liveLoc(ctx, old.target) ? old : null;
    if (lease) {
      if (lease.remaining > 1) {
        proposals.push(leaseProposal(npcId, { ...lease, remaining: lease.remaining - 1 }, `${npc.name}继续${lease.action === "move" ? "赶路" : "停留"}`));
        continue;
      }
      if (lease.action === "stay") {
        proposals.push(leaseProposal(npcId, null, `${npc.name}结束停留`));
        continue;
      }
      // move 租约到期：真正执行移动，然后转成 2 tick 的停留占用。
      if (from === lease.target) {
        proposals.push(leaseProposal(npcId, { action: "stay", target: lease.target, remaining: 2, phase }, `${npc.name}在${nameOf(ctx, lease.target)}停留`));
        continue;
      }
      const leasePath = bfs(adj, from, lease.target);
      if (!leasePath || leasePath.length < 2) {
        proposals.push(leaseProposal(npcId, null, `${npc.name}的目的地不可达，取消动作`));
        continue;
      }
      proposals.push(leaseProposal(npcId, { action: "stay", target: lease.target, remaining: 2, phase }, `${npc.name}到达${nameOf(ctx, lease.target)}`));
      for (const hop of leasePath.slice(1)) {
        proposals.push({ op: "move.to", args: { actorId: npcId, locId: hop }, reason: `${npc.name}前往${nameOf(ctx, hop)}`, by: BY });
        const coord = coordOf(ctx, hop);
        proposals.push({ op: "attr.set", args: { entityId: npcId, key: COORD_X, value: coord.x }, reason: `${npc.name}坐标`, by: BY });
        proposals.push({ op: "attr.set", args: { entityId: npcId, key: COORD_Y, value: coord.y }, reason: `${npc.name}坐标`, by: BY });
      }
      finalLoc.set(npcId, lease.target);
      continue;
    }

    const targetId = SCHEDULES.schedules[npcId]?.[phase];
    if (!targetId || !liveLoc(ctx, targetId)) {
      // 没有可回的日程：旧租约（含过期 talk）在这里统一清一次，避免残留。
      if (old) proposals.push(leaseProposal(npc.id, null, "无日程，结束租约"));
      continue;
    }

    if (from === targetId) {
      proposals.push(leaseProposal(npcId, { action: "stay", target: targetId, remaining: 2, phase }, `${npc.name}在${nameOf(ctx, targetId)}停留`));
      continue;
    }

    const path = bfs(adj, from, targetId);
    if (!path || path.length < 2) {
      // 无路径：旧租约不能继续占着，否则会一直重试到租约过期。
      if (old) proposals.push(leaseProposal(npc.id, null, "目的地不可达，结束租约"));
      continue;
    }
    // 先写租约，再写移动：末尾两条仍应是坐标，方便既有测试与前端按"最后一跳"定位
    proposals.push(leaseProposal(npcId, { action: "move", target: targetId, remaining: 1, phase }, `${npc.name}前往${nameOf(ctx, targetId)}`));
    for (const hop of path.slice(1)) {
      proposals.push({ op: "move.to", args: { actorId: npcId, locId: hop }, reason: `${npc.name}前往${nameOf(ctx, hop)}`, by: BY });
      const coord = coordOf(ctx, hop);
      proposals.push({ op: "attr.set", args: { entityId: npcId, key: COORD_X, value: coord.x }, reason: `${npc.name}坐标`, by: BY });
      proposals.push({ op: "attr.set", args: { entityId: npcId, key: COORD_Y, value: coord.y }, reason: `${npc.name}坐标`, by: BY });
    }
    finalLoc.set(npcId, targetId);
  }
  if (proposals.length === 0 || finalLoc.size === 0) return proposals;

  // 镜头保护：solo 房间的 actor.moved 会让镜头跟着每个 NPC 跑，末尾必须放回玩家所在地
  const playerLoc = ctx.state.room.scene.locId;
  if (!liveLoc(ctx, playerLoc)) return proposals;
  const player = playerIdOf(ctx);
  const present = liveNpcs(ctx)
    .filter((e) => (finalLoc.get(e.id) ?? locatedAt(ctx, e.id)) === playerLoc)
    .map((e) => e.id)
    .filter((id) => id !== player);
  proposals.push({
    op: "scene.set",
    args: { locId: playerLoc, presentIds: [player, ...present] },
    reason: "NPC 移动后恢复玩家镜头",
    by: BY,
  });
  return proposals;
}

const mapModule: Module = {
  init() {
    // 数据非法只 log 不 throw（docs/06 §3.3）；模块自检失败不能拖垮引擎启动
    const issues: string[] = [];
    const ids = new Set<string>();
    for (const s of WORLD.scenes) {
      if (!s?.id || typeof s.name !== "string" || typeof s.x !== "number" || typeof s.y !== "number") issues.push(`场景数据不完整: ${String(s?.id)}`);
      if (ids.has(s.id)) issues.push(`场景 id 重复: ${s.id}`);
      ids.add(s.id);
    }
    for (const [npcId, byPhase] of Object.entries(SCHEDULES.schedules ?? {})) {
      for (const phase of PHASES) {
        const target = byPhase?.[phase];
        if (target !== undefined && !ids.has(target)) issues.push(`日程 ${npcId}.${phase} 指向未知场景 ${target}`);
      }
    }
    if (issues.length > 0) console.warn("[mod.map] 数据自检:", issues.join("; "));
  },

  intent(ctx) {
    const input = ctx.input.trim();
    if (TRADE_HINT_RE.test(input)) {
      return { ok: false, proposals: [], error: { code: "E_TOOL_UNKNOWN", message: "map 让位给交易类输入" } };
    }
    if (TRAVEL_RE.test(input)) return travelOutcome(ctx, input);
    if (LOOK_RE.test(input)) return lookOutcome(ctx);
    return { ok: false, proposals: [], error: { code: "E_TOOL_UNKNOWN", message: "map 没匹配到可执行动作" } };
  },

  tool(name, args, ctx) {
    if (name === "map.travel") {
      const a = (args ?? {}) as { locId?: unknown };
      return travelOutcome(ctx, ctx.input, typeof a.locId === "string" ? a.locId : undefined);
    }
    if (name === "map.look") return lookOutcome(ctx);
    return { ok: false, proposals: [], error: { code: "E_TOOL_UNKNOWN", message: `map 不认识工具 ${name}` } };
  },

  tick(ctx, phase) {
    return tickProposals(ctx, phase);
  },

  view(ctx) {
    return mapView(ctx);
  },
};

export default mapModule;
