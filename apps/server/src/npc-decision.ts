/**
 * WorldX 风格的 NPC 自由活动决策（感知投影 → 编号菜单 → 单选 JSON）。
 *
 * 只做三件事：从状态里挑出"闲着的 NPC"、把可见信息投影成短提示词、把模型选中的
 * 编号翻译成一条 `sim_lease`。不直接移动、不写记忆、不新增 op；真正的移动仍由
 * map 模块下一次 tick 按租约执行（Proposal → Arbiter）。
 *
 * 默认关闭（content/sim/policy.json 的 decision.enabled=false）：这是唯一会给每个
 * NPC 花 LLM 钱的循环，必须由内容配置显式打开，并受 maxPerBeat/hourlyCalls 限制。
 */
import { z } from "zod";

/** 调试开关：GALGAME_DEBUG_SIM=1 时打印每次决策的模型原文与落库结果（试玩验收用）。 */
const dbg = (...args: unknown[]) => {
  if (process.env.GALGAME_DEBUG_SIM === "1") console.log("[sim-dbg]", ...args);
};
import type { Envelope, Id, LlmPort, Phase, Proposal, WorldState } from "../../../packages/shared/src/contract/types.ts";
import { clockIndex, parseLease } from "../../../content/modules/map/lease.ts";

const LEASE = "sim_lease";
const PHASE_LABEL: Record<Phase, string> = {
  morning: "早上",
  noon: "中午",
  afternoon: "下午",
  evening: "傍晚",
  night: "夜里",
};

export interface NpcDecisionPolicy {
  enabled: boolean;
  /** 每一拍最多让几个 NPC 决策 */
  maxPerBeat: number;
  /** 每多少个 tick 决策一次（0/1 = 每拍） */
  intervalTicks: number;
  /** 每房间每小时最多调用多少次模型 */
  hourlyCalls: number;
  /** 菜单最多几个选项（含"留下"） */
  maxOptions: number;
}

export interface DecisionOption {
  index: number;
  locId: string;
  label: string;
}

export interface NpcPerception {
  npcId: Id;
  npcName: string;
  locId: Id;
  locName: string;
  text: string;
  options: DecisionOption[];
}

interface StoreLike {
  snapshot(roomId: string): Promise<WorldState>;
  /** 可选：用于 apply 的 expectedSeq，避免慢决策覆盖玩家刚写入的 talk 租约 */
  load?(roomId: string): Promise<number>;
}

interface ArbiterLike {
  apply(roomId: string, ops: Proposal[], cause: Envelope, opts?: { captureState?: boolean; expectedSeq?: number }): Promise<{
    ok: boolean;
    rejected?: { code?: string; detail?: string }[];
    error?: { code?: string; message?: string };
  }>;
}

export interface NpcDecisionDeps {
  store: StoreLike;
  arbiter: ArbiterLike;
  llm: LlmPort;
  policy: NpcDecisionPolicy;
  now?: () => number;
  warn?: (message: string) => void;
}

const ChoiceSchema = z.object({
  choice: z.number().int().min(1).max(20),
  reason: z.string().max(160).optional(),
});

/** 只把 active 的 NPC 地点做双向邻接，和 map 模块的 located_in 图同源。 */
export function locAdjacency(state: WorldState): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const e of Object.values(state.entities)) {
    if (e.kind === "loc" && e.status === "active") adj.set(e.id, []);
  }
  for (const link of state.links) {
    if (link.kind !== "located_in") continue;
    const from = state.entities[link.from];
    const to = state.entities[link.to];
    if (from?.kind !== "loc" || to?.kind !== "loc" || from.status !== "active" || to.status !== "active") continue;
    adj.get(link.from)?.push(link.to);
    adj.get(link.to)?.push(link.from);
  }
  for (const list of adj.values()) list.sort();
  return adj;
}

function locatedAt(state: WorldState, actorId: string): string | undefined {
  return state.links
    .filter((l) => l.kind === "located_in" && l.from === actorId)
    .map((l) => l.to)
    .find((id) => state.entities[id]?.kind === "loc" && state.entities[id]?.status === "active");
}

