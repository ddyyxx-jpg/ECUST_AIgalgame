/**
 * 行动点（D21）：每回合扣点、归零拦截、失败不扣。
 * 断言的是 Proposal 落库结果（EventLog → snapshot），不是引擎文案。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LlmRequest, LlmResult, RoomId } from "../../shared/src/index.ts";
import { DefaultArbiter } from "./arbiter.ts";
import { EventSourcedStore, FileStore } from "./store.ts";
import { JsonRegistry } from "./registry.ts";
import { DefaultTurn } from "./turn.ts";
import { ModuleHost } from "./modules.ts";
import { InMemoryMemory } from "./memory.ts";

const ROOM = "room_action_points" as RoomId;

async function seed(store: EventSourcedStore, points: number): Promise<void> {
  await store.append(ROOM, [{
    v: 1, id: "evt_seed", roomId: ROOM, seq: 1, ts: 1, actorId: "system", type: "entity.created",
    payload: {
      entity: {
        id: "plr_self", kind: "plr", name: "我", attrs: { action_points: points }, tags: [],
        origin: "seed", canon: true, status: "active", createdAt: 1, updatedAt: 1,
      },
    },
  }]);
}

async function makeTurn(raw: string, store = new EventSourcedStore({ worldId: "w", locId: "loc_gate" })) {
  const registry = new JsonRegistry(undefined, new URL("../../../content/registry", import.meta.url).pathname);
  await registry.reload();
  const arbiter = new DefaultArbiter({ store, registry });
  const modules = new ModuleHost({ dir: "/tmp/galgame-no-modules" });
  await modules.load();
  const llm = {
    calls: 0,
    async chat(_req: LlmRequest): Promise<LlmResult> {
      this.calls += 1;
      return { raw, usage: { promptTokens: 1, completionTokens: 1, calls: 1 }, model: "t", latencyMs: 0 };
    },
  };
  const turn = new DefaultTurn({
    store, arbiter, registry, modules, llm, memory: new InMemoryMemory(),
    actionPolicy: { attrKey: "action_points", costPerTurn: 1 },
  });
  return { store, turn, llm };
}

function run(turn: DefaultTurn, clientTurnId: string): Promise<string[]> {
  return (async () => {
    const out: string[] = [];
    for await (const ev of turn.run({ roomId: ROOM, actorId: "plr_self", input: "坐下", clientTurnId })) {
      out.push(ev.type);
    }
    return out;
  })();
}

describe("行动点（D21）", () => {
  it("普通回合扣 1 点并提交", async () => {
    const { store, turn } = await makeTurn(JSON.stringify({ narrative: "你坐下了。", dialogue: "", proposals: [] }));
    await seed(store, 2);
    const events = await run(turn, "c1");
    expect(events).toContain("turn.commit");
    expect(store.state(ROOM).entities.plr_self?.attrs.action_points).toBe(1);
  });

  it("旧存档没有 action_points：不扣、不拦、不凭空造属性", async () => {
    const { store, turn } = await makeTurn(JSON.stringify({ narrative: "你坐下了。", dialogue: "", proposals: [] }));
    await store.append(ROOM, [{
      v: 1, id: "evt_seed_old", roomId: ROOM, seq: 1, ts: 1, actorId: "system", type: "entity.created",
      payload: {
        entity: {
          id: "plr_self", kind: "plr", name: "我", attrs: {}, tags: [],
          origin: "seed", canon: true, status: "active", createdAt: 1, updatedAt: 1,
        },
      },
    }]);
    const events = await run(turn, "c_old");
    expect(events).toContain("turn.commit");
    expect(store.state(ROOM).entities.plr_self?.attrs.action_points).toBeUndefined();
  });

  it("归零后拒绝，不调模型、不提交", async () => {
    const { store, turn, llm } = await makeTurn(JSON.stringify({ narrative: "你坐下了。", dialogue: "", proposals: [] }));
    await seed(store, 0);
    const events = await run(turn, "c2");
    expect(events).toContain("turn.error");
    expect(events).not.toContain("turn.commit");
    expect(llm.calls).toBe(0);
    expect(store.state(ROOM).entities.plr_self?.attrs.action_points).toBe(0);
  });

  it("FileStore 落盘后重启，行动点仍是扣过的值（真实数据链路）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "galgame-ap-"));
    const first = new FileStore(dir);
    await seed(first, 2);
    const { turn } = await makeTurn(JSON.stringify({ narrative: "你坐下了。", dialogue: "", proposals: [] }), first);
    expect(await run(turn, "c4")).toContain("turn.commit");
    expect(first.state(ROOM).entities.plr_self?.attrs.action_points).toBe(1);

    const reopened = new FileStore(dir);
    await reopened.load(ROOM);
    expect(reopened.state(ROOM).entities.plr_self?.attrs.action_points).toBe(1);
  });

  it("整批被拒时行动点不扣（atomic）", async () => {
    const bad = JSON.stringify({
      narrative: "你想把时间拨快。",
      dialogue: "",
      proposals: [{ op: "attr.delta", args: { entityId: "plr_self", key: "not_in_registry", delta: -1 }, reason: "bad" }],
    });
    const { store, turn } = await makeTurn(bad);
    await seed(store, 1);
    const events = await run(turn, "c3");
    expect(events).not.toContain("turn.commit");
    expect(store.state(ROOM).entities.plr_self?.attrs.action_points).toBe(1);
  });
});
