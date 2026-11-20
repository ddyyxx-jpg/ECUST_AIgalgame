/**
 * npc.plot —— NPC 密谋导演（真实实现）。
 *
 * 职责（docs/04 §7.4 / issue #96）：
 *   1. 一次结构化 LLM 调用产出密谋草案（目标 / 参与者 / 泄漏点 / 不可直说的真相）；
 *   2. 对每一对参与者各一次 LLM 调用产出对谈摘要（最多 3 对），**不直播给玩家**；
 *   3. 密谋经 plot.upsert 落账；对每名参与者各写一条**视角不同**的私忆，
 *      秘密原文只放进 plot.forbidReveal 通道，绝不进任何可见文本。
 *
 * 导演只产出 Proposal，不写库。调用方（DialogueHost 的宿主）用 cause.type=dialogue
 * 把 proposals 交给 Arbiter —— 该来源被允许代写 NPC 私忆与 secret。
 *
 * 韧性：夜间编排不能阻塞玩家输入。每次 LLM 调用都套超时，失败/超时降级为空结果，
 * 单次调用不重试（失败不无限重试）；这是"join/超时降级"的落点，不需要改引擎。
 */
import { z } from "zod";
import type {
  ActorId,
  DialogueDirector,
  DialogueSession,
  DialogueStep,
  ModuleContext,
  ModuleOutcome,
  Proposal,
} from "../../packages/shared/src/contract/types.ts";

const LLM_TIMEOUT_MS = 800;

/** 泄漏点可以是纯字符串，也可以是 prompt 模板里的 {where,what,...} 结构；统一归一成短句。 */
const LeakInput = z.union([
  z.string().min(1),
  z.object({ where: z.string().optional(), what: z.string().optional(), hint: z.string().optional() }).passthrough(),
]);

const PlotDraftSchema = z.object({
  goal: z.string().min(1).max(120),
  actors: z.array(z.string().min(1)).min(2).max(8),
  leverage: z.string().max(200).optional(),
  risk: z.number().min(0).max(100).optional(),
  tone: z.string().max(40).optional(),
  leakPoints: z.array(LeakInput).min(1).max(8),
  forbidReveal: z.string().min(1).max(200),
});
type PlotDraft = z.infer<typeof PlotDraftSchema>;

const PairSchema = z.object({
  lines: z
    .array(z.object({ actorId: z.string(), text: z.string().min(1).max(400) }))
    .min(1)
    .max(6),
});

interface NormalizedPlot {
  goal: string;
  actors: ActorId[];
  leakPoints: string[];
  forbidReveal: string;
  risk?: number;
  tone?: string;
  leverage?: string;
}

/** LLM 返回 json:true 时优先用结构化字段；否则从 raw 里剥围栏再 JSON.parse。 */
function parseJson(raw: string, jsonField: unknown): unknown {
  if (jsonField !== undefined && jsonField !== null) return jsonField;
  const text = raw.replace(/^```(?:json)?/u, "").replace(/```$/u, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1)) as unknown;
  return JSON.parse(text) as unknown;
}

/** 单次调用 + 超时降级；失败返回 undefined，绝不重试。 */
async function chatJson(ctx: ModuleContext, messages: { role: "system" | "user"; content: string }[]): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = ctx.llm.chat({ messages, json: true, temperature: 0.7, maxTokens: 900, roomId: ctx.roomId });
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), LLM_TIMEOUT_MS);
    });
    const result = await Promise.race([call, timeout]);
    if (!result) return undefined;
    try {
      return parseJson(result.raw, result.json);
    } catch {
      return undefined; // E_LLM_FORMAT 等：降级，不重试
    }
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function leakToText(leak: z.infer<typeof LeakInput>): string {
  if (typeof leak === "string") return leak.trim().slice(0, 80);
  return [leak.where, leak.what, leak.hint].filter((s): s is string => typeof s === "string" && s.trim() !== "").join("·").slice(0, 80);
}

