/**
 * 模型这一步：问一次 → 容错解析 → 过滤（现实锚定）→ 必要时再问一次。
 * 从 Turn 里拆出来，是为了让"怎么问模型"和"模型说完之后引擎怎么裁决"互不干扰。
 *
 * 两种"再问一次"必须分开（issue #18 / #21-3）：
 * - 提案被 Arbiter 拒绝 → 带拒绝原因重问，让模型改业务内容；
 * - 输出不是合法 JSON → 带解析错误重问，只让模型改格式，不许它借机改内容。
 * 前者语义失败重试无意义（retryable=false），后者才是可重试错误（retryable=true）。
 */
import type { ActorId, ErrorCode, LlmPort, MemoryDraft, Proposal, Registry, TurnRequest, Usage, WorldState } from "../../shared/src/index.ts";
import type { RealityKind, RealityPolicy } from "./reality.ts";
import { filterProposals, realityFraming } from "./reality.ts";
import { codeOf, errMessage, parseTurn } from "./turn.parse.ts";
import { buildTurnPrompt } from "./turn.prompt.ts";
import type { MemoryContext } from "./turn.memory.ts";
import { coerceMemoryDrafts } from "./memory.gate.ts";

export interface TurnLlmDeps {
  llm: LlmPort;
  reality: RealityPolicy;
  /** 属性注册表：S6 数值段只渲染 public 属性 */
  registry?: Registry;
  /** 自定义提示词；**必须**用上第 4 个参数 mem，否则记忆注入会被静默丢掉（docs/08 §5.2） */
  buildPrompt?: (state: WorldState, actorId: ActorId, input: string, mem?: MemoryContext) => string | Promise<string>;
  worldInfo?: (state: WorldState, actorId: ActorId, input: string) => {
    authorNote?: string;
    entries: readonly string[];
  };
}

export interface LlmProduct {
  proposals: Proposal[];
  /** narrative + dialogue 的拼接（沿用旧语义：下发叙事/横幅用） */
  text: string;
  /** 叙事（PR #24 P2-2：工作记忆要分别取叙事与台词，不能只靠 text 截断） */
  narrative: string;
  /** 台词 */
  dialogue: string;
  usage?: Usage;
  /** 因"偏离现实"被丢掉的提案数：要如实告诉玩家 */
  dropped: number;
  /** 本回合模型想记的事（已过 zod；还要过 memory.gate 的六道闸门） */
  memory: MemoryDraft[];
  /** 形状不合法的记忆条数（只统计，不报错） */
  invalidMemory: number;
}

export interface RejectedReason {
  code: string;
  detail: string;
}

/** 第二次调用失败：必须带上 code（以及原始异常）——超时/限流不能被 ask() 改写成 E_LLM_FORMAT */
export interface RepairFailure {
  ok: false;
  /** 第二次调用自身的错误码；解析不出 JSON 时为 E_LLM_FORMAT，其余原样保留（如 E_LLM_TIMEOUT） */
  code: ErrorCode;
  error: string;
  /** 原始异常：ask() 对非格式错误原样上抛，DefaultTurn 从异常取最终码 */
  cause?: unknown;
}

export class TurnLlm {
  constructor(private readonly deps: TurnLlmDeps) {}

  /**
   * 一次模型调用；输出不是 JSON 就先容错解析，仍读不出就带解析错误摘要自动重问一次（共两次）。
   * 两次都坏才抛 E_LLM_FORMAT（可重试），不把本可救回的回合直接判死（issue #18）。
   */
  async ask(req: TurnRequest, state: WorldState, kind: RealityKind | null, mem?: MemoryContext): Promise<LlmProduct> {
    try {
      return await this.askOnce(req, state, kind, mem);
    } catch (e) {
      // 只有"格式错"值得重问；超时/限流由上层按可重试错误直接上报，避免多花一次调用
      if (codeOf(e) !== "E_LLM_FORMAT") throw e;
      const repaired = await this.repair(req, state, [], kind, mem, errMessage(e));
      if (repaired.ok) return repaired;
      // 重问这次调用若遇到超时/限流，必须保留原码上抛：否则基础设施故障会被误报成
      // E_LLM_FORMAT，超时切 provider、按码分流都会失效（PR #23 复审 P2）
      if (repaired.code !== "E_LLM_FORMAT") throw causeOf(repaired);
      // 第二次输出仍是坏 JSON，才算"格式错误"；长报文压平截 200 字，避免整段原文进 turn.error/日志
      throw formatError(`模型输出不是合法 JSON，自动修复一次后仍失败：${clip(repaired.error)}`);
    }
  }

  private async askOnce(req: TurnRequest, state: WorldState, kind: RealityKind | null, mem?: MemoryContext): Promise<LlmProduct> {
    const res = await this.deps.llm.chat({
      json: true,
      purpose: "turn",
      messages: [
        { role: "system", content: await this.prompt(state, req.actorId, req.input, kind, mem) },
        { role: "user", content: req.input },
      ],
      maxTokens: 900,
    });
    // 网关 json:true 解析失败会直接抛 E_LLM_FORMAT；这里兜住"不抛、只给 raw"的 LlmPort 实现
    const parsed = parseTurn(res.raw);
    if (!parsed) throw formatError("模型输出不是合法 JSON");
    return this.product(parsed.proposals ?? [], parsed.narrative, parsed.dialogue, res.usage, req, kind, parsed.memory);
  }

