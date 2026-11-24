import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ConversationEvent, Entity, Envelope } from "../../../shared/src/index.ts";
import { MockLlm } from "../../../llm/src/mock.ts";
import { DefaultArbiter } from "../arbiter.ts";
import { EventSourcedStore } from "../store.ts";
import { JsonRegistry } from "../registry.ts";
import { EventSourcedMemory } from "../memory.ts";
import { AuditGate } from "../audit.gate.ts";
import { DEFAULT_AUDIT_POLICY, NoopAudit } from "../audit.ts";
import { loadConversationPolicy, loadModes } from "./delivery.ts";
import { SceneManager, type SceneAgentPort } from "./scene.ts";
import { NpcAgent } from "./npc-agent.ts";
import { ConversationAudit } from "./audit.ts";
import { ConversationHostV2 } from "./conversation.ts";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const ROOM = "room_ap";
const PLR = "plr_self";
const NPC = "npc_lin";
const GATE = "loc_library";

function entity(id: string, kind: Entity["kind"], name: string): Entity {
  return { id, kind, name, attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 };
}
function env(seq: number, type: string, payload: unknown): Envelope {
  return { v: 1, id: `evt_${seq}`, roomId: ROOM, seq, ts: seq, actorId: "system", type, payload };
}
const sceneAgent: SceneAgentPort = {
  describe: async ({ locName }) => `开场：${locName}`,
  summarize: async () => "场景更新",
};

/** #153 复审 P1：v2 会话默认路径也要扣行动点、0 点要拦（与 v1 同源） */
async function setup(points?: number) {
  const store = new EventSourcedStore({ worldId: "w1", locId: GATE });
  const plr = entity(PLR, "plr", "我");
  if (points !== undefined) plr.attrs.action_points = points;
  store.append(ROOM, [
    env(1, "entity.created", { entity: entity(GATE, "loc", "图书馆") }),
    env(2, "entity.created", { entity: plr }),
    env(3, "entity.created", { entity: entity(NPC, "npc", "林月") }),
    env(4, "scene.changed", { locId: GATE, presentIds: [PLR, NPC] }),
  ]);
  // 用真实 registry：`action_points` 必须已声明，否则 attr.delta 会被 E_ATTR_UNKNOWN 拒
  const registry = await JsonRegistry.load(`${ROOT}content/registry`);
  const memory = new EventSourcedMemory();
  const arbiter = new DefaultArbiter({ store, registry, memories: memory });
  const modes = await loadModes(`${ROOT}content/v2/utterance-modes.json`);
  const policy = await loadConversationPolicy(`${ROOT}content/v2/conversation-policy.json`);
  const llm = new MockLlm({ responses: [JSON.stringify({ kind: "speak", utterance: { id: "utt_1", mode: "broadcast", content: "嗯。", action: "点头" } })] });
  const gate = new AuditGate({ arbiter, store, registry, audit: new NoopAudit(), policy: DEFAULT_AUDIT_POLICY });
  const host = new ConversationHostV2({
    store, arbiter, registry, memory, modes, policy,
    scene: new SceneManager(sceneAgent, () => 1000),
    npc: new NpcAgent({ llm, modes, policy }),
    audit: new ConversationAudit(new NoopAudit(), DEFAULT_AUDIT_POLICY, gate),
    actionPolicy: { attrKey: "action_points", costPerTurn: 1 },
  });
  const session = await host.open({ roomId: ROOM, participants: [PLR, NPC] });
  return { host, session, store, llm };
}

async function collect(it: AsyncIterable<ConversationEvent>): Promise<ConversationEvent[]> {
  const out: ConversationEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const say = (id: string) => ({
  clientTurnId: id,
  utterance: { id: `u_${id}`, speaker: PLR, mode: "broadcast", content: "你好", target: "all" as const },
});

describe("v2 会话的行动点（#153 复审 P1）", () => {
  it("玩家回合扣 1 点，提案与 NPC 发言同批提交", async () => {
    const { host, session, store, llm } = await setup(1);
    const out = await collect(host.run(session.id, say("a1")));
    expect(out.some((e) => e.type === "conversation.committed")).toBe(true);
    const snap = await store.snapshot(ROOM);
    expect(snap.entities[PLR]?.attrs?.action_points).toBe(0);
    expect(llm.calls).toBe(1);
  });

  it("0 点时拒绝：E_PRECONDITION、不调模型、不落库", async () => {
    const { host, session, store, llm } = await setup(1);
    await collect(host.run(session.id, say("b1")));
    const before = llm.calls;
    const out = await collect(host.run(session.id, say("b2")));
    const err = out.find((e) => e.type === "conversation.error");
    expect(err).toMatchObject({ code: "E_PRECONDITION" });
    expect(String((err as { message?: string }).message)).toContain("行动点不足（0/1）");
    expect(out.some((e) => e.type === "conversation.committed")).toBe(false);
    expect(llm.calls).toBe(before);
    const snap = await store.snapshot(ROOM);
    expect(snap.entities[PLR]?.attrs?.action_points).toBe(0);
  });

  it("旧存档没有 action_points：不扣也不拦", async () => {
    const { host, session, store, llm } = await setup(undefined);
    const out = await collect(host.run(session.id, say("c1")));
    expect(out.some((e) => e.type === "conversation.committed")).toBe(true);
    expect(llm.calls).toBe(1);
    const snap = await store.snapshot(ROOM);
    expect(snap.entities[PLR]?.attrs?.action_points).toBeUndefined();
  });
});