/** 菜单只给"留下 + 相邻地点"，避免 NPC 跨半个校园凭空决定；真正的路径仍由 map 模块算。 */
export function buildDecisionOptions(
  state: WorldState,
  npcId: string,
  maxOptions: number,
  opts: { allowStay?: boolean } = {},
): DecisionOption[] {
  const locId = locatedAt(state, npcId);
  if (!locId) return [];
  const here = state.entities[locId];
  if (!here) return [];
  const adj = locAdjacency(state);
  const moves: DecisionOption[] = [];
  for (const next of adj.get(locId) ?? []) {
    const loc = state.entities[next];
    if (loc?.kind === "loc" && loc.status === "active") {
      moves.push({ index: 0, locId: next, label: `去${loc.name}` });
    }
  }
  // 模型几乎总选 1（留下），固定钉在原地；每隔几拍把「留下」拿掉，让它主动换个地方。
  // 但只有至少两个相邻地点时才这么做——否则菜单只剩一项，等于不让它决策。
  const withStay = opts.allowStay !== false || moves.length < 2;
  const raw = withStay
    ? [{ index: 0, locId, label: `留在${here.name}，做自己的事` }, ...moves]
    : moves;
  return raw.slice(0, maxOptions).map((o, i) => ({ ...o, index: i + 1 }));
}

/** 感知只取公开信息：地点、时段、在场者姓名；不读 attrs/memory/plot，避免把秘密喂给决策。 */
export function buildPerception(state: WorldState, npcId: string, options: DecisionOption[]): NpcPerception | null {
  const npc = state.entities[npcId];
  const locId = locatedAt(state, npcId);
  if (!npc || npc.kind !== "npc" || !locId) return null;
  const loc = state.entities[locId];
  if (!loc) return null;
  // 以 NPC 所在地点为准，而不是玩家镜头：决策的是"这个 NPC 此刻能看到谁"。
  const present = Object.values(state.entities)
    .filter((e) => e.id !== npcId && e.status === "active" && (e.kind === "npc" || e.kind === "plr"))
    .filter((e) => locatedAt(state, e.id) === locId)
    .map((e) => e.name)
    .sort();
  const lines = [
    `你是${npc.name}。现在是第${state.clock.day}天${PHASE_LABEL[state.clock.phase] ?? state.clock.phase}，第${state.clock.tick}刻。`,
    `你在${loc.name}。`,
    present.length > 0 ? `在场的人：${present.join("、")}。` : "周围没有别人。",
    "你只知道自己在场看到、听到的事，不知道别人的秘密，也不要提到系统、数值或玩家。",
    "",
    "你可以从下面选一件事做（只选编号）：",
    ...options.map((o) => `${o.index}. ${o.label}`),
  ];
  return { npcId, npcName: npc.name, locId, locName: loc.name, text: lines.join("\n"), options };
}

/** 解析模型 JSON；兼容 ```json 包裹与多余的说明文字。失败返回 null，由确定性 fallback 接手。 */
/** 从自由文本里抠最后一个 {…}（含 choice 的才认），用于思考型模型把 JSON 夹在推理后面的情况。 */
function lastJsonObject(text: string): unknown {
  let start = -1;
  let depth = 0;
  let found: unknown = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const slice = text.slice(start, i + 1);
        start = -1;
        try {
          const parsed = JSON.parse(slice) as unknown;
          if (parsed !== null && typeof parsed === "object" && hasChoiceKey(parsed as Record<string, unknown>)) found = parsed;
        } catch {
          /* 半截 JSON：忽略，继续找下一个 */
        }
      }
      if (depth < 0) depth = 0;
    }
  }
  return found;
}

const CHOICE_KEYS = ["choice", "option", "index", "action"] as const;

function hasChoiceKey(o: Record<string, unknown>): boolean {
  return CHOICE_KEYS.some((k) => k in o);
}

