/**
 * npc.plot.discovery —— 密谋的次日调查入口（从 npc.plot.ts 拆出，§6 文件 ≤300 行）。
 *
 * 与导演本体共享 NormalizedPlot 形状；scrub 规则保持一致（秘密原文命中即丢弃）。
 * npc.plot.ts 重新导出本文件的两个函数，既有调用方（investigate 模块/测试）不用改路径。
 *
 * PR #147 审阅 P2-4 / P1-3：幂等判定由调用方传入的持久标记（opts.investigatedLeaks）驱动；
 * 本文件保持纯计算——跳过已查 leak、每 plot 只动一次态度、全部查完才产出 status=leaked 收口。
 */
import type { ActorId, Id, ModuleContext, ModuleOutcome, Proposal } from "../../packages/shared/src/contract/types.ts";

/** 与 npc.plot.ts 的 NormalizedPlot 同形（导演落账后的密谋快照）。 */
export interface NormalizedPlot {
  /** 状态里 ctx.state.plots 的主键；activePlots 带上它，供 plot.upsert 收口定位。 */
  id?: Id;
  goal: string;
  actors: ActorId[];
  leakPoints: string[];
  forbidReveal: string;
  risk?: number;
  tone?: string;
  leverage?: string;
}

export interface DiscoveryOpts {
  attitudeAttr?: string;
  delta?: number;
  /** 已调查过的 leakPoints 下标（调用方从 ctx.state 的持久标记读出）。 */
  investigatedLeaks?: ReadonlySet<number>;
  /** 本次允许调查的下标子集（缺省 = 全部未查）；用于"只查一部分"。 */
  leakIndices?: readonly number[];
  /** 该 plot 是否已动过态度：重复/后续调查不再 +delta（缺省 true 保持旧调用语义）。 */
  attitudeDeltaEligible?: boolean;
}

export interface DiscoveryOutcome extends ModuleOutcome {
  /** 本次新调查的 leakPoints 下标（调用方据此写持久标记）。 */
  newlyInvestigated: number[];
  /** 该 plot 全部可查（未被 scrub 丢弃）leak 均已调查，含历史。 */
  allInvestigated: boolean;
}

/** 秘密原文绝不能出现在任何可见文本里：命中就整段丢弃（宁可少一句，不可泄密）。 */
function scrub(secret: string, text: string): string | undefined {
  return secret && text.includes(secret) ? undefined : text;
}

/**
 * 玩家次日调查：按 leakPoints 产出 evidence 记忆 + 可问问题 + NPC 态度变化。
 *
 * attitudeAttr 由调用方（内容层模块/数据）显式传入；不给就不产 attr.delta。
 * 幂等判定完全来自 opts.investigatedLeaks（调用方从 ctx.state 构造），本函数不持有
 * 任何进程内 Map —— 进程重启后仍按同一份 WorldState 判定。
 * delta 同样由调用方从 content JSON 传入（P2-1：值也接线，缺省 8 只是兜底）。
 */
export function discoveryProposals(
  ctx: ModuleContext,
  plot: NormalizedPlot,
  kind: "observe" | "search" | "ask",
  opts?: DiscoveryOpts,
): DiscoveryOutcome {
  const proposals: Proposal[] = [];
  const questions: { key: string; text: string; meta?: unknown }[] = [];
  const investigated = opts?.investigatedLeaks ?? new Set<number>();
  const selected = opts?.leakIndices ? new Set(opts.leakIndices) : undefined;
  const newlyInvestigated: number[] = [];
  const safeIndices: number[] = [];

  plot.leakPoints.forEach((leak, i) => {
    const safe = scrub(plot.forbidReveal, leak);
    if (!safe) return;
    safeIndices.push(i);
    if (investigated.has(i) || (selected && !selected.has(i))) return;
    newlyInvestigated.push(i);
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
  // 每条 plot 全程只动一次态度；后续调查同 plot 的其他 leak 不再 +delta。
  const attitudeKey = opts?.attitudeAttr;
  if (attitudeKey && newlyInvestigated.length > 0 && opts?.attitudeDeltaEligible !== false) {
    for (const actor of plot.actors) {
      proposals.push({
        op: "attr.delta",
        args: { entityId: actor, key: attitudeKey, delta: opts?.delta ?? 8 },
        reason: "密谋次日 NPC 态度变化（戒备上升，玩家可从面板/语气看出）",
        by: "npc.plot",
      });
    }
  }

  const allInvestigated =
    safeIndices.length > 0 && safeIndices.every((i) => investigated.has(i) || newlyInvestigated.includes(i));
  // 剧情生命周期收口（P1-3）：全部可查 leak 都已查完才转 leaked，释放 active 配额。
  // 必须带 id，否则 arbiter 会当新 plot 新建；goal/actors/leakPoints/forbidReveal 原样带上，
  // 避免 plot.upsert 覆盖时丢字段（arbiter.ops.ts:439-451 的缺省语义）。
  if (allInvestigated && newlyInvestigated.length > 0 && plot.id) {
    proposals.push({
      op: "plot.upsert",
      args: {
        id: plot.id,
        goal: plot.goal,
        actors: plot.actors,
        leakPoints: plot.leakPoints,
        ...(plot.forbidReveal ? { forbidReveal: plot.forbidReveal } : {}),
        ...(plot.leverage ? { leverage: plot.leverage } : {}),
        ...(plot.risk !== undefined ? { risk: plot.risk } : {}),
        ...(plot.tone ? { tone: plot.tone } : {}),
        status: "leaked",
      },
      reason: "全部 leakPoint 已调查，剧情线收口（释放 active 配额）",
      by: "npc.plot",
    });
  }

  return {
    ok: proposals.length > 0,
    proposals,
    facts: questions.length > 0 ? [`你注意到几处可疑线索（${kind}），可以据此追问。`] : [],
    ui: { lists: [{ id: "clue.questions", title: "可追问的线索", items: questions }] },
    newlyInvestigated,
    allInvestigated,
  };
}

/** 供模块宿主复用的"从状态里找出已落账密谋"入口（不改 op 闭集）。 */
export function activePlots(ctx: ModuleContext): NormalizedPlot[] {
  return ctx.state.plots
    .filter((p) => p.status === "active" && p.leakPoints && p.leakPoints.length > 0)
    .map((p) => ({
      id: p.id,
      goal: p.goal,
      actors: p.actors as ActorId[],
      leakPoints: p.leakPoints ?? [],
      forbidReveal: p.forbidReveal ?? "",
      ...(p.risk !== undefined ? { risk: p.risk } : {}),
      ...(p.tone !== undefined ? { tone: p.tone } : {}),
      ...(p.leverage !== undefined ? { leverage: p.leverage } : {}),
    }));
}
