/**
 * LLM 输出的 JSON 解析（第一道闸门）。
 *
 * 为什么要这么防御：DeepSeek 官方规定「输出无法被识别为 JSON 时，非 JSON 内容
 * 会被替换为空格 U+0020」，于是 content 可能整段是空白、而 finish_reason 仍是
 * stop。因此空串/纯空白必须判失败（空格修不了，只能重试）。
 * 参考：docs/v1/调研-API与成本.md 的「U+0020」段落。
 */

export interface JsonParseFailure {
  ok: false;
  code: "E_LLM_FORMAT";
  message: string;
}

export interface JsonParseSuccess {
  ok: true;
  value: Record<string, unknown>;
}

export type JsonParseResult = JsonParseSuccess | JsonParseFailure;

const fail = (message: string): JsonParseFailure => ({ ok: false, code: "E_LLM_FORMAT", message });

/** 解析模型返回的 JSON；任何一步失败都返回 {ok:false,code:"E_LLM_FORMAT"}，不抛异常。 */
export function safeParseJson(raw: string): JsonParseResult {
  if (raw.trim() === "") {
    return fail("内容为空或纯空白（DeepSeek 的非 JSON 输出会被替换成 U+0020 空格）");
  }

  const text = stripFences(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return fail("未找到 JSON 对象边界 { }");
  }

  const candidate = removeTrailingCommas(text.slice(start, end + 1));
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail(`JSON 解析失败：${detail}`);
  }

  if (!isPlainObject(parsed)) {
    return fail("顶层不是 JSON 对象");
  }
  return { ok: true, value: parsed };
}

/**
 * 去掉 ```json ... ``` 围栏；没有围栏时原样返回。
 * 与 packages/engine/src/turn.parse.ts 的 stripOuterFences 互为镜像（引擎那边先按原文解析、
 * 失败才剥首尾围栏，避免把叙事字符串里的 ``` 当成围栏起点）；改这里必须同步评估那边。
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
