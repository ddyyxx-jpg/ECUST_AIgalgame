/**
 * investigate —— 次日调查密谋线索（issue #96/#128 端到端接线）。
 *
 * 复用 npc.plot 导演的 discoveryProposals：按 leakPoints 产出 evidence 记忆、
 * 可问线索与（配置存在时）NPC 态度 attr.delta。模块只返回 Proposal，全部写由 Arbiter 裁决。
 * 属性键来自 data/config.json（I2：代码不硬编码属性名）。
 *
 * PR #147 审阅 P2-4：幂等基于 WorldState 里的 fact 标记实体（重启仍在），
 * 同一 plot 的同一 leak 只产一次 evidence；重复调查 ok:true + 「已查过」fact；
 * 态度 attr.delta 每 plot 一生只产一次，避免多次调查叠加 guard。
 * PR #147 审阅 P1-3（剧情生命周期收口）：全部可查 leak 查完时由 discoveryProposals 产出
 * plot.upsert(status:"leaked")，释放 active 配额；leaked 后仍靠标记实体给「已查过」反馈。
 *
 * 为什么选 fact 实体 tags 而不是玩家 x. 属性 / 记忆判重：
 * - memory.write 没有 contentHash 去重，私忆按事件 seq 生成新 id，重启后也无法按内容判重；
 * - 玩家 x. 属性需要 attr.set，会多写一次 attr.changed，且 xWritesPerTurn=8 对多 leak 不友好；
 * - fact 实体的 tags 是 Entity 正式字段、随 WorldState 落盘，重启可读，不改 registry、不占属性预算。
 */
import { z } from "zod";
import configJson from "./data/config.json" with { type: "json" };
import { activePlots, discoveryProposals } from "../../directors/npc.plot.ts";
import type { Entity, Module, ModuleContext, ModuleOutcome, Proposal } from "../../../packages/shared/src/contract/types.ts";

const BY = "mod.investigate";
const TOOL = "investigate.probe";
const ConfigSchema = z.object({
  schemaVersion: z.number().int().positive(),
  attitudeAttr: z.string().min(1).optional(),
  delta: z.number().min(-100).max(100).optional(),
  /** 持久标记实体 id 模板；引擎要求 fact_ 前缀且 ≤64 字符（02 §3）。 */
  markerIdTemplate: z.string().min(1).default("fact_inv_{plot}_{actor}"),
  /** 每次调查最多新查几条 leak（缺省 = 全部）。 */
  leaksPerProbe: z.number().int().min(1).default(99),
  /** kind 判定词表（数据驱动，参照 §4.7 reality.json 的 patterns 做法；顺序即优先级） */
  kindPatterns: z.record(z.string(), z.array(z.string().min(1))).optional(),
});
const KindSchema = z.enum(["observe", "search", "ask"]);
const config = ConfigSchema.parse(configJson);

function kindFrom(args: unknown, ctx: ModuleContext): z.infer<typeof KindSchema> {
  const raw = (args as { kind?: unknown } | null)?.kind;
  if (raw !== undefined) {
    const parsed = KindSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
  }
  // 词表来自 config.json（I2/I3：代码不写死中文关键词）；未配置时一律 observe。
  const input = ctx.input.toLowerCase();
  for (const [kind, patterns] of Object.entries(config.kindPatterns ?? {})) {
    const parsed = KindSchema.safeParse(kind);
    if (!parsed.success) continue;
    if (patterns.some((p) => input.includes(p.toLowerCase()))) return parsed.data;
  }
  return "observe";
}

/** 标记实体 id 从配置模板拼出，收敛到引擎允许的 ≤64 字符（不新增属性，纯状态实体）。 */
function markerIdOf(plotId: string, actorId: string): string | undefined {
  const id = config.markerIdTemplate
    .replace("{plot}", plotId.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 24))
    .replace("{actor}", actorId.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 24));
  return id.startsWith("fact_") && id.length <= 64 ? id : undefined;
}

type Progress = { leaks: Set<number>; attitudeDone: boolean };

/** 从标记实体的 tags 读进度；坏档（tag 内容非法）按空处理，不炸回合。 */
function readProgress(entity: Entity | undefined): Progress {
  const out: Progress = { leaks: new Set(), attitudeDone: false };
  if (!entity || entity.tombstonedAt) return out;
  for (const tag of entity.tags) {
    if (tag === "attitudeDone") out.attitudeDone = true;
    if (!tag.startsWith("leaks:")) continue;
    for (const part of tag.slice("leaks:".length).split(",")) {
      if (!/^\d+$/.test(part)) continue;
      out.leaks.add(Number(part));
    }
  }
  return out;
}

