/**
 * issue #138：`expectAttrs` 的生产接线。
 *
 * 断言的是「apply 入口真的带上了基于开始快照的前置条件」，而不是文案：
 * Turn 用回合开始时的 `state0`，v2 用本步开头的 `ctx.state`；一旦世界在这之间被改过，
 * Arbiter 侧会整批 `E_PRECONDITION`（四问见 arbiter.expect.test.ts）。
 */
import { describe, expect, it } from "vitest";
import type { ApplyOptions, Envelope, LlmRequest, LlmResult, Proposal, RoomId } from "../../shared/src/index.ts";
import { DefaultArbiter } from "./arbiter.ts";
import { EventSourcedStore } from "./store.ts";
import { JsonRegistry } from "./registry.ts";
import { DefaultTurn } from "./turn.ts";
import { ModuleHost } from "./modules.ts";
import { InMemoryMemory } from "./memory.ts";
import { expectAttrsFor } from "./attr-expect.ts";

/** 只记录 apply 选项的真实 Arbiter：仍走完整裁决/落库链，不替换实现。 */
class SpyArbiter extends DefaultArbiter {
  readonly seen: ApplyOptions[] = [];
  override async apply(roomId: RoomId, ops: Proposal[], cause: Envelope, opts: ApplyOptions = {}) {
    this.seen.push(opts);
    return super.apply(roomId, ops, cause, opts);
  }
}

/** 回合里产出一条 attr.delta 的最小合法响应（实体由下面的 seed 事件创建） */
function deltaJson(key: string, delta: number): string {
  return JSON.stringify({
    narrative: "你把手里的东西放下。",
    dialogue: "",
    proposals: [{ op: "attr.delta", args: { entityId: "plr_self", key, delta }, reason: "test" }],
  });
}

async function makeTurn(raw: string) {
  const store = new EventSourcedStore({ worldId: "w", locId: "loc_gate" });
  // 用真实 content/registry：attr.delta 的键必须在 registry 里声明（I2），否则 Arbiter 会拒
  const registry = new JsonRegistry(undefined, new URL("../../../content/registry", import.meta.url).pathname);
  await registry.reload();
  const arbiter = new SpyArbiter({ store, registry });
  const modules = new ModuleHost({ dir: "/tmp/galgame-no-modules" });
  await modules.load();
  const llm = {
    calls: 0,
    async chat(_req: LlmRequest): Promise<LlmResult> {
      return { raw, usage: { promptTokens: 1, completionTokens: 1, calls: 1 }, model: "t", latencyMs: 0 };
    },
  };
  const turn = new DefaultTurn({ store, arbiter, registry, modules, llm, memory: new InMemoryMemory() });
  return { store, arbiter, turn, roomId: "room_expect" as RoomId };
}

describe("expectAttrs 接线（#138）", () => {
  it("Turn 的 apply 带上基于回合开始快照的前置条件（stamina=100）", async () => {
    const { store, arbiter, turn, roomId } = await makeTurn(deltaJson("stamina", 5));
    // 用真实事件建实体：Arbiter 只认状态里的实体，测试不手造 apply 结果。
    store.append(roomId, [{
      v: 1, id: "evt_seed", roomId, seq: 1, ts: 1, actorId: "system", type: "entity.created",
      payload: {
        entity: {
          id: "plr_self", kind: "plr", name: "我", attrs: { stamina: 100 }, tags: [],
          origin: "seed", canon: true, status: "active", createdAt: 1, updatedAt: 1,
        },
      },
    }]);
    const events = [];
    for await (const ev of turn.run({ roomId, actorId: "plr_self", input: "放下东西", clientTurnId: "c1" })) events.push(ev);
    expect(events.some((e) => e.type === "turn.commit")).toBe(true);
    const main = arbiter.seen.find((o) => (o.expectAttrs?.length ?? 0) > 0);
    expect(main?.expectAttrs).toEqual([{ entityId: "plr_self", key: "stamina", expected: 100 }]);
  });

  it("快照里没有的属性按契约传 expected:null（新写入的乐观校验）", async () => {
    const state = { entities: { npc_a: { attrs: {} } } } as never;
    const ops: Proposal[] = [{ op: "attr.set", args: { entityId: "npc_a", key: "guard", value: 3 } }];
    expect(expectAttrsFor(state, ops)).toEqual([{ entityId: "npc_a", key: "guard", expected: null }]);
  });

  it("同一实体同一属性只产生一条前置条件，非属性 op 不产生前置条件", async () => {
    const state = { entities: { e1: { attrs: { stamina: 7 } } } } as never;
    const ops: Proposal[] = [
      { op: "attr.delta", args: { entityId: "e1", key: "stamina", delta: 1 } },
      { op: "attr.set", args: { entityId: "e1", key: "stamina", value: 9 } },
      { op: "memory.write", args: { ownerId: "e1", content: "x" } },
    ];
    expect(expectAttrsFor(state, ops)).toEqual([{ entityId: "e1", key: "stamina", expected: 7 }]);
  });
});
