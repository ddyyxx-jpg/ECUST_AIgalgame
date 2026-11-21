/**
 * npc.plot.discovery —— 密谋的次日调查入口（从 npc.plot.ts 拆出，§6 文件 ≤300 行）。
 *
 * 与导演本体共享 NormalizedPlot 形状；scrub 规则保持一致（秘密原文命中即丢弃）。
 * npc.plot.ts 重新导出本文件的两个函数，既有调用方（investigate 模块/测试）不用改路径。
 */
import type { ActorId, ModuleContext, ModuleOutcome, Proposal } from "../../packages/shared/src/contract/types.ts";

/** 与 npc.plot.ts 的 NormalizedPlot 同形（导演落账后的密谋快照）。 */
export interface NormalizedPlot {
  goal: string;
  actors: ActorId[];
  leakPoints: string[];
  forbidReveal: string;
  risk?: number;
  tone?: string;
  leverage?: string;
}

/** 秘密原文绝不能出现在任何可见文本里：命中就整段丢弃（宁可少一句，不可泄密）。 */
function scrub(secret: string, text: string): string | undefined {
  return secret && text.includes(secret) ? undefined : text;
}

/**
 * 玩家次日调查：按 leakPoints 产出 evidence 记忆 + 可问问题 + NPC 态度变化。
 *
 * attitudeAttr 由调用方（内容层模块/数据）显式传入；不给就不产 attr.delta。
 * 引擎没有 moduleState 写入口（issue #128），因此不再从 moduleState 读键——
 * 避免"看起来能配置、实际永远不生效"的假接线（I2：键名不写死在代码里）。
 * delta 同样由调用方从 content JSON 传入（P2-1：值也接线，缺省 8 只是兜底）。
 */
export function discoveryProposals(
  ctx: ModuleContext,
  plot: NormalizedPlot,
  kind: "observe" | "search" | "ask",
  opts?: { attitudeAttr?: string; delta?: number },
): ModuleOutcome {
  const proposals: Proposal[] = [];
  const questions: { key: string; text: string; meta?: unknown }[] = [];
  plot.leakPoints.forEach((leak, i) => {
    const safe = scrub(plot.forbidReveal, leak);
    if (!safe) return;
    questions.push({ key: `clue_${i}`, text: `关于「${safe}」，我能问点什么？`, meta: { leakPoint: safe, kind } });
    proposals.push({
      op: "memory.write",
      args: {
        ownerId: ctx.actorId,
        content: `调查记录（${kind}）：注意到「${safe}」，似乎与今晚在场者的私下谈话有关；真相尚不可确认。`,
        tags: ["evidence", "密谋", kind],
        salience: 5,
        visibility: "private",
        about: plot.actors,
      },
      reason: "玩家按 leakPoint 获得的证据记忆（只给线索，不给结论）",
      by: "npc.plot",
    });
  });
  // NPC 态度变化可见：键由调用方从 content JSON 传入（I2，代码不硬编码属性名）。
  // 未配置时只产证据记忆与可问线索，不产 attr.delta。
  const attitudeKey = opts?.attitudeAttr;
  if (attitudeKey) {
    for (const actor of plot.actors) {
      proposals.push({
        op: "attr.delta",
        args: { entityId: actor, key: attitudeKey, delta: opts?.delta ?? 8 },
        reason: "密谋次日 NPC 态度变化（戒备上升，玩家可从面板/语气看出）",
        by: "npc.plot",
      });
    }
  }
  return {
    ok: proposals.length > 0,
    proposals,
    facts: questions.length > 0 ? [`你注意到几处可疑线索（${kind}），可以据此追问。`] : [],
    ui: { lists: [{ id: "clue.questions", title: "可追问的线索", items: questions }] },
  };
}

/** 供模块宿主复用的"从状态里找出已落账密谋"入口（不改 op 闭集）。 */
export function activePlots(ctx: ModuleContext): NormalizedPlot[] {
  return ctx.state.plots
    .filter((p) => p.status === "active" && p.leakPoints && p.leakPoints.length > 0)
    .map((p) => ({
      goal: p.goal,
      actors: p.actors as ActorId[],
      leakPoints: p.leakPoints ?? [],
      forbidReveal: p.forbidReveal ?? "",
      ...(p.risk !== undefined ? { risk: p.risk } : {}),
      ...(p.tone !== undefined ? { tone: p.tone } : {}),
    }));
}
