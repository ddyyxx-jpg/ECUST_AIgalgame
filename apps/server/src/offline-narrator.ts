/**
 * 离线叙述器（开发/演示态，未接入模型时使用）。
 *
 * 为什么需要它：MockLlm 的占位文本如果只是「你说了「X」」，玩家看到的就不是剧情。
 * 这里用**已有的内容数据**（`content/modules/map/data/world_map.json` 的场景描述）
 * 加时间/在场/动作类型拼出一段随场景变化的第二人称白描——确定性、零成本、可离线演示。
 *
 * 边界：只产出 `narrative` 文本，不产 Proposal、不碰世界状态；接入真模型后本文件不参与运行。
 * 上下文来源：Turn 组装的提示词本身带有「当前地点：X；第 N 天 phase」与「玩家输入：X」，
 * 这里只解析这三项（同一仓库自产自销，格式见 `packages/engine/src/turn.prompt.ts`）。
 */
import { readFile } from "node:fs/promises";

export interface PromptContext {
  locName: string;
  day: number;
  phase: string;
  input: string;
}

/** 从提示词里取回"当前地点 / 天数 / 时段 / 玩家输入"；取不到就给安全默认值 */
export function parsePromptContext(messages: { content?: string }[]): PromptContext {
  const system = messages.find((m) => typeof m.content === "string" && m.content.includes("当前地点"))?.content ?? "";
  const loc = /当前地点：([^；\n]+)[；;]/.exec(system);
  const clock = /第\s*(\d+)\s*天\s*(\w+)/.exec(system);
  const last = messages[messages.length - 1]?.content ?? "";
  return {
    locName: loc?.[1]?.trim() ?? "",
    day: clock ? Number(clock[1]) : 1,
    phase: clock?.[2] ?? "morning",
    input: last.trim(),
  };
}

export interface SceneDesc {
  name: string;
  desc: string;
}

/**
 * locId → {name, desc}（来自地图内容数据；缺数据时返回空表，不影响启动）。
 * #134：以前用场景**名字**做 key，而引擎交给场景 agent 的是 canon 的 locId/名字，
 * 两边对不上 → 5 个地点全部匹配失败。改为按 id 建索引，同时可用名字反查。
 */
