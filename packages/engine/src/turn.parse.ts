/**
 * 模型输出的结构闸门（第一层校验）：
 * 只做"能不能读成 JSON + 形状对不对"，内容安全由 audit.gate 负责，业务合法性由 Arbiter 负责。
 *
 * 为什么要容错：真实模型会加 ```json 围栏、前后解释、尾随逗号，甚至一次给两个对象。
 * 网关的 json 模式已经容忍围栏/尾随逗号（packages/llm/src/json.ts），引擎侧必须对齐：
 * 否则网关认为合法、引擎判死，白白把能救的回合变成 E_LLM_FORMAT（issue #18）。
 * 截断/缺逗号这类真坏 JSON 修不了，交给 turn.llm 的"解析失败自动重问一次"。
 */
import type { ErrorCode } from "../../shared/src/contract/errors.ts";
import type { Proposal } from "../../shared/src/contract/types.ts";

export interface TurnJson {
  narrative?: string;
  dialogue?: string;
  proposals?: Proposal[];
  /** 3.1.0：本回合值得记住的事（结构由 memory.gate 的 zod 再校验一次） */
  memory?: unknown[];
}

/** 契约错误码是闭集，没有"未知内部错误"；这类异常按引擎故障上报 */
export function codeOf(e: unknown): ErrorCode {
  if (typeof e === "object" && e !== null && "code" in e) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === "string" && c.startsWith("E_")) return c as ErrorCode;
  }
  return "E_MODULE_FAULT";
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 容忍围栏、前后废话、尾随逗号；取第一个平衡的 `{...}`（字符串/转义感知）。读不出来返回 null（不猜、不修补）。 */
export function parseTurn(raw: string): TurnJson | null {
  if (!raw || raw.trim() === "") return null;
  const text = stripFences(raw);
  const start = text.indexOf("{");
  if (start < 0) return null;
  const end = balancedEnd(text, start);
  if (end < 0) return null; // 截断/未闭合：交给上层自动重问，不在本地瞎补
  try {
    const obj = JSON.parse(removeTrailingCommas(text.slice(start, end + 1))) as unknown;
    return isPlainObject(obj) ? (obj as TurnJson) : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 去掉 ```json ... ``` 围栏；没有围栏时原样返回。
 * 规则与 packages/llm/src/json.ts 保持一致，但引擎不能反向依赖网关包，所以本地实现一份。
 */
function stripFences(text: string): string {
  const open = text.indexOf("```");
  if (open === -1) return text;

  let rest = text.slice(open + 3);
  const newline = rest.indexOf("\n");
  const firstLine = (newline === -1 ? rest : rest.slice(0, newline)).trim();
  // 只有像 "json" / "JSON" / "" 这样的语言标记才吞掉，避免误伤 ```{"a":1}```
  if (/^[a-zA-Z0-9_-]*$/.test(firstLine)) {
    rest = newline === -1 ? "" : rest.slice(newline + 1);
  }
  const close = rest.lastIndexOf("```");
  return close === -1 ? rest : rest.slice(0, close);
}

/** 从 objStart 的 `{` 开始找配对的 `}`；字符串内部与转义后的引号不算结构。未闭合返回 -1。 */
function balancedEnd(text: string, objStart: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = objStart; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 删除对象/数组末尾的多余逗号；字符串内部的 ",}" 不受影响。 */
function removeTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      const next = j < text.length ? text[j] : "";
      if (next === "}" || next === "]") continue; // 丢掉尾逗号
    }
    out += ch;
  }
  return out;
}
