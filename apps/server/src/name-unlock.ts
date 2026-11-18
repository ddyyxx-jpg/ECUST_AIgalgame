/**
 * 「谁报出了自己的名字，玩家才认识谁」的判定（认识口径的收口点）。
 *
 * 只认**说话人标签后面的台词内容**，例如：
 *   林静：“林静。双木林，安静的静。”        ← 台词开头就是自己的名字 → 算
 *   白晓通：白晓通，住三号楼的。            ← 台词里自报姓名 → 算
 *   林静：你好——小声一点，这边有人自习。   ← 只是打招呼 → 不算
 *
 * 为什么不能只看说话人标签：模型每句台词都写成「名字：…」，标签带名字不等于他做了自我介绍，
 * 否则第一句"你好"就会把全场人的名字解锁。
 * 旁白里提到某人（"不远处的白晓通抬起头"）同样不算。
 */
import type { Entity } from "../../../packages/shared/src/contract/types.ts";
import { knowsNameOf } from "./view-names.ts";

/** 玩家在问对方名字（与 content/modules/introduce 的 ASK_NAME_RE 同口径） */
const ASK_NAME_RE = /(你叫什么|你叫啥|你叫什么呢|你叫什么名字|怎么称呼你|你的名字|贵姓|你是哪位|你哪位)/u;

export function isAskNameInput(input: string): boolean {
  return ASK_NAME_RE.test(input);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 台词里是否在自报姓名。**只认姓名共现**：嘴上说"我叫/我是"但没有说出名字，
 * 不算自我介绍（审阅 P1-5 的反例："我是图书馆的老师"、"我叫你一声同学吧"、"我姓白"）。
 */
function speechIntroducesName(speech: string, name: string): boolean {
  return speech.slice(0, 60).includes(name);
}

/** 从叙事/台词文本里挑出"当轮报过名字"的未认识 NPC */
export function namesIntroducedIn(text: string, npcs: readonly Entity[]): Entity[] {
  const out: Entity[] = [];
  for (const npc of npcs) {
    if (knowsNameOf(npc)) continue;
    const name = npc.name.trim();
    if (name.length < 2) continue;
    const re = new RegExp(`${escapeRe(name)}[：:]\\s*([^\\n]{0,80})`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (speechIntroducesName(m[1] ?? "", name)) {
        out.push(npc);
        break;
      }
    }
  }
  return out;
}
