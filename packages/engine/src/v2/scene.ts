/**
 * 场景 agent（dev/v2）：开场广播一次 → 下线；被显式 @多人 / 换地点 唤醒 → 产出群像总结。
 * 总结不进世界状态，作为**半常驻特权注入**（S1.5 之后、forced、按 id 排序）进入 NPC 上下文。
 * 每轮还会注入「当前场景」标题 + 静态说明（#134）：地点没变时前缀稳定，保住提示词缓存。
 * 这里只定义端口与编排；真正的"怎么写场景"由注入的 SceneAgentPort 决定（通常是另一个 LLM 调用）。
 */
import type { Id, SceneBeat, SceneMemory, Utterance } from "../../../shared/src/index.ts";

export interface SceneAgentPort {
  /** 开场/换地点：描述当前地点与在场者（入参带 locId，便于服务端按 id 查静态说明） */
  describe(input: { roomId: Id; locId?: Id; locName?: string; present: readonly Id[] }): Promise<string>;
  /** 唤醒：总结群像场景 */
  summarize(input: {
    roomId: Id;
    trigger: "multi" | "location";
    recent: readonly string[];
    previous?: string;
    locId?: Id;
    locName?: string;
  }): Promise<string>;
}

export interface WakeInput {
  utterance?: Utterance;
  locationChanged: boolean;
  wakeOnMultiTarget: boolean;
  wakeOnLocationChange: boolean;
}

/** 唤醒条件：显式 @全体 / @多人，或换地点。悄悄话/不动声色的单体 @ 不算。 */
export function shouldWake(input: WakeInput): "multi" | "location" | null {
  const t = input.utterance?.target;
  const many = t === "all" || (Array.isArray(t) && t.length >= 2);
  if (input.wakeOnMultiTarget && many) return "multi";
  if (input.wakeOnLocationChange && input.locationChanged) return "location";
  return null;
}

export interface SceneLocation {
  locId?: Id;
  locName?: string;
}

export class SceneManager {
  private readonly beats = new Map<Id, SceneBeat[]>();
  private readonly memories = new Map<Id, SceneMemory>();
  /** 当前地点与静态说明：换地点时由 describe 刷新 */
  private readonly current = new Map<Id, { loc: SceneLocation; text: string }>();

  constructor(
    private readonly agent: SceneAgentPort,
    private readonly now: () => number = Date.now,
  ) {}

  async open(sessionId: Id, roomId: Id, loc: SceneLocation, present: readonly Id[]): Promise<SceneBeat> {
    const text = (await this.agent.describe({ roomId, locId: loc.locId, locName: loc.locName, present })).trim();
    const beat: SceneBeat = {
      id: `scene_${sessionId}_0`,
      kind: "opening",
      roomId,
      ...(loc.locId ? { locId: loc.locId } : {}),
      text,
      createdAt: this.now(),
      order: "before",
    };
    this.beats.set(sessionId, [beat]);
    this.current.set(sessionId, { loc, text });
    // #134：开场也写 memories，render() 才有内容可注入（以前只 push beats → 开场永进不了提示词）
    this.memories.set(sessionId, {
      id: beat.id,
      roomId,
      origin: "scene",
      text,
      createdAt: beat.createdAt,
    });
    return beat;
  }

  /**
   * 唤醒：产出一条 summary beat，并把最新总结写进会话级 SceneMemory。
   * order="after" 表示排在玩家发言之后（@多人）→ NPC 优先对玩家反应；
   * order="before" 表示换地点发生在发言之前 → NPC 按心理/背景自由发挥。
   */
  async wake(
    sessionId: Id,
    roomId: Id,
    trigger: "multi" | "location",
    recent: readonly string[],
    loc?: SceneLocation,
  ): Promise<SceneBeat> {
    const previous = this.memories.get(sessionId)?.text;
    if (trigger === "location" && loc) {
      const text = (await this.agent.describe({ roomId, locId: loc.locId, locName: loc.locName, present: [] })).trim();
      this.current.set(sessionId, { loc, text });
    }
    const text = (
      await this.agent.summarize({ roomId, trigger, recent, previous, locId: loc?.locId, locName: loc?.locName })
    ).trim();
    const list = this.beats.get(sessionId) ?? [];
    const beat: SceneBeat = {
      id: `scene_${sessionId}_${list.length}`,
      kind: "summary",
      roomId,
      ...(loc?.locId ? { locId: loc.locId } : {}),
      text,
      createdAt: this.now(),
      order: trigger === "location" ? "before" : "after",
    };
    this.beats.set(sessionId, [...list, beat]);
    this.memories.set(sessionId, {
      id: beat.id,
      roomId,
      origin: "scene",
      text,
      createdAt: beat.createdAt,
    });
    return beat;
  }

  /** 当前地点（供 step 判断换地点 / 渲染场景标题） */
  location(sessionId: Id): SceneLocation | undefined {
    return this.current.get(sessionId)?.loc;
  }

  memory(sessionId: Id): SceneMemory | undefined {
    return this.memories.get(sessionId);
  }

  list(sessionId: Id): SceneBeat[] {
    return [...(this.beats.get(sessionId) ?? [])];
  }

  /**
   * 每轮注入文本：
   * 【当前场景】图书馆（loc_library）
   * <静态说明>
   * 【场景·群像】（scene_x_2）
   * <最新 summary；没有就用开场>
   * 地点不变时整段逐字节稳定，保住提示词缓存前缀。
   */
  render(sessionId: Id): string {
    const parts: string[] = [];
    const cur = this.current.get(sessionId);
    const mem = this.memories.get(sessionId);
    const loc = cur?.loc ?? {};
    if (loc.locName || loc.locId) {
      const tag = loc.locId ? `${loc.locName ?? ""}（${loc.locId}）` : (loc.locName ?? "");
      parts.push(`【当前场景】${tag}`.replace(/（）/g, ""));
    }
    // 开场时 current.text 与 memories.text 是同一段：只保留一次（审阅 P2）
    if (cur?.text && cur.text !== mem?.text) parts.push(cur.text);
    if (mem) parts.push(`【场景·群像】（${mem.id}）`, mem.text);
    return parts.join("\n");
  }
}

/** 心理活动的文本上限与"有逻辑/世界相关"的提示：给 NPC agent 拼 prompt 用 */
export function mentalFraming(): string {
  return [
    "写下你此刻的真实想法：必须因果相关（因为刚才发生了什么，所以你怎么想），并引用在场的人或具体细节。",
    "可以包含下一步打算（plan），但计划不会自动执行——之后是否行动由你自己决定。",
    "心理活动只有你自己知道，其他人和玩家都看不到；他们只能看到你的神色动作。",
  ].join("\n");
}