  /**
   * 带失败原因的第二次询问（最多一次）；仍然坏就返回 {ok:false} 交给上层报错。
   * parseError 非空 = JSON 解析失败后的重问：只提醒格式，别让模型以为提案被驳回、去改业务内容。
   */
  async repair(
    req: TurnRequest,
    state: WorldState,
    rejected: readonly RejectedReason[],
    kind: RealityKind | null,
    mem?: MemoryContext,
    parseError?: string,
  ): Promise<({ ok: true } & LlmProduct) | RepairFailure> {
    try {
      const res = await this.deps.llm.chat({
        json: true,
        purpose: "turn",
        messages: [
          { role: "system", content: await this.prompt(state, req.actorId, req.input, kind, mem) },
          { role: "user", content: req.input },
          {
            role: "user",
            content: parseError ? this.formatHint(parseError) : this.rejectHint(rejected),
          },
        ],
        maxTokens: 900,
      });
      const parsed = parseTurn(res.raw);
      if (!parsed) return { ok: false, code: "E_LLM_FORMAT", error: "模型修复输出不是合法 JSON" };
      return { ok: true, ...this.product(parsed.proposals ?? [], parsed.narrative, parsed.dialogue, res.usage, req, kind, parsed.memory) };
    } catch (e) {
      // 保留原始错误码与 cause：ask() 判断"是模型格式坏还是基础设施坏"全靠它（PR #23 复审 P2）
      return { ok: false, code: codeOf(e), cause: e, error: errMessage(e) };
    }
  }

  /** 解析失败后的重问：只修格式，不改内容 */
  private formatHint(detail: string): string {
    return [
      `你上一轮的输出不是合法 JSON（解析错误：${detail}）。`,
      "请只输出一个 JSON 对象，不要 markdown 围栏或解释文字；字段仍用 narrative / dialogue / proposals / memory。",
    ].join("\n");
  }

  /** 提案被 Arbiter 拒绝后的重问：保留原有措辞（既有测试与模型行为都依赖这几行） */
  private rejectHint(rejected: readonly RejectedReason[]): string {
    return [
      "上一批 proposals 被引擎拒绝了，原因如下：",
      ...rejected.map((r) => `- ${r.code}: ${r.detail}`),
      "请只输出 JSON，修正 proposals（不要重复已成功的操作），仍用 narrative/dialogue/proposals/memory 四个字段。",
    ].join("\n");
  }

  private product(
    proposals: readonly Proposal[],
    narrative: string | undefined,
    dialogue: string | undefined,
    usage: Usage | undefined,
    req: TurnRequest,
    kind: RealityKind | null,
    memoryRaw?: unknown,
  ): LlmProduct {
    // 诱导性发言换不来数值：过滤必须在代码里做，不能只靠提示词
    const filtered = filterProposals(this.deps.reality, kind, proposals, req.actorId);
    const mem = coerceMemoryDrafts(memoryRaw);
    const narration = (narrative ?? "").trim();
    const reply = (dialogue ?? "").trim();
    return {
      proposals: filtered.kept,
      text: [narration, reply].filter(Boolean).join("\n"),
      narrative: narration,
      dialogue: reply,
      ...(usage ? { usage } : {}),
      dropped: filtered.dropped.length,
      memory: mem.drafts,
      invalidMemory: mem.invalid,
    };
  }

  private async prompt(state: WorldState, actorId: ActorId, input: string, kind: RealityKind | null, mem?: MemoryContext): Promise<string> {
    if (this.deps.buildPrompt) return await this.deps.buildPrompt(state, actorId, input, mem);
    const extra = this.deps.worldInfo?.(state, actorId, input);
    return buildTurnPrompt(state, actorId, input, {
      framing: realityFraming(this.deps.reality, kind),
      ...(mem ? { mem } : {}),
      ...(this.deps.registry ? { registry: this.deps.registry } : {}),
      ...(extra?.authorNote ? { authorNote: extra.authorNote } : {}),
      ...(extra?.entries.length ? { worldInfo: extra.entries } : {}),
    });
  }
}

/** 压平空白并截到 max 字：解析错误里可能带模型原文/网关长报文，不能整段进日志与前端 */
function clip(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** 把 repair 的失败还原成异常：优先抛原错误对象（保留 code/cause），否则按 code 重建 */
function causeOf(failure: RepairFailure): Error {
  if (failure.cause instanceof Error) return failure.cause;
  const err = new Error(failure.error) as Error & { code: ErrorCode };
  err.code = failure.code;
  return err;
}

/** 可恢复的格式错误：code 供上层按 §7 报 E_LLM_FORMAT，recoverable 供引擎内部/测试识别"还能再救" */
function formatError(message: string): Error & { code: "E_LLM_FORMAT"; recoverable: true } {
  const err = new Error(message) as Error & { code: "E_LLM_FORMAT"; recoverable: true };
  err.code = "E_LLM_FORMAT";
  err.recoverable = true;
  return err;
}