export async function loadSceneDescs(file: string): Promise<Map<string, SceneDesc>> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as { scenes?: { id?: string; name?: string; desc?: string }[] };
    const map = new Map<string, SceneDesc>();
    for (const s of raw.scenes ?? []) {
      if (typeof s.id === "string" && typeof s.name === "string" && typeof s.desc === "string" && s.desc.length > 0) {
        map.set(s.id, { name: s.name, desc: s.desc });
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * 场景描述解析（#134）：优先 locId；名字回退时先经 canon 名→id 解析，再做同名匹配。
 * canon 的「图书馆」与地图的「图文信息中心」名字不同但 id 对齐，只按名字找会全 miss。
 */
export function resolveSceneDesc(
  descs: Map<string, SceneDesc>,
  canonIdByName: Map<string, string>,
  q: { locId?: string; locName?: string },
): string {
  const byId = q.locId ? descs.get(q.locId) : undefined;
  const viaCanon = !byId && q.locName ? descs.get(canonIdByName.get(q.locName) ?? "") : undefined;
  const byName = q.locName ? sceneByName(descs, q.locName) : undefined;
  return (byId ?? viaCanon ?? byName)?.desc ?? "";
}

export function sceneByName(descs: Map<string, SceneDesc>, name: string): SceneDesc | undefined {
  for (const d of descs.values()) if (d.name === name) return d;
  return undefined;
}

const PHASE_OPENERS: Record<string, string[]> = {
  morning: ["早上的光还没完全铺开。", "校园刚醒，路上的人不多。", "空气里有昨夜留下的凉意。"],
  noon: ["日头正高，影子缩在脚边。", "到处是人声和饭味。", "光晃得人有点睁不开眼。"],
  afternoon: ["下午的光偏了一点，落在墙上。", "这个点最安静，也最容易犯困。", "风把走廊里的纸吹得哗哗响。"],
  evening: ["天开始暗，灯一盏一盏亮起来。", "傍晚的风凉下来了。", "影子被拉得很长。"],
  night: ["夜里安静得能听见自己的脚步。", "路灯下有一小块黄，其余都是黑的。", "走廊尽头的灯闪了一下。"],
};

const MOVE_TAILS = ["你把这段路走完，脚步慢下来。", "路不长，但你走得不快。", "拐过两个弯，周围的声音换了。"];
const LOOK_TAILS = ["你把这些细节记在心里。", "你没有立刻移开视线。", "有些地方看起来比昨天旧了一点。"];
const SAY_TAILS = ["没有人立刻回答你。", "对方没有马上接话。", "话出口之后，安静了一拍。"];
const TRADE_TAILS = ["窗口那边的人抬头看了你一眼。", "你数了数口袋里的钱。", "价目表上的数字你多看了一眼。"];
const IDLE_TAILS = ["你停了一下，像是在等谁先开口。", "你等着，直到这阵安静过去。", "你把手插回口袋，没急着走。"];

/** 稳定哈希：同样的输入、地点、时段给同样的句子（利于对照调试，不像随机那样每次都不一样） */
function pick(list: string[], seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return list[h % list.length] ?? list[0] ?? "";
}

/** 第一句（到第一个句号/感叹号为止），用来当场景细节，避免整段描述压过其它句子 */
function firstSentence(text: string): string {
  const cut = /[。！？]/.exec(text);
  const s = cut ? text.slice(0, cut.index + 1) : text;
  return s.length > 80 ? `${s.slice(0, 78)}…` : s;
}

/** 从输入里认出目标场景：取最长命中别名（比场景名长度更准） */
export function pickSceneByInput(descs: Map<string, SceneDesc>, input: string): SceneDesc | undefined {
  let named: SceneDesc | undefined;
  let namedHit = 0;
  for (const d of descs.values()) {
    for (const alias of aliases(d.name)) {
      if (input.includes(alias) && alias.length > namedHit) { named = d; namedHit = alias.length; }
    }
  }
  return named;
}

/** 场景名的别名（"一食堂" → 也认"食堂"；"宿舍 3 号楼" → 也认"宿舍"），用于从输入里认出目标 */
function aliases(name: string): string[] {
  const out = new Set<string>([name]);
  const stripped = name.replace(/^[一二三四五六七八九十0-9]+\s*/, "").trim();
  if (stripped.length >= 2) out.add(stripped);
  for (const part of name.split(/\s+/)) if (part.length >= 2) out.add(part);
  return [...out];
}

/** 按动作类型挑收束句 */
function tailOf(input: string): string {
  const seed = input;
  if (/去|到|往|回|进|走|前往/.test(input)) return pick(MOVE_TAILS, seed);
  if (/看|观察|环顾|四周|地图|在哪/.test(input)) return pick(LOOK_TAILS, seed);
  if (/说|问|聊|喊|叫/.test(input)) return pick(SAY_TAILS, seed);
  if (/买|卖|退|钱|价/.test(input)) return pick(TRADE_TAILS, seed);
  return pick(IDLE_TAILS, seed);
}

/**
 * 生成一段随场景/时段/动作变化的叙述。
 * - 移动类输入优先用"目标场景"的描述（提示词里的地点是移动前的，直接用它会写错地方）
 * - 观察类输入不再重复场景描述：`turn.facts` 已经带了完整描述，重复会显得啰嗦
 * - 场景描述缺失（例如 AI 生成的用户场景）时退回通用白描，不报错
 */
export function offlineNarrative(messages: { content?: string }[], descs: Map<string, SceneDesc>): string {
  const ctx = parsePromptContext(messages);
  const moving = /去|到|往|回|进|走|前往/.test(ctx.input);
  const looking = /看|观察|环顾|四周|地图|在哪/.test(ctx.input);

  // 输入里出现场景名/别名 → 用那个场景；否则用当前地点。取最长匹配，避免"食堂"截胡"一食堂"以外的更长名字
  const named = pickSceneByInput(descs, ctx.input);
  const target = moving && named ? named : sceneByName(descs, ctx.locName);
  const desc = target?.desc ?? "";

  const parts = [pick(PHASE_OPENERS[ctx.phase] ?? PHASE_OPENERS.morning!, `${ctx.phase}${ctx.day}${ctx.input}`)];
  if (desc && !looking) parts.push(firstSentence(desc));
  parts.push(tailOf(ctx.input));
  return parts.join("");
}
