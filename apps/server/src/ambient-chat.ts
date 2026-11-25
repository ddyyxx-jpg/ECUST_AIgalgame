/**
 * NPC 之间的环境闲聊（只做"看得见的气泡"，不写世界状态）。
 *
 * 设计约束：
 * - 不进 EventLog、不写记忆：这是氛围层，失败了最多没气泡，不能影响存档；
 * - 只在内存里留一个有 TTL 的环形缓冲，`/map` 把它带给前端画气泡；
 * - 每拍每房间最多一次短调用（1~2 句），失败只 warn，不重试。
 */
import { z } from "zod";
import type { LlmPort, WorldState } from "../../../packages/shared/src/contract/types.ts";

const BurstSchema = z.array(
  z.object({
    speaker: z.string().min(1).max(24),
    line: z.string().min(1).max(60),
  }),
);

export interface AmbientLine {
  id: string;
  roomId: string;
  locId: string;
  speakerId: string;
  speaker: string;
  text: string;
  at: number;
}

export interface AmbientChatDeps {
  store: { listRooms(): Promise<string[]>; snapshot(roomId: string): Promise<WorldState> };
  llm: LlmPort;
  now?: () => number;
  warn?: (message: string) => void;
  /** 死房间判断：为 true 则本拍跳过（由 RoomActivity 提供） */
  isIdle?: (roomId: string) => boolean;
}

export interface AmbientChatPolicy {
  enabled: boolean;
  intervalMs: number;
  ttlMs: number;
  /** 每房间最多同时展示几条（默认 3） */
  maxBubbles?: number;
  /** 只在最近这么多毫秒内活跃过的房间产气泡（默认 10 分钟，避免给几十个死房间烧钱） */
  activeWithinMs?: number;
  /** 每拍最多处理几个房间（默认 3，按最近活跃排序） */
  maxRoomsPerBeat?: number;
}

const SYSTEM = [
  "你在为一部校园题材文字游戏写 NPC 之间的随口闲聊。",
  "要求：只输出 JSON 数组，1~2 句，每句不超过 40 字；不要旁白、不要动作描写、不要解释。",
  '格式：[{"speaker":"说话人名字（必须来自给出的在场名单）","line":"台词"}]',
  "内容要生活化、有信息量（谁在忙什么、哪里发生了事），不要替玩家发言。",
].join("\n");

export class AmbientChat {
  private timer?: NodeJS.Timeout;
  private beating = false;
  private readonly byRoom = new Map<string, AmbientLine[]>();
  private readonly now: () => number;
  private readonly warn: (message: string) => void;

  constructor(
    private readonly deps: AmbientChatDeps,
    private readonly policy: AmbientChatPolicy,
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.warn = deps.warn ?? ((m) => console.warn(m));
  }