/** 从模型常见输出形态里取编号：{"choice":2} / {"option":"2"} / {"action":1} / {"action":"留在食堂"} / 2 */
function extractChoice(value: unknown, options: readonly DecisionOption[]): { choice: number; reason?: string } | null {
  const fromNumber = (n: number): { choice: number; reason?: string } | null =>
    Number.isInteger(n) && n >= 1 && n <= options.length ? { choice: n } : null;
  if (typeof value === "number") return fromNumber(value);
  if (typeof value === "string") {
    const t = value.trim();
    if (/^\d+$/.test(t)) return fromNumber(Number(t));
    if (/留|呆|待|原地|stay|remain/i.test(t)) {
      // 只有第一个选项真的是"留下"时才映射成 1：去掉 stay 选项后，1 号是"去某地"，
      // 把 "stay" 硬映射成 1 会把想留下的 NPC 送去别处。
      const first = options[0];
      const isStay = first ? /留|呆|待|原地|stay|remain/i.test(first.label) : false;
      return isStay ? { choice: 1, reason: t.slice(0, 40) } : null;
    }
    const hit = options.find((o) => o.locId === t || t.includes(o.label) || o.label.includes(t));
    return hit ? { choice: hit.index, reason: t.slice(0, 40) } : null;
  }
  if (value === null || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  for (const key of CHOICE_KEYS) {
    if (!(key in o)) continue;
    const got = extractChoice(o[key], options);
    if (got) return got;
  }
  return null;
}

export function parseDecision(raw: unknown, options: readonly DecisionOption[]): { choice: number; reason?: string } | null {
  let value = raw;
  if (typeof raw === "string") {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const text = fenced?.[1] ?? raw;
    try {
      value = JSON.parse(text.trim());
    } catch {
      value = lastJsonObject(text);
      if (value === null) return null;
    }
  }
  const strict = ChoiceSchema.safeParse(value);
  if (strict.success && strict.data.choice <= options.length) return strict.data;
  const loose = extractChoice(value, options);
  return loose;
}

/** 无模型/坏输出时的确定性选择：同房间同 NPC 同时刻永远同一结果，便于回放。 */
export function fallbackChoice(roomId: string, npcId: string, state: WorldState, optionCount: number): number {
  const key = `${roomId}:${npcId}:${state.clock.day}:${state.clock.phase}:${state.clock.tick}`;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % Math.max(1, optionCount);
}

/**
 * 空闲 = 没租约，或只是「原地停留」。
 *
 * 为什么 stay 算空闲：日程每拍都会给每个 NPC 写 `stay remaining:2`，如果 stay 也算占用，
 * 候选集永远是空、NPC 再也不动（试玩反馈的根因之一）。为了不让"停留"被每拍反复改主意，
 * 决策侧另有每 NPC 3 拍的冷却（见 candidates），占用时间由冷却而不是租约表达。
 */
function idleLease(raw: unknown): boolean {
  const lease = parseLease(raw);
  return lease === null || lease.action === "stay";
}

function hourKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13);
}

export class NpcDecisionService {
  private readonly calls = new Map<string, { hour: string; count: number }>();
  /** 每个 NPC 上次被决策的绝对刻度；只在这里做冷却，避免「留一下又走」的来回抽动 */
  private readonly lastDecided = new Map<string, number>();
  private static readonly DECIDE_COOLDOWN_TICKS = 3;
  private readonly warn: (message: string) => void;
  private readonly now: () => number;

  constructor(private readonly deps: NpcDecisionDeps) {
    this.warn = deps.warn ?? ((m) => console.warn(m));
    this.now = deps.now ?? Date.now;
  }

  /** 由自动时钟在每次 tick 前调用；没有候选/关闭时直接返回，不产生任何状态。 */
  async run(roomId: string, state?: WorldState): Promise<void> {
    const policy = this.deps.policy;
    if (!policy.enabled) return;
    const snapshot = state ?? (await this.deps.store.snapshot(roomId));
    if (policy.intervalTicks > 1 && snapshot.clock.tick % policy.intervalTicks !== 0) return;

    const hour = hourKey(this.now());
    const used = this.calls.get(roomId);
    if (used && used.hour === hour && used.count >= policy.hourlyCalls) return;

    const candidates = this.candidates(snapshot, roomId, policy.maxPerBeat);
    for (const npcId of candidates) {
      const options = buildDecisionOptions(snapshot, npcId, policy.maxOptions, {
        allowStay: snapshot.clock.tick % 3 !== 0,
      });
      if (options.length < 2) continue;
      const perception = buildPerception(snapshot, npcId, options);
      if (!perception) continue;
      if (!this.takeCallBudget(roomId, hour)) return;
      const picked = await this.ask(roomId, perception);
      const open = picked ?? {
        choice: fallbackChoice(roomId, npcId, snapshot, options.length) + 1,
        reason: "fallback",
      };
      const option = options[Math.max(0, Math.min(options.length - 1, open.choice - 1))];
      if (!option) continue;
      dbg(`pick ${npcId} choice=${open.choice}/${options.length} → ${option.locId} 「${option.label}」(${open.reason ?? "-"})`);
      await this.applyLease(roomId, snapshot, npcId, option, open.reason);
      // 写租约成功后才记冷却：失败不该白吃 3 拍
      this.lastDecided.set(`${roomId}:${npcId}`, clockIndex(snapshot.clock));
      dbg(`lease ${npcId} → ${option.locId} 「${option.label}」`);
    }
  }