/** 把 LLM 草案收敛到本场真实在场的参与者，防止幻觉 id 进 plot.upsert（Arbiter 也会校验）。 */
function normalize(draft: PlotDraft, participants: readonly ActorId[]): NormalizedPlot {
  const live = new Set<string>(participants);
  const actors = [...new Set(draft.actors.filter((a) => live.has(a)))] as ActorId[];
  const safeActors = actors.length >= 2 ? actors : [...participants].slice(0, 8);
  return {
    goal: draft.goal.trim().slice(0, 120),
    actors: safeActors,
    leakPoints: [...new Set(draft.leakPoints.map(leakToText).filter((s) => s !== ""))].slice(0, 8),
    forbidReveal: draft.forbidReveal.trim().slice(0, 200),
    ...(draft.risk !== undefined ? { risk: draft.risk } : {}),
    ...(draft.tone !== undefined ? { tone: draft.tone } : {}),
    ...(draft.leverage !== undefined ? { leverage: draft.leverage } : {}),
  };
}

/** 所有可能的参与者配对，最多 3 对（#96：每对 1 次摘要，上限 3）。 */
export function actorPairs(actors: readonly ActorId[]): [ActorId, ActorId][] {
  const out: [ActorId, ActorId][] = [];
  for (let i = 0; i < actors.length && out.length < 3; i += 1) {
    for (let j = i + 1; j < actors.length && out.length < 3; j += 1) {
      const a = actors[i];
      const b = actors[j];
      if (a && b) out.push([a, b]);
    }
  }
  return out;
}

/** 秘密原文绝不能出现在任何可见文本里：命中就整段丢弃（宁可少一句，不可泄密）。 */
function scrub(secret: string, text: string): string | undefined {
  return secret && text.includes(secret) ? undefined : text;
}

const PLOT_STATE_KEY = "__npcPlotState";

interface PlotState {
  plot: NormalizedPlot;
  pairs: [ActorId, ActorId][];
  nextPair: number;
}

/** 结构化密谋落账：plot.upsert + 每名参与者一条不同视角的私忆。 */
export function conspiracyProposals(plot: NormalizedPlot): Proposal[] {
  const proposals: Proposal[] = [
    {
      op: "plot.upsert",
      args: {
        goal: plot.goal,
        actors: plot.actors,
        ...(plot.leverage !== undefined ? { leverage: plot.leverage } : {}),
        ...(plot.risk !== undefined ? { risk: plot.risk } : {}),
        ...(plot.tone !== undefined ? { tone: plot.tone } : {}),
        leakPoints: plot.leakPoints,
        forbidReveal: plot.forbidReveal,
      },
      reason: "夜间密谋编排落账（秘密只进 forbidReveal 通道）",
      by: "npc.plot",
    },
  ];
  // 视角化写入三硬规则（docs/04 §7.4）：每人不同叙述、逐 ownerId 写、秘密原文不进文本。
  // #123 P1-G：不能只换"第 N 视角"前缀；叙述本身按参与者轮换，避免多视角记忆正文雷同。
  const angles = [
    "你先开口把话引到「__HINT__」附近，随即察觉有人不愿接话。",
    "你多半在听，只记住有人反复提到「__HINT__」，语气比平时紧。",
    "你试着探口风，对方把话岔开，但「__HINT__」还是漏了出来。",
    "你负责望风，没听全，只记得「__HINT__」和某个人不安的停顿。",
  ];
  plot.actors.forEach((actor, index) => {
    const hint = plot.leakPoints[index % Math.max(plot.leakPoints.length, 1)] ?? "现场";
    const angle = angles[index % angles.length].replace("__HINT__", hint);
    const content = `第${index + 1}视角：今晚与在场者谈到一件还不能明说的事。${angle}细节先压在心底。`;
    const safe = scrub(plot.forbidReveal, content);
    if (!safe) return;
    proposals.push({
      op: "memory.write",
      args: {
        ownerId: actor,
        content: safe,
        tags: ["密谋", "夜间"],
        salience: 6,
        visibility: "private",
        about: plot.actors.filter((a) => a !== actor),
      },
      reason: "密谋参与者的单视角私忆（与他人文本不同，不含秘密原文）",
      by: "npc.plot",
    });
  });
  return proposals;
}

