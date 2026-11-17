/**
 * 叙事提示词：Turn 每回合组装一次。
 * 改这个文件必须 bump PROMPT_VERSION（AGENTS.md §4 / docs/03 §8），否则回放与 eval 对不上。
 *
 * 顺序刻意固定（docs/07 §3）：S1 身份/世界规则 → S1.5 世界记忆 → S4/S5/S6 场景数值
 * → S7 长期记忆 → S8 短期记忆 → S9 输出格式与玩家输入。
 * 稳定前缀在前、逐回合变化在后，这样 deepseek 的上下文缓存才命中得上（命中价是未命中的 2%）。
 * 记忆块的条内按 id 排序：同一份记忆渲染出的字节必须逐字节一致，否则缓存天天失效。
 */
import type { ActorId, MemoryHit, WorldState } from "../../shared/src/contract/types.ts";
import type { MemoryContext } from "./turn.memory.ts";

export interface PromptOptions {
  /** 现实锚定层追加的行（世界规则 + 本回合的诱导类型） */
  framing?: string[];
  /** 本回合召回的记忆（读不到时传 undefined，提示词就退化成"第一次见面"） */
  mem?: MemoryContext;
}

function lines(title: string, hits: readonly MemoryHit[]): string[] {
  if (hits.length === 0) return [];
  const sorted = [...hits].sort((a, b) => a.record.id.localeCompare(b.record.id));
  return [title, ...sorted.map((h) => `- ${h.record.content}`)];
}

export function buildTurnPrompt(state: WorldState, actorId: ActorId, input: string, opts: PromptOptions = {}): string {
  const me = state.entities[actorId];
  const where = state.entities[state.room.scene.locId];
  const mem = opts.mem;
  return [
    "你是校园文字冒险游戏的叙事者。用第二人称、中文、克制的白描，不复述玩家原话。",
    `当前地点：${where?.name ?? "未知"}；第 ${state.clock.day} 天 ${state.clock.phase}。`,
    `玩家：${me?.name ?? actorId}。`,
    ...(opts.framing ?? []),
    ...(mem && mem.available
      ? [
          ...lines("这个世界已经知道的事：", mem.permanent),
          ...lines("你（NPC）还记得更早以前的事：", mem.long),
          ...lines("你（NPC）还记得刚才的事：", mem.short),
        ]
      : []),
    "只输出 JSON，字段：narrative(环境与动作)、dialogue(NPC 台词，可为空)、proposals(状态变更提议，可为空数组)、memory(本回合值得记住的事，可为空数组)。",
    '示例：{"narrative":"…","dialogue":"…","proposals":[{"op":"attr.delta","args":{"entityId":"plr_self","key":"stamina","delta":-2}}],"memory":[{"content":"他把借来的伞还给了我","tags":["借伞","守信"],"salience":4,"about":["plr_self"]}]}',
    "memory 只写你亲眼所见、亲耳所听的一句话（第一人称视角，不写全知信息、不写数值）；没有值得记的就给空数组。",
    "禁止编造未声明的属性键；只能使用 registry 中存在的属性。",
    `玩家输入：${input}`,
  ].join("\n");
}
