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

import type { NormalizedPlot } from "./npc.plot.discovery.ts";

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

/**
 * 视角化模板（docs/04 §7.4 硬规则①）：同一事实对每个 ownerId 用不同叙述，
 * 禁止"只换前缀、正文逐字复用"。按 index 选模板（并轮换线索），保证任意两名参与者文本不同。
 */
const PERSPECTIVES: readonly ((hint: string) => string)[] = [
  (hint) => `是我先把话挑明的：今晚的事先压着，线索留在「${hint}」附近，别声张。`,
  (hint) => `有人压低声音交代我盯住「${hint}」那一带，具体内幕先别追问。`,
  (hint) => `我负责望风，隐约听他们说线索跟「${hint}」有关，先记在心里。`,
  (hint) => `在场的人绕着「${hint}」谈了半天，我只听个大概，细节先按下。`,
];

function perspectiveContent(plot: NormalizedPlot, index: number): string {
  const hint = plot.leakPoints[index % Math.max(plot.leakPoints.length, 1)] ?? "现场";
  const template = PERSPECTIVES[index % PERSPECTIVES.length];
  return template ? template(hint) : `我参与了今晚的谈话，记得线索在「${hint}」附近，先不细说。`;
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
  plot.actors.forEach((actor, index) => {
    const content = perspectiveContent(plot, index);
    const safe = scrub(plot.forbidReveal, content);
    if (!safe) return;
    proposals.push({
      op: "memory.write",
      args: {
        ownerId: actor,
        content: safe,
        tags: ["密谋", "夜间"],
        salience: 5,
        visibility: "private",
        about: plot.actors.filter((a) => a !== actor),
      },
      reason: "密谋参与者的单视角私忆（与他人文本不同，不含秘密原文）",
      by: "npc.plot",
    });
  });
  return proposals;
}

// 调查入口拆到 npc.plot.discovery.ts（§6 文件 ≤300 行）；这里重导出保持既有调用路径。
export { activePlots, discoveryProposals } from "./npc.plot.discovery.ts";

const director: DialogueDirector = {
  id: "npc.plot",

  async nextTurn(session: DialogueSession, ctx: ModuleContext): Promise<DialogueStep> {
    // DialogueHost.advance 已在调用本方法前执行 s.turn += 1（dialogue.ts:85）：
    // 首步传入的 session.turn 就是 1。若这里再 +1，turn===1 分支永不命中、seed 恒空（PR #123 P0-D）。
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
      const utterances = first ? await pairSummary(ctx, first, plot, 0) : [];
      return { ...base, utterances, proposals, done: pairs.length <= 1 || turn >= session.maxTurns };
    }

    // 后续轮：每轮一对摘要；没有更多配对就收束
    const state = session.seed[PLOT_STATE_KEY] as PlotState | undefined;
    if (!state) return { ...base, utterances: [], proposals: [], done: true };
    const pairIndex = state.nextPair;
    const pair = state.pairs[pairIndex];
    if (!pair) return { ...base, utterances: [], proposals: [], done: true };
    state.nextPair += 1;
    const utterances = await pairSummary(ctx, pair, state.plot, pairIndex);
    return { ...base, utterances, proposals: [], done: state.nextPair >= state.pairs.length || turn >= session.maxTurns };
  },
};

/** 每对只拿到自己那部分线索（docs/04 §7.4「各自只知自己那部分」），不共享全量 leakPoints。 */
const PAIR_LIMIT = 3;

export function pairLeaks(leaks: readonly string[], pairIndex: number): string[] {
  return leaks.filter((_, i) => i % PAIR_LIMIT === pairIndex % PAIR_LIMIT);
}

/** 每对参与者一次对话摘要；输出只作为 private dialogue，不进玩家叙事。 */
async function pairSummary(
  ctx: ModuleContext,
  pair: [ActorId, ActorId],
  plot: NormalizedPlot,
  pairIndex: number,
): Promise<{ actorId: ActorId; text: string }[]> {
  const ownLeaks = pairLeaks(plot.leakPoints, pairIndex);
  const raw = await chatJson(ctx, [
    // 秘密原文不进 prompt，只在生成侧用 scrub 兜底（docs/04 §7.4 硬规则③ / AGENTS.md §5）。
    { role: "system", content: "只输出 JSON：{lines:[{actorId,text}]}。每人一句压低声音的短谈，只围绕分给你的线索，绝不写出任何尚未公开的真相或秘密原文。" },
    { role: "user", content: `参与者：${pair.join(",")}；你这一对知道的线索：${ownLeaks.join("；") || "无"}。别追问别人那部分。` },
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
