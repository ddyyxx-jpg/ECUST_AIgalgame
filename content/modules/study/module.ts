/**
 * study —— 自习 / 刷题（#97 模块宿主兼容性最小骨架）。
 *
 * 边界：只返回 Proposal；不写库、不调用 LLM、不读环境变量、不改 packages/engine。
 * 工具名 `study.quiz` 已登记在 docs/03-接口总表.md §6 的 <moduleId>.<verb> 示例里，
 * 因此不需要改文档或 bump 版本；op 只用 13 原语闭集里的 entity.create。
 */
import type {
  Module,
  ModuleContext,
  ModuleOutcome,
  Phase,
  Proposal,
} from "../../../packages/shared/src/contract/types.ts";

const BY = "mod.study";
const TOOL = "study.quiz";
const MAX_COUNT = 5;

/** id 由上下文派生，不硬编码实体 id 或属性名；kind 前缀满足 02 §3 的 id 规则 */
function noteId(ctx: ModuleContext, count: number): string {
  return `item_study_${ctx.actorId}_d${ctx.clock.day}t${ctx.clock.tick}_${count}`;
}

/** 只算 Proposed 状态变更：创建一条自习笔记，具体效果由 Arbiter 裁决 */
function noteProposals(ctx: ModuleContext, count: number): Proposal[] {
  return [{
    op: "entity.create",
    args: {
      id: noteId(ctx, count),
      kind: "item",
      name: "study note",
      tags: ["study"],
      origin: "ai",
      canon: false,
    },
    reason: "自习整理出一份笔记",
    by: BY,
  }];
}

const studyModule: Module = {
  /** 宿主按 manifest.keywords 路由到本模块；命中后只产 Proposal，合法性交给 Arbiter */
  intent(ctx): ModuleOutcome {
    return { ok: true, proposals: noteProposals(ctx, 1) };
  },

  tool(name, args, ctx): ModuleOutcome {
    if (name !== TOOL) {
      return { ok: false, proposals: [], error: { code: "E_TOOL_UNKNOWN", message: `study 不认识工具 ${name}` } };
    }
    // 宿主传入的 args 必须是对象；异常输入直接抛，由 ModuleHost 隔离为本模块的 fault
    // （验收项：抛错被隔离，不能拖垮宿主里的其他模块）
    if (args === null || typeof args !== "object") throw new Error("study: tool args must be an object");
    const count = (args as { count?: unknown }).count ?? 1;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
      return { ok: false, proposals: [], error: { code: "E_OUT_OF_RANGE", message: `count 必须在 1..${MAX_COUNT}` } };
    }
    return { ok: true, proposals: noteProposals(ctx, count) };
  },

  /** triggers: ["night"] —— 夜间自检交一份笔记；其他时段不产提案 */
  tick(ctx, phase: Phase): Proposal[] {
    return phase === "night" ? noteProposals(ctx, 1) : [];
  },
};

export default studyModule;
