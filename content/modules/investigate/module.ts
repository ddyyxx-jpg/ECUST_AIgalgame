/**
 * investigate —— 次日调查密谋线索（issue #96/#128 端到端接线）。
 *
 * 复用 npc.plot 导演的 discoveryProposals：对每个 active plot 产出 evidence 记忆、
 * 可问线索与（配置存在时）NPC 态度 attr.delta。模块只返回 Proposal，全部写由 Arbiter 裁决。
 * 属性键来自 data/config.json（I2：代码不硬编码属性名）。
 */
import { z } from "zod";
import configJson from "./data/config.json" with { type: "json" };
import { activePlots, discoveryProposals } from "../../directors/npc.plot.ts";
import type { Module, ModuleContext, ModuleOutcome } from "../../../packages/shared/src/contract/types.ts";

const BY = "mod.investigate";
const TOOL = "investigate.probe";
const ConfigSchema = z.object({
  schemaVersion: z.number().int().positive(),
  attitudeAttr: z.string().min(1).optional(),
  delta: z.number().min(-100).max(100).optional(),
});
const KindSchema = z.enum(["observe", "search", "ask"]);
const config = ConfigSchema.parse(configJson);

function kindFrom(args: unknown, ctx: ModuleContext): z.infer<typeof KindSchema> {
  const raw = (args as { kind?: unknown } | null)?.kind;
  if (raw !== undefined) {
    const parsed = KindSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
  }
  const input = ctx.input.toLowerCase();
  if (input.includes("search") || input.includes("搜")) return "search";
  if (input.includes("ask") || input.includes("问") || input.includes("盘问")) return "ask";
  return "observe";
}

function probe(ctx: ModuleContext, kind: z.infer<typeof KindSchema>): ModuleOutcome {
  const plots = activePlots(ctx);
  if (plots.length === 0) {
    return { ok: true, proposals: [], facts: ["暂时没有发现值得追查的线索。"] };
  }
  // attitudeAttr 缺失 = 只产 evidence，不产 attr.delta（discoveryProposals 的显式参数语义）。
  const proposals = plots.flatMap((plot) => discoveryProposals(ctx, plot, kind, config.attitudeAttr ? { attitudeAttr: config.attitudeAttr } : undefined).proposals);
  const ui = plots.map((plot) => discoveryProposals(ctx, plot, kind).ui).find((u) => u?.lists?.length);
  return {
    ok: true,
    proposals,
    facts: [`针对 ${plots.length} 条密谋线索，记录可追问的细节（${kind}）。`],
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
