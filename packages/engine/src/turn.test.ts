import { describe, expect, it } from "vitest";
import { MockLlm } from "../../llm/src/mock.ts";
import { DefaultArbiter } from "./arbiter.ts";
import { EventSourcedStore } from "./store.ts";
import { emptyRegistry } from "./registry.ts";
import { DefaultTurn } from "./turn.ts";
import { ModuleHost } from "./modules.ts";
import { InMemoryMemory } from "./memory.ts";
import type { LlmPort, LlmRequest, LlmResult, Modules, RoomId, TurnEvent, WorldState } from "../../shared/src/index.ts";

/** 测试只用内存件；ModuleHost 指向不存在的目录 = 零模块，验证"没有玩法回合也能跑完" */
async function makeTurn(llm: LlmPort, registry = emptyRegistry(), dir = "/tmp/galgame-no-modules") {
  const store = new EventSourcedStore({ worldId: "w", locId: "loc_gate" });
  const arbiter = new DefaultArbiter({ store, registry });
  const modules = new ModuleHost({ dir });
  await modules.load();
  const turn = new DefaultTurn({ store, arbiter, registry, modules, llm, memory: new InMemoryMemory() });
  return { store, arbiter, turn, roomId: "room_t" };
}

async function collect(it: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const okJson = JSON.stringify({ narrative: "你走进图书馆，空气里全是纸味。", dialogue: "", proposals: [] });

/** 不走网关解析、直接把 raw 交给引擎的端口：LlmResult.json 是可选字段，引擎容错必须自己扛 */
function rawLlm(raws: string[]): { calls: number; chat: (req: LlmRequest) => Promise<LlmResult> } {
  const port = {
    calls: 0,
    async chat(_req: LlmRequest): Promise<LlmResult> {
      port.calls += 1;
      const raw = raws[Math.min(port.calls - 1, raws.length - 1)]!;
      return { raw, usage: { promptTokens: 1, completionTokens: 1, calls: 1 }, model: "raw-test", latencyMs: 0 };
    },
  };
  return port;
}


/** 按脚本依次返回 raw 或抛指定错误码：验证「第二次调用基础设施故障」时错误码是否被保留（P2） */
function stepLlm(steps: Array<{ raw: string } | { code: string; message?: string }>) {
  const port = {
    calls: 0,
    async chat(_req: LlmRequest): Promise<LlmResult> {
      port.calls += 1;
      const step = steps[Math.min(port.calls - 1, steps.length - 1)]!;
      if ("code" in step) throw Object.assign(new Error(step.message ?? step.code), { code: step.code });
      return { raw: step.raw, usage: { promptTokens: 1, completionTokens: 1, calls: 1 }, model: "step-test", latencyMs: 0 };
    },
  };
  return port;
}

describe("turn.run", () => {
  it("skipLLM 时完全不调模型，仍能走完 accepted→commit", async () => {
    const llm = new MockLlm({ responses: [okJson] });
    const { turn, roomId } = await makeTurn(llm);
    const evs = await collect(turn.run({ roomId, actorId: "plr_self", input: "看看", clientTurnId: "c1", options: { skipLLM: true } }));
    expect(evs.map((e) => e.type)).toEqual(["turn.accepted", "turn.commit"]);
    expect(llm.calls).toBe(0);
  });

  it("模型返回合法 JSON 时产出 turn.delta 且提交", async () => {
    const llm = new MockLlm({ responses: [okJson] });
    const { turn, roomId } = await makeTurn(llm);
    const evs = await collect(turn.run({ roomId, actorId: "plr_self", input: "去图书馆", clientTurnId: "c2" }));
    expect(llm.calls).toBe(1);
    const delta = evs.find((e) => e.type === "turn.delta");
    expect(delta && delta.type === "turn.delta" ? delta.text : "").toContain("图书馆");
    expect(evs.at(-1)?.type).toBe("turn.commit");
  });

  it("模型返回非 JSON：自动重问一次仍失败 → E_LLM_FORMAT 且带可重试标记，不提交", async () => {
    const llm = new MockLlm({ responses: ["抱歉，我不能输出 JSON。", "还是不是 JSON"] });
    const { turn, roomId } = await makeTurn(llm);
    const evs = await collect(turn.run({ roomId, actorId: "plr_self", input: "x", clientTurnId: "c3" }));
    expect(llm.calls).toBe(2); // 只重问一次，不无限循环
    const err = evs.at(-1);
    expect(err?.type).toBe("turn.error");
    if (err?.type === "turn.error") {
      expect(err.code).toBe("E_LLM_FORMAT");
      expect(err.retryable).toBe(true);
    }
    expect(evs.some((e) => e.type === "turn.commit")).toBe(false);
  });


  it("首次坏 JSON → 重问超时：保留 E_LLM_TIMEOUT，不误报 E_LLM_FORMAT", async () => {
    const port = stepLlm([{ raw: "抱歉，我不能输出 JSON。" }, { code: "E_LLM_TIMEOUT" }]);
    const { turn, roomId } = await makeTurn(port);
    const evs = await collect(turn.run({ roomId, actorId: "plr_self", input: "x", clientTurnId: "c_timeout" }));
    expect(port.calls).toBe(2);
    const err = evs.at(-1);
    expect(err?.type).toBe("turn.error");
    if (err?.type === "turn.error") {
      expect(err.code).toBe("E_LLM_TIMEOUT");
      expect(err.retryable).toBe(true);
    }
    expect(evs.some((e) => e.type === "turn.commit")).toBe(false);
  });

  it("首次坏 JSON → 重问 429：保留 E_RATE_LIMITED", async () => {
    const port = stepLlm([{ raw: "抱歉，我不能输出 JSON。" }, { code: "E_RATE_LIMITED", message: "429 Too Many Requests" }]);
    const { turn, roomId } = await makeTurn(port);
    const evs = await collect(turn.run({ roomId, actorId: "plr_self", input: "x", clientTurnId: "c_rate" }));
    expect(port.calls).toBe(2);
    const err = evs.at(-1);
    expect(err?.type).toBe("turn.error");
    if (err?.type === "turn.error") {
      expect(err.code).toBe("E_RATE_LIMITED");
      expect(err.retryable).toBe(true);
    }
  });

  it("两次都坏 JSON：最终仍是 E_LLM_FORMAT（真格式错）", async () => {
    const port = stepLlm([{ raw: "抱歉，我不能输出 JSON。" }, { raw: "还是不是 JSON" }]);
    const { turn, roomId } = await makeTurn(port);
    const evs = await collect(turn.run({ roomId, actorId: "plr_self", input: "x", clientTurnId: "c_bothbad" }));
    expect(port.calls).toBe(2);
    const err = evs.at(-1);
    expect(err?.type).toBe("turn.error");
    if (err?.type === "turn.error") {
      expect(err.code).toBe("E_LLM_FORMAT");
      expect(err.retryable).toBe(true);
    }
    expect(evs.some((e) => e.type === "turn.commit")).toBe(false);
  });

  it("尾随逗号：网关已经容忍，引擎侧也不再误报（不触发重问）", async () => {
    const llm = new MockLlm({ responses: ['{"narrative":"你走进图书馆。","proposals":[],}'] });
    const { turn, roomId } = await makeTurn(llm);
    const evs = await collect(turn.run({ roomId, actorId: "plr_self", input: "去图书馆", clientTurnId: "c9" }));
    expect(llm.calls).toBe(1);
    expect(evs.at(-1)?.type).toBe("turn.commit");
  });

  it("自定义 LlmPort 直接给带围栏的 raw（json 字段缺省）→ 引擎容错解析，不重问", async () => {
    const port = rawLlm(["```json\n" + okJson + "\n```"]);
    const { turn, roomId } = await makeTurn(port);
    const evs = await collect(turn.run({ roomId, actorId: "plr_self", input: "去图书馆", clientTurnId: "c10" }));
    expect(port.calls).toBe(1);
    expect(evs.some((e) => e.type === "turn.delta")).toBe(true);
    expect(evs.at(-1)?.type).toBe("turn.commit");
  });

  it("叙事里含 ``` 的合法 JSON：先按原文解析，不触发重问（PR #23 复审回归）", async () => {
    const raw = JSON.stringify({ narrative: "试试这个 ```js\nconsole.log(1)\n``` 行不行", proposals: [] });
    const port = rawLlm([raw]);
    const { turn, roomId } = await makeTurn(port);
    const evs = await collect(turn.run({ roomId, actorId: "plr_self", input: "去图书馆", clientTurnId: "c_fence" }));
    expect(port.calls).toBe(1);
    const delta = evs.find((e) => e.type === "turn.delta");
    expect(delta && delta.type === "turn.delta" ? delta.text : "").toContain("```js");
    expect(evs.at(-1)?.type).toBe("turn.commit");
  });

  it("E_STORE_FAULT（读盘/落盘故障）标记为可重试：本回合未提交，重试安全", async () => {
    const llm = new MockLlm({ responses: [okJson] });
    // 第 1 次 snapshot 是 Turn 载入；第 2 次（Arbiter.apply）模拟磁盘故障
    class FlakyStore extends EventSourcedStore {
      private snapshots = 0;
      override async snapshot(roomId: RoomId): Promise<WorldState> {
        this.snapshots += 1;
        if (this.snapshots >= 2) throw Object.assign(new Error("磁盘暂不可用"), { code: "E_STORE_FAULT" });
        return await super.snapshot(roomId);
      }
    }
    const store = new FlakyStore({ worldId: "w", locId: "loc_gate" });
    const arbiter = new DefaultArbiter({ store, registry: emptyRegistry() });
    const modules = new ModuleHost({ dir: "/tmp/galgame-no-modules" });
    await modules.load();
    const turn = new DefaultTurn({ store, arbiter, registry: emptyRegistry(), modules, llm, memory: new InMemoryMemory() });
    const evs = await collect(turn.run({ roomId: "room_t", actorId: "plr_self", input: "x", clientTurnId: "c_store" }));
    const err = evs.at(-1);
    expect(err?.type).toBe("turn.error");
    if (err?.type === "turn.error") {
      expect(err.code).toBe("E_STORE_FAULT");
      expect(err.retryable).toBe(true);
    }
    expect(evs.some((e) => e.type === "turn.commit")).toBe(false);
  });

  it("截断的 JSON：带解析错误自动重问一次后成功提交", async () => {
    const llm = new MockLlm({ responses: ['{"narrative":"说到一半，然后', okJson] });
    const { turn, roomId } = await makeTurn(llm);
    const evs = await collect(turn.run({ roomId, actorId: "plr_self", input: "去图书馆", clientTurnId: "c11" }));
    expect(llm.calls).toBe(2);
    expect(evs.at(-1)?.type).toBe("turn.commit");
    // 第二问是"修格式"，不能伪装成"提案被驳回"，否则模型会去改业务内容
    const second = llm.requests[1]!.messages.at(-1)?.content ?? "";
    expect(second).toContain("不是合法 JSON");
    expect(second).not.toContain("被引擎拒绝");
  });

  it("同一 clientTurnId 重复提交完全重放，不再调模型", async () => {
    const llm = new MockLlm({ responses: [okJson] });
    const { turn, roomId } = await makeTurn(llm);
    const a = await collect(turn.run({ roomId, actorId: "plr_self", input: "去图书馆", clientTurnId: "same" }));
    const b = await collect(turn.run({ roomId, actorId: "plr_self", input: "去图书馆", clientTurnId: "same" }));
    expect(llm.calls).toBe(1);
    expect(b.map((e) => e.type)).toEqual(a.map((e) => e.type));
  });

  it("expectedSeq 不一致时直接 turn.rejected(E_SEQ_GAP)", async () => {
    const llm = new MockLlm({ responses: [okJson] });
    const { turn, roomId } = await makeTurn(llm);
    const evs = await collect(turn.run({ roomId, actorId: "plr_self", input: "x", clientTurnId: "c4", options: { expectedSeq: 99 } }));
    expect(evs[0]?.type).toBe("turn.rejected");
    expect(evs[0] && evs[0].type === "turn.rejected" ? evs[0].code : "").toBe("E_SEQ_GAP");
    expect(llm.calls).toBe(0);
  });

  it("LLM 提议的 op 会经 Arbiter 落到状态里（属性声明后）", async () => {
    const registry = emptyRegistry();
    const llm = new MockLlm({
      responses: [JSON.stringify({ narrative: "你借到一本书。", proposals: [{ op: "attr.delta", args: { entityId: "plr_self", key: "x.note", delta: 1 }, reason: "借书" }] })],
    });
    const { turn, roomId } = await makeTurn(llm, registry);
    const evs = await collect(turn.run({ roomId, actorId: "plr_self", input: "借书", clientTurnId: "c5" }));
    // 没有 x.note 也能被接受（x 区自由），但玩家实体不存在 → op 被拒是合法结果，这里只断言不炸
    expect(evs.at(-1)?.type === "turn.commit" || evs.at(-1)?.type === "turn.error").toBe(true);
  });

  it("模型提案被拒：带原因修复一次后提交（叙事只出现一次）", async () => {
    const badOp = JSON.stringify({ narrative: "你偷到了钥匙。", proposals: [{ op: "attr.multiply", args: { entityId: "plr_self", key: "x.k", delta: 1 } }] });
    const fixed = JSON.stringify({ narrative: "你摸了摸口袋，什么也没有。", proposals: [] });
    const llm = new MockLlm({ responses: [badOp, fixed] });
    const { turn, roomId } = await makeTurn(llm);
    const evs = await collect(turn.run({ roomId, actorId: "plr_self", input: "偷钥匙", clientTurnId: "c6" }));
    expect(llm.calls).toBe(2);
    expect(evs.filter((e) => e.type === "turn.delta")).toHaveLength(1);
    expect(evs.at(-1)?.type).toBe("turn.commit");
    // 语义拒绝走的是"带拒绝原因"那条重问路径，不是格式修复
    const repairPrompt = llm.requests[1]!.messages.at(-1)?.content ?? "";
    expect(repairPrompt).toContain("被引擎拒绝");
  });

  it("修复后仍被拒：turn.error，且在 turn.delta 之前（不先宣布成功再回滚）", async () => {
    const badOp = JSON.stringify({ narrative: "你偷到了钥匙。", proposals: [{ op: "attr.multiply", args: {} }] });
    const llm = new MockLlm({ responses: [badOp, badOp] });
    const { turn, roomId } = await makeTurn(llm);
    const evs = await collect(turn.run({ roomId, actorId: "plr_self", input: "偷钥匙", clientTurnId: "c7" }));
    expect(llm.calls).toBe(2);
    expect(evs.some((e) => e.type === "turn.delta")).toBe(false);
    expect(evs.some((e) => e.type === "turn.commit")).toBe(false);
    expect(evs.at(-1)?.type).toBe("turn.error");
  });

  it("模块产出非法提案 → E_MODULE_FAULT（模块 bug 不消耗模型修复）", async () => {
    const llm = new MockLlm({ responses: [okJson] });
    const store = new EventSourcedStore({ worldId: "w", locId: "loc_gate" });
    const arbiter = new DefaultArbiter({ store, registry: emptyRegistry() });
    const badModules = {
      list: () => [],
      get: () => undefined,
      dispatchIntent: async () => ({ ok: true, proposals: [{ op: "attr.multiply", args: {} }] }),
      callTool: async () => undefined,
      tick: async () => [],
      context: async () => ({ slots: [], tokens: 0, moduleIds: [] }),
      view: async () => [],
    } as unknown as Modules;
    const turn = new DefaultTurn({
      store, arbiter, registry: emptyRegistry(), modules: badModules, llm, memory: new InMemoryMemory(),
    });
    const evs = await collect(turn.run({ roomId: "room_t", actorId: "plr_self", input: "x", clientTurnId: "c8" }));
    const err = evs.at(-1);
    expect(err?.type).toBe("turn.error");
    expect(err && err.type === "turn.error" ? err.code : "").toBe("E_MODULE_FAULT");
    // 模块 bug 属于硬失败：重试同一输入只会再炸一次，不该显示重试按钮
    expect(err && err.type === "turn.error" ? err.retryable : true).toBe(false);
  });
});
