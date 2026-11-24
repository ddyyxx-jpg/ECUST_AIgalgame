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
import type { Envelope, Id, LlmPort, Phase, Proposal, WorldState } from "../../../packages/shared/src/contract/types.ts";

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
export function buildDecisionOptions(state: WorldState, npcId: string, maxOptions: number): DecisionOption[] {
  const locId = locatedAt(state, npcId);
  if (!locId) return [];
  const here = state.entities[locId];
  if (!here) return [];
  const adj = locAdjacency(state);
  const options: DecisionOption[] = [{ index: 1, locId, label: `留在${here.name}，做自己的事` }];
  for (const next of adj.get(locId) ?? []) {
    if (options.length >= maxOptions) break;
    const loc = state.entities[next];
    if (loc?.kind === "loc" && loc.status === "active") {
      options.push({ index: options.length + 1, locId: next, label: `去${loc.name}` });
    }
  }
  return options;
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
export function parseDecision(raw: unknown, optionCount: number): { choice: number; reason?: string } | null {
  let value = raw;
  if (typeof raw === "string") {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const text = fenced?.[1] ?? raw;
    try {
      value = JSON.parse(text.trim());
    } catch {
      return null;
    }
  }
  const parsed = ChoiceSchema.safeParse(value);
  if (!parsed.success || parsed.data.choice > optionCount) return null;
  return parsed.data;
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

function emptyLease(raw: unknown): boolean {
  return raw === undefined || raw === "";
}

function hourKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13);
}

export class NpcDecisionService {
  private readonly calls = new Map<string, { hour: string; count: number }>();
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

    const candidates = this.candidates(snapshot, policy.maxPerBeat);
    for (const npcId of candidates) {
      const options = buildDecisionOptions(snapshot, npcId, policy.maxOptions);
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
      await this.applyLease(roomId, snapshot, npcId, option, open.reason);
    }
  }

  private candidates(state: WorldState, limit: number): string[] {
    const playerLoc = state.room.scene.locId;
    return Object.values(state.entities)
      .filter((e) => e.kind === "npc" && e.status === "active")
      .filter((e) => emptyLease(e.attrs[LEASE]))
      .filter((e) => locatedAt(state, e.id) !== playerLoc)
      .map((e) => e.id)
      .sort()
      .slice(0, limit);
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
      const parsed = parseDecision(result.json ?? result.raw, perception.options.length);
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
    if (!emptyLease(target.attrs[LEASE])) return;
    // 目标不是当前地点时先写 move，下一次 map tick 会沿最短路移动并把租约改成 stay。
    const lease = {
      action: option.locId === this.currentLoc(latest, npcId) ? "stay" : "move",
      target: option.locId,
      remaining: 2,
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