/** 玩家次日调查：按 leakPoints 产出 evidence 记忆 + 可问问题 + NPC 态度变化。 */
export function discoveryProposals(ctx: ModuleContext, plot: NormalizedPlot, kind: "observe" | "search" | "ask"): ModuleOutcome {
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
  // NPC 态度变化可见：给每名密谋参与者叠加可配置的戒备属性（键来自模块数据，不硬编码属性名）。
  const attitudeKey = typeof ctx.state.moduleState["npc.plot.attitudeAttr"] === "string"
    ? (ctx.state.moduleState["npc.plot.attitudeAttr"] as string)
    : undefined;
  if (attitudeKey) {
    for (const actor of plot.actors) {
      proposals.push({
        op: "attr.delta",
        args: { entityId: actor, key: attitudeKey, delta: 8 },
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

const director: DialogueDirector = {
  id: "npc.plot",

  async nextTurn(session: DialogueSession, ctx: ModuleContext): Promise<DialogueStep> {
    // #123 P0-D：DialogueHost 在 advance 里已把 session.turn +1；这里再加 1 会让首轮判断永不成立。
    const turn = session.turn;
    const base = { sessionId: session.id, turn };
    const participants = session.participants;

    // 第 1 轮：结构化密谋 + 第一对摘要
    if (turn === 1 && participants.length >= 2) {
      const raw = await chatJson(ctx, [
        { role: "system", content: "你是密谋编排器。只输出 JSON：{goal,actors[],leverage?,risk?,tone?,leakPoints[],forbidReveal}。leakPoints 是可被调查的痕迹，forbidReveal 是绝不可出现在任何台词/记忆里的真相。" },
        { role: "user", content: `参与者：${participants.join(",")}。产出一场密谋。` },
      ]);
      const parsed = raw === undefined ? undefined : PlotDraftSchema.safeParse(raw);
      if (!parsed?.success) return { ...base, utterances: [], proposals: [], done: turn >= session.maxTurns };
      const plot = normalize(parsed.data, participants);
      const pairs = actorPairs(plot.actors);
      session.seed[PLOT_STATE_KEY] = { plot, pairs, nextPair: 1 } satisfies PlotState;
      const proposals = conspiracyProposals(plot);
      const first = pairs[0];
      const utterances = first ? await pairSummary(ctx, first, plot) : [];
      return { ...base, utterances, proposals, done: pairs.length <= 1 || turn >= session.maxTurns };
    }

    // 后续轮：每轮一对摘要；没有更多配对就收束
    const state = session.seed[PLOT_STATE_KEY] as PlotState | undefined;
    if (!state) return { ...base, utterances: [], proposals: [], done: true };
    const pair = state.pairs[state.nextPair];
    if (!pair) return { ...base, utterances: [], proposals: [], done: true };
    state.nextPair += 1;
    const utterances = await pairSummary(ctx, pair, state.plot);
    return { ...base, utterances, proposals: [], done: state.nextPair >= state.pairs.length || turn >= session.maxTurns };
  },
};

/** 每对参与者一次对话摘要；输出只作为 private dialogue，不进玩家叙事。 */
async function pairSummary(ctx: ModuleContext, pair: [ActorId, ActorId], plot: NormalizedPlot): Promise<{ actorId: ActorId; text: string }[]> {
  const raw = await chatJson(ctx, [
    { role: "system", content: "只输出 JSON：{lines:[{actorId,text}]}。每人一句压低声音的短谈，围绕 leaks，绝不说出 forbidReveal 原文。" },
    { role: "user", content: `参与者：${pair.join(",")}；线索：${plot.leakPoints.join("；")}；不可说：${plot.forbidReveal}。` },
  ]);
  const parsed = raw === undefined ? undefined : PairSchema.safeParse(raw);
  if (!parsed?.success) return [];
  const allowed = new Set<string>(pair);
  return parsed.data.lines
    .filter((l) => allowed.has(l.actorId))
    .map((l) => ({ actorId: l.actorId as ActorId, text: scrub(plot.forbidReveal, l.text) ?? "" }))
    .filter((l) => l.text !== "");
}

export default director;