function progressTags(plotId: string, actorId: string, progress: Progress): string[] {
  return [
    "investigate",
    `plot:${plotId}`,
    `actor:${actorId}`,
    `leaks:${[...progress.leaks].sort((a, b) => a - b).join(",")}`,
    ...(progress.attitudeDone ? ["attitudeDone"] : []),
  ];
}

function probe(ctx: ModuleContext, kind: z.infer<typeof KindSchema>): ModuleOutcome {
  const plots = activePlots(ctx);
  const facts: string[] = [];
  const proposals: Proposal[] = [];
  let ui: ModuleOutcome["ui"] | undefined;
  const seenPlotIds = new Set<string>();

  for (const plot of plots) {
    const plotId = plot.id;
    if (!plotId) continue;
    seenPlotIds.add(plotId);
    const markerId = markerIdOf(plotId, ctx.actorId);
    const marker = markerId ? ctx.query.entity(markerId) : undefined;
    const progress = readProgress(marker);
    const pending = plot.leakPoints.map((_, i) => i).filter((i) => !progress.leaks.has(i)).slice(0, config.leaksPerProbe);
    const opts = {
      ...(config.attitudeAttr ? { attitudeAttr: config.attitudeAttr, ...(config.delta !== undefined ? { delta: config.delta } : {}) } : {}),
      investigatedLeaks: progress.leaks,
      leakIndices: pending,
      attitudeDeltaEligible: !progress.attitudeDone,
    };
    const result = discoveryProposals(ctx, plot, kind, opts);
    proposals.push(...result.proposals);
    if (!ui && result.ui?.lists?.some((l) => l.items?.length)) ui = result.ui;

    if (result.newlyInvestigated.length > 0) {
      for (const i of result.newlyInvestigated) progress.leaks.add(i);
      if (result.proposals.some((p) => p.op === "attr.delta")) progress.attitudeDone = true;
      // 标记随证据同批提交：atomic 下 evidence 被拒则标记也不会写，不会误跳。
      if (marker) {
        proposals.push({
          op: "entity.update",
          args: { entityId: marker.id, tags: progressTags(plotId, ctx.actorId, progress) },
          reason: "更新已调查 leakPoint 标记（P2-4）",
          by: BY,
        });
      } else if (markerId) {
        proposals.push({
          op: "entity.create",
          args: { id: markerId, kind: "fact", name: "已调查标记", tags: progressTags(plotId, ctx.actorId, progress), origin: "system", canon: false },
          reason: "记录已调查 leakPoint，避免重复写证据/重复扣态度（P2-4）",
          by: BY,
        });
      }
      const remaining = plot.leakPoints.filter((_, i) => !progress.leaks.has(i)).length;
      if (remaining > 0) facts.push(`还有 ${remaining} 条线索可以继续调查（${plotId}）`);
    } else {
      facts.push(`这条线索你已经查过了（${plotId}）`);
    }
  }

  // leaked/resolved 后 activePlots 不再返回它；标记实体仍在状态里，仍可给玩家反馈。
  for (const entity of Object.values(ctx.state.entities)) {
    if (entity.tombstonedAt || !entity.tags.includes("investigate") || !entity.tags.includes(`actor:${ctx.actorId}`)) continue;
    const tag = entity.tags.find((t) => t.startsWith("plot:"));
    const plotId = tag?.slice("plot:".length);
    if (!plotId || seenPlotIds.has(plotId)) continue;
    facts.push(`这条线索你已经查过了（${plotId}）`);
  }

  if (plots.length === 0 && facts.length === 0) {
    return { ok: true, proposals: [], facts: ["暂时没有发现值得追查的线索。"] };
  }
  return {
    ok: true,
    proposals,
    facts: facts.length > 0 ? facts : [`针对 ${plots.length} 条密谋线索，记录可追问的细节（${kind}）。`],
    ...(ui ? { ui } : {}),
  };
}

const investigateModule: Module = {
  intent(ctx) {
    return probe(ctx, kindFrom(undefined, ctx));
  },

  tool(name, args, ctx) {
    if (name !== TOOL) {
      return { ok: false, proposals: [], error: { code: "E_TOOL_UNKNOWN", message: `investigate 不认识工具 ${name}` } };
    }
    return probe(ctx, kindFrom(args, ctx));
  },
};

export default investigateModule;
