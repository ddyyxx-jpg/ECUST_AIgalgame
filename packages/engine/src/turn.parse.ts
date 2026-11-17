/**
 * 模型输出的结构闸门（第一层校验）：
 * 只做"能不能读成 JSON + 形状对不对"，内容安全由 audit.gate 负责，业务合法性由 Arbiter 负责。
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

/** 容忍 ```json 围栏与前后废话；读不出来就返回 null（不猜、不修补） */
export function parseTurn(raw: string): TurnJson | null {
  if (!raw || raw.trim() === "") return null;
  const body = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(body.slice(start, end + 1)) as TurnJson;
    return typeof obj === "object" && obj !== null ? obj : null;
  } catch {
    return null;
  }
}