  private candidates(state: WorldState, roomId: string, limit: number): string[] {
    const at = clockIndex(state.clock);
    const all = Object.values(state.entities)
      .filter((e) => e.kind === "npc" && e.status === "active")
      .filter((e) => idleLease(e.attrs[LEASE]))
      .filter((e) => at - (this.lastDecided.get(`${roomId}:${e.id}`) ?? -999) >= NpcDecisionService.DECIDE_COOLDOWN_TICKS)
      .map((e) => e.id)
      .sort();
    if (all.length === 0) return [];
    // 轮转起点随 tick 走：固定取前 N 个会让排在前面的 NPC 永远被决策、后面的永远不动。
    const offset = at % all.length;
    const picked: string[] = [];
    for (let i = 0; i < Math.min(limit, all.length); i += 1) picked.push(all[(offset + i) % all.length]!);
    return picked;
    // 不再排除“与玩家同地点”的 NPC：玩家在场时也需要看到别人起身走动/离开，
    // 否则固定地点（食堂/图书馆）里的人永远不动。
  }

  private takeCallBudget(roomId: string, hour: string): boolean {
    const used = this.calls.get(roomId);
    if (!used || used.hour !== hour) {
      this.calls.set(roomId, { hour, count: 1 });
      return true;
    }
    if (used.count >= this.deps.policy.hourlyCalls) return false;
    used.count += 1;
    return true;
  }

  private async ask(roomId: string, perception: NpcPerception): Promise<{ choice: number; reason?: string } | null> {
    try {
      const result = await this.deps.llm.chat({
        messages: [
          { role: "system", content: perception.text },
          // 部分 OpenAI 兼容网关对「只有 system 没有 user」很敏感（只会续写协议文本）
          { role: "user", content: "请从上面的选项里选一个，只输出 JSON。" },
        ],
        json: true,
        purpose: "decision",
        temperature: 0.8,
        maxTokens: 120,
        roomId,
        actorId: perception.npcId,
      });
      dbg(`decision ${perception.npcId} raw(len=${result.raw.length},finish=${result.finishReason ?? "?"})`, result.raw.replace(/\s+/g, " ").slice(0, 240));
      const parsed = parseDecision(result.json ?? result.raw, perception.options);
      if (!parsed) this.warn(`[npc-decision] ${perception.npcId} 输出无法解析，使用确定性 fallback`);
      return parsed;
    } catch (e) {
      this.warn(`[npc-decision] ${perception.npcId} 决策失败，使用确定性 fallback：${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  private async applyLease(roomId: string, state: WorldState, npcId: string, option: DecisionOption, reason?: string): Promise<void> {
    // 决策可能很慢；写入前重读一次，若玩家已经写了 talk 租约就放弃，避免覆盖对话冻结。
    const seq = this.deps.store.load ? await this.deps.store.load(roomId) : undefined;
    const latest = await this.deps.store.snapshot(roomId);
    // 决策可能跨 phase：旧的菜单/位置已经过期，直接放弃，等下一拍重新决策。
    if (latest.clock.phase !== state.clock.phase) {
      this.warn(`[npc-decision] ${npcId} 决策跨 phase（${state.clock.phase}→${latest.clock.phase}），放弃本次写入`);
      return;
    }
    const target = latest.entities[npcId];
    if (target?.kind !== "npc" || target.status !== "active") return;
    if (!idleLease(target.attrs[LEASE])) return;
    // 目标不是当前地点时先写 move，下一次 map tick 会沿最短路移动并把租约改成 stay。
    const lease = {
      action: option.locId === this.currentLoc(latest, npcId) ? "stay" : "move",
      target: option.locId,
      remaining: option.locId === this.currentLoc(latest, npcId) ? 2 : 1,
      phase: latest.clock.phase,
    } satisfies { action: "stay" | "move"; target: string; remaining: number; phase: Phase };
    const cause: Envelope = {
      v: 1,
      id: `evt_sim_decide_${Math.random().toString(16).slice(2, 10)}`,
      roomId,
      seq: 0,
      ts: this.now(),
      actorId: "system",
      type: "tick",
      payload: {},
    };
    const proposal: Proposal = {
      op: "attr.set",
      args: { entityId: npcId, key: LEASE, value: JSON.stringify(lease) },
      reason: `NPC 自由活动：${option.label}${reason ? `（${reason}）` : ""}`,
      by: "tick",
    };
    try {
      const applied = await this.deps.arbiter.apply(roomId, [proposal], cause, {
        captureState: false,
        ...(seq === undefined ? {} : { expectedSeq: seq }),
      });
      const rejected = applied.rejected?.[0];
      if (!applied.ok || rejected) {
        this.warn(`[npc-decision] ${npcId} 租约写入被拒：${rejected?.detail ?? applied.error?.message ?? "unknown"}`);
      }
    } catch (e) {
      this.warn(`[npc-decision] ${npcId} 租约写入失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private currentLoc(state: WorldState, npcId: string): string | undefined {
    return locatedAt(state, npcId);
  }
}
