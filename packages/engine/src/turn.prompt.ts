/**
 * 叙事提示词：Turn 每回合组装一次。
 * 改这个文件必须 bump PROMPT_VERSION（AGENTS.md §4 / docs/03 §8），否则回放与 eval 对不上。
 *
 * 顺序刻意固定（docs/08 §5.2，**顺序是缓存契约**）：
 *   S1 身份/世界规则/输出协议（静态，逐字节稳定）
 *   S1.5 世界记忆（permanent top-8，带 WORLD_MEM_VERSION 标记）
 *   S4 NPC 卡  S5 场景/时钟  S6 数值
 *   S7 长期记忆  S8 短期记忆
 *   S9 玩家输入
 * 稳定前缀在前、逐回合变化在后，这样 deepseek 的上下文缓存才命中得上（命中价是未命中的 2%）。
 * 记忆块内按 id 排序：同一份记忆渲染出的字节必须逐字节一致，否则缓存天天失效。
 */
import type { ActorId, MemoryHit, Registry, WorldState } from "../../shared/src/contract/types.ts";
import { WORLD_MEM_VERSION } from "../../shared/src/contract/version.ts";
import type { MemoryContext } from "./turn.memory.ts";

export interface PromptOptions {
  /** 现实锚定层追加的行（世界规则 + 本回合的诱导类型） */
  framing?: string[];
  /** 本回合召回的记忆（读不到时传 undefined，提示词就退化成"第一次见面"） */
  mem?: MemoryContext;
  /** 属性注册表：S6 只渲染 public 属性，secret 永不出现在提示词里 */
  registry?: Registry;
}

function lines(title: string, hits: readonly MemoryHit[]): string[] {
  if (hits.length === 0) return [];
  const sorted = [...hits].sort((a, b) => a.record.id.localeCompare(b.record.id));
  return [title, ...sorted.map((h) => `- ${h.record.content}`)];
}

const PHASE_CN: Record<string, string> = {
  morning: "早上",
  noon: "中午",
  afternoon: "下午",
  evening: "傍晚",
  night: "夜里",
};

/** S6：只渲染 public 属性（数值面板）；没有注册表时整段省略，绝不猜键名 */
function valueLines(state: WorldState, actorId: ActorId, registry?: Registry): string[] {
  if (!registry) return [];
  const me = state.entities[actorId];
  if (!me) return [];
  const parts: string[] = [];
  for (const def of registry.attrs()) {
    if (def.visibility !== "public") continue;
    const v = me.attrs[def.key];
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") parts.push(`${def.display?.label ?? def.key} ${String(v)}`);
  }
  return parts.length > 0 ? [`你的处境：${parts.join("，")}。`] : [];
}

export function buildTurnPrompt(
  state: WorldState,
  actorId: ActorId,
  input: string,
  opts: PromptOptions = {},
): string {
  const me = state.entities[actorId];
  const where = state.entities[state.room.scene.locId];
  const mem = opts.mem;
  const npc = mem?.npcId ? state.entities[mem.npcId] : undefined;
  const present = (state.room.scene.presentIds ?? [])
    .map((id) => state.entities[id]?.name)
    .filter((n): n is string => typeof n === "string");

  const s1 = [
    "你是校园文字冒险游戏的叙事者。用第二人称、中文、克制的白描，不复述玩家原话。",
    "世界是现实校园：没有魔法、超能力、读心或系统面板；NPC 只是普通人，只相信亲眼所见亲耳所听。",
    "只输出 JSON，字段：narrative(环境与动作)、dialogue(NPC 台词，可为空)、proposals(状态变更提议，可为空数组)、memory(本回合值得记住的事，可为空数组)。",
    '示例：{"narrative":"…","dialogue":"…","proposals":[{"op":"attr.delta","args":{"entityId":"<实体id>","key":"<registry 里的属性键>","delta":-2}}],"memory":[{"content":"他把借来的伞还给了我","tags":["借伞","守信"],"salience":4,"about":["<实体id>"]}]}',
    "memory 只写你亲眼所见、亲耳所听的一句话（第一人称视角，不写全知信息、不写数值）；没有值得记的就给空数组。",
    "禁止编造未声明的属性键；只能使用 registry 中存在的属性。",
    "推进优先：玩家的行动没有带来新的世界状态变化时（例如只是环顾四周、站着不动、重复同一个动作），不要重复描写环境；让在场的 NPC 主动开口、给出新信息，或制造一个小事件。同一场景的第二次观察必须给出第一次没有的细节。",
    "只有在场者能说话/行动：玩家提到不在场的人时，在场的 NPC 只能表示“不在这里/不清楚”，不得替不在场者回答、不得替其编造行动或台词。",
  ];

  const s15 = mem && mem.available && mem.permanent.length > 0
    ? [...lines(`这个世界已经知道的事（记忆格式 v${WORLD_MEM_VERSION}，编号 ${mem.permanent.map((h) => h.record.id).sort().join(",")}）：`, mem.permanent)]
    : [];
  const npcViews = mem?.npcs ?? [];
  const s4 = npc
    ? [`当前对话对象：${npc.name}${npc.tags.length ? `（${npc.tags.join("、")}）` : ""}。`]
    : npcViews.length > 1
      ? [`当前对话对象：在场的${npcViews.map((v) => v.name).join("、")}（只有在场者能回应）。`]
      : [];
  const s5 = [
    `当前地点：${where?.name ?? "未知"}；第 ${state.clock.day} 天${PHASE_CN[state.clock.phase] ?? state.clock.phase}。`,
    present.length > 0 ? `在场的人：${present.join("、")}。` : "",
  ].filter((l) => l !== "");
  const s6 = valueLines(state, actorId, opts.registry);
  // 单 NPC 保持旧的“你（NPC）”标题（字节稳定、缓存不白费）；多 NPC 按人分段并标名字（#20）
  const s7: string[] = [];
  const s8: string[] = [];
  if (mem && mem.available) {
    if (mem.npcs.length > 1) {
      for (const view of mem.npcs) {
        s7.push(...lines(`${view.name}（NPC）还记得更早以前的事：`, view.long));
        s8.push(...lines(`${view.name}（NPC）还记得刚才的事：`, view.short));
      }
    } else {
      s7.push(...lines("你（NPC）还记得更早以前的事：", mem.long));
      s8.push(...lines("你（NPC）还记得刚才的事：", mem.short));
    }
  }

  return [
    ...s1,
    ...(opts.framing ?? []),
    ...s15,
    ...s4,
    ...s5,
    ...s6,
    ...s7,
    ...s8,
    `玩家输入：${input}`,
  ].join("\n");
}
