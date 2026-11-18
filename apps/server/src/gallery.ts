/**
 * 图鉴视图（GalleryView）的纯函数实现：服务端按 registry 声明算好读数，前端只渲染。
 *
 * 为什么在服务端算：I2——前端不能出现具体属性键，也不能知道 secret 的精确值；
 * 分档阈值、label/unit、可见性口径都是 registry 数据，只能由服务端解释。
 */
import type {
  AttrDef,
  Entity,
  Registry,
  WorldState,
} from "../../../packages/shared/src/contract/types.ts";
import type { NpcProfile } from "./scenarios.ts";
import { displayNameOf, knowsNameOf, unknownPlaceholders } from "./view-names.ts";

export type Band = "低" | "中" | "高";

/** 一条读数。`display` 决定前端怎么渲染；secret 永远不会带 value/ratio。 */
export interface GalleryStat {
  key: string;
  label: string;
  type: AttrDef["type"];
  visibility: AttrDef["visibility"];
  unit?: string;
  display: "exact" | "band" | "text" | "masked";
  /** display=exact：public 数值的精确值 */
  value?: number;
  /** display=exact：0~1 的进度条比例 */
  ratio?: number;
  /** display=band：secret 数值的分档（低/中/高） */
  band?: Band;
  /** display=text：public 文本的原文 */
  text?: string;
}

export interface GalleryNpc {
  id: string;
  name: string;
  /** 在场，或 located_in 与玩家同地 */
  met: boolean;
  present: boolean;
  /** 仅 met 时下发：未遇见不泄露行踪 */
  locName?: string;
  /** 仅 met 时下发：内容数据 content/scenarios/npcs.json */
  role?: string;
  traits?: string[];
  line?: string;
  /** 仅 met 时下发：地图头顶气泡的一句台词（来自 §5.2.6 的 NPC 档案） */
  mutter?: string;
  /** 仅 met 时有内容；未遇见 = [] */
  stats: GalleryStat[];
}

export interface GalleryView {
  roomId: string;
  player: { actorId: string; locId: string };
  npcs: GalleryNpc[];
  counts: { met: number; total: number; locs: number };
}

export interface GalleryInput {
  roomId: string;
  state: WorldState;
  registry: Registry;
  profiles: NpcProfile[];
  /** npcId → 外貌描述：未认识时用作占位名（content/scenarios/npcs.json 的 appearance） */
  appearance?: Map<string, string>;
}

/** secret 数值三等分：t≤1/3 低、t≤2/3 中、否则高（与 docs/03 §5.2.5 一致） */
export function bandOf(value: number, range: { min: number; max: number }): Band {
  const { min, max } = range;
  const t = (value - min) / (max - min || 1);
  if (t <= 1 / 3) return "低";
  if (t <= 2 / 3) return "中";
  return "高";
}

/** 进度条比例：只给 public，clamp 到 0~1，min/max 缺失按 0/100 */
function ratioOf(value: number, def: Pick<AttrDef, "min" | "max">): number {
  const min = def.min ?? 0;
  const max = def.max ?? 100;
  return Math.max(0, Math.min(1, (value - min) / (max - min || 1)));
}

/**
 * 把一个 NPC 的属性摊平成读数：
 * - public 数值 → exact（精确值+比例）；public 文本 → text；
 * - self/secret 数值 → band（**不下发精确值**，也不下发 ratio 这种可反推的连续量）；
 *   分档需要声明的 min/max，缺失则 masked（不猜范围）；
 * - self/secret 文本 → masked（文本本身就是精确值）；
 * - display.hidden → 不出现；未写入 → masked（UI 显示「—」）。
 */
function statsOf(entity: Entity, defs: AttrDef[]): GalleryStat[] {
  const out: GalleryStat[] = [];
  for (const def of defs) {
    if (def.display.hidden) continue;
    const base: GalleryStat = {
      key: def.key,
      label: def.display.label,
      type: def.type,
      visibility: def.visibility,
      ...(def.display.unit !== undefined ? { unit: def.display.unit } : {}),
      display: "masked",
    };
    const value = entity.attrs[def.key];
    if (value === undefined) {
      out.push(base);
      continue;
    }
    if (def.type === "number" && typeof value === "number") {
      if (def.visibility === "public") {
        out.push({ ...base, display: "exact", value, ratio: ratioOf(value, def) });
      } else if (def.min === undefined || def.max === undefined) {
        // 分档必须基于声明的范围；缺 min/max 时不猜 0~100，降级为「—」
        out.push(base);
      } else {
        out.push({ ...base, display: "band", band: bandOf(value, { min: def.min, max: def.max }) });
      }
    } else if (def.visibility === "public") {
      out.push({ ...base, display: "text", text: String(value) });
    } else {
      out.push(base);
    }
  }
  return out;
}

/** NPC 的位置：located_in 边的 to（引擎投影，不猜） */
function locOf(state: WorldState, npcId: string): string {
  return state.links.find((l) => l.kind === "located_in" && l.from === npcId)?.to ?? "";
}

export function buildGalleryView({ roomId, state, registry, profiles, appearance }: GalleryInput): GalleryView {
  const playerLoc = state.room.scene.locId;
  const presentIds = new Set(state.room.scene.presentIds);
  const profileOf = new Map(profiles.map((p) => [p.id, p]));
  const decls = registry.attrs("npc");
  const placeholders = unknownPlaceholders(state, appearance);

  const npcs: GalleryNpc[] = Object.values(state.entities)
    .filter((e) => e.kind === "npc" && e.status === "active")
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => {
      const npcLoc = locOf(state, e.id);
      const present = presentIds.has(e.id);
      // 一级判定：只有知道名字才算"认识"（knows_name）。同处一地、被看见都不算——
      // 否则开局 NPC 都在你面前，"图鉴"一进游戏就全解锁，也就不存在"陌生人"了。
      const met = knowsNameOf(e);
      const profile = met ? profileOf.get(e.id) : undefined;
      return {
        id: e.id,
        name: displayNameOf(e, placeholders),
        met,
        present,
        ...(met && npcLoc !== "" ? { locName: state.entities[npcLoc]?.name ?? npcLoc } : {}),
        ...(profile !== undefined
          ? {
              role: profile.role,
              traits: profile.traits,
              line: profile.line,
              ...(profile.mutter !== undefined ? { mutter: profile.mutter } : {}),
            }
          : {}),
        stats: met ? statsOf(e, decls) : [],
      };
    });

  const player = state.room.members.find((m) => m.role === "player")?.actorId ?? "plr_self";
  return {
    roomId,
    player: { actorId: player, locId: playerLoc },
    npcs,
    counts: {
      met: npcs.filter((n) => n.met).length,
      total: npcs.length,
      locs: Object.values(state.entities).filter((e) => e.kind === "loc").length,
    },
  };
}