  start(): void {
    if (!this.policy.enabled || this.policy.intervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => void this.beat(), this.policy.intervalMs);
    this.timer.unref?.();
    console.log(`[ambient] NPC 闲聊已启用：每 ${this.policy.intervalMs}ms 一轮，气泡保留 ${this.policy.ttlMs}ms`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.byRoom.clear();
  }

  /** 给 /map 读的气泡：只返回未过期的、每个说话人只留最后一句。 */
  recent(roomId: string): AmbientLine[] {
    const now = this.now();
    const fresh = (this.byRoom.get(roomId) ?? []).filter((l) => now - l.at <= this.policy.ttlMs);
    const latest = new Map<string, AmbientLine>();
    for (const line of fresh) latest.set(line.speakerId, line);
    return [...latest.values()].slice(-(this.policy.maxBubbles ?? 3));
  }

  async beat(): Promise<void> {
    if (this.beating) return;
    this.beating = true;
    try {
      const picked: string[] = [];
      for (const roomId of await this.deps.store.listRooms()) {
        if (this.deps.isIdle?.(roomId)) continue;
        picked.push(roomId);
      }
      for (const roomId of picked.slice(0, this.policy.maxRoomsPerBeat ?? 3)) {
        try {
          await this.burst(roomId);
        } catch (e) {
          this.warn(`[ambient] 房间 ${roomId} 闲聊失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      this.beating = false;
    }
  }

  private async burst(roomId: string): Promise<void> {
    const state = await this.deps.store.snapshot(roomId);
    const byLoc = new Map<string, { id: string; name: string }[]>();
    for (const entity of Object.values(state.entities)) {
      if (entity.kind !== "npc" || entity.status !== "active") continue;
      const loc = locatedAt(state, entity.id);
      if (!loc) continue;
      const list = byLoc.get(loc) ?? [];
      list.push({ id: entity.id, name: entity.name });
      byLoc.set(loc, list);
    }
    const playerLoc = state.room.scene.locId;
    const atPlayer = byLoc.get(playerLoc) ?? [];
    const chosen = atPlayer.length >= 2 ? atPlayer : [...byLoc.values()].sort((a, b) => b.length - a.length)[0];
    if (!chosen || chosen.length < 2) return;
    const locId = locatedAt(state, chosen[0]!.id) ?? playerLoc;
    const locName = state.entities[locId]?.name ?? locId;
    const names = chosen.map((n) => n.name);
    const result = await this.deps.llm.chat({
      // 用 turn 档预算：思考型模型会先写推理，conversation 档（2000）不够会截断。
      purpose: "turn",
      json: true,
      temperature: 0.9,
      maxTokens: 200,
      roomId,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `地点：${locName}。在场：${names.join("、")}。` },
      ],
    });
    // 模型有时只返回一个对象而不是数组（"只有一句"时尤其常见）：两种形态都接。
    const rawJson = result.json ?? extractBurst(result.raw) ?? null;
    const candidate = Array.isArray(rawJson)
      ? rawJson
      : rawJson && typeof rawJson === "object"
        ? [rawJson]
        : rawJson;
    const parsed = BurstSchema.safeParse(candidate);
    if (!parsed.success) {
      // 思考型模型常把数组夹在推理文字里，甚至先输出一个"计划"对象：打印长度与结尾，便于判断是否截断。
      const tail = result.raw.slice(-120).replace(/\s+/g, " ");
      this.warn(`[ambient] 房间 ${roomId} 闲聊输出不可用（len=${result.raw.length}，finish=${result.finishReason ?? "?"}）：…${tail}`);
      return;
    }
    const at = this.now();
    const lines: AmbientLine[] = [];
    for (const item of parsed.data) {
      const who = chosen.find((n) => n.name === item.speaker);
      if (!who) continue;
      lines.push({
        id: `amb_${at}_${who.id}`,
        roomId,
        locId,
        speakerId: who.id,
        speaker: who.name,
        text: item.line,
        at,
      });
    }
    if (lines.length === 0) return;
    const kept = [...(this.byRoom.get(roomId) ?? []), ...lines].slice(-24);
    this.byRoom.set(roomId, kept);
  }
}

function locatedAt(state: WorldState, entityId: string): string | undefined {
  const link = state.links.find((l) => l.kind === "located_in" && l.from === entityId);
  return link?.to;
}

/** 模型偶尔会带 ```json 围栏或前后缀；只为容错，不承诺通用 JSON 修复。 */
/**
 * 从模型输出里找最后一个能解析成「说话人/台词」数组的 JSON 片段。
 *
 * 思考型模型会先写推理（甚至先给一个 plan 对象）再给数组，`indexOf("[")` 会从
 * 推理里的方括号开始截，得到半个数组。这里从末尾往前找每个 `]`，回溯配平的 `[`，
 * 逐个尝试解析，取第一个通过 BurstSchema 的候选。
 */
function extractBurst(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? text).trim();
  for (let end = body.lastIndexOf("]"); end >= 0; end = body.lastIndexOf("]", end - 1)) {
    let depth = 0;
    let start = -1;
    for (let i = end; i >= 0; i -= 1) {
      const ch = body[i];
      if (ch === "]") depth += 1;
      else if (ch === "[") {
        depth -= 1;
        if (depth === 0) {
          start = i;
          break;
        }
      }
    }
    if (start < 0) continue;
    try {
      const value = JSON.parse(body.slice(start, end + 1)) as unknown;
      if (BurstSchema.safeParse(value).success) return value;
    } catch {
      // 继续尝试更靠前的一组括号
    }
  }
  // 只有一句话时模型经常直接返回单个对象；同样从末尾往前找配平的 `{}`。
  for (let end = body.lastIndexOf("}"); end >= 0; end = body.lastIndexOf("}", end - 1)) {
    let depth = 0;
    let start = -1;
    for (let i = end; i >= 0; i -= 1) {
      const ch = body[i];
      if (ch === "}") depth += 1;
      else if (ch === "{") {
        depth -= 1;
        if (depth === 0) {
          start = i;
          break;
        }
      }
    }
    if (start < 0) continue;
    try {
      const value = JSON.parse(body.slice(start, end + 1)) as unknown;
      if (value && typeof value === "object" && "speaker" in value && "line" in value) return value;
    } catch {
      // 继续尝试更靠前的一组括号
    }
  }
  return null;
}

function parseLoose(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}
