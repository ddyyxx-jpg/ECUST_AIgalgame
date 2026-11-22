import { fileURLToPath } from "node:url";
/**
 * Issue #93 五项行为回归（引擎侧）。
 * 只断言结构/计数与可见性标记，不断言任何 LLM 叙事文案。
 */
import { describe, expect, it } from "vitest";
import type {
  ConversationEvent, ConversationPolicy, Delivery, Entity, Envelope, LlmPort, Proposal, WorldState,
} from "../../../shared/src/index.ts";
import type { AuditPort, AuditVerdict } from "../audit.ts";
import { MockLlm } from "../../../llm/src/mock.ts";
import { DefaultArbiter } from "../arbiter.ts";
import { EventSourcedStore } from "../store.ts";
import { emptyRegistry } from "../registry.ts";
import { EventSourcedMemory } from "../memory.ts";
import { AuditGate } from "../audit.gate.ts";
import { DEFAULT_AUDIT_POLICY } from "../audit.ts";
import { ConversationAudit } from "./audit.ts";
import { loadConversationPolicy, loadModes } from "./delivery.ts";
import { SceneManager, type SceneAgentPort } from "./scene.ts";
import { NpcAgent } from "./npc-agent.ts";
import { ConversationHostV2 } from "./conversation.ts";
import { projectConversationEvents } from "./conversation.view.ts";
import { publicSceneText } from "./conversation.helpers.ts";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const MODES = `${ROOT}content/v2/utterance-modes.json`;
const POLICY = `${ROOT}content/v2/conversation-policy.json`;
const ROOM = "room_chat";
const PLR = "plr_self";
const LIN = "npc_lin";
const MA = "npc_ma";
const GATE = "loc_library";

function entity(id: string, kind: Entity["kind"], name: string): Entity {
  return { id, kind, name, attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 };
}
function env(seq: number, type: string, payload: unknown): Envelope {
  return { v: 1, id: `evt_${seq}`, roomId: ROOM, seq, ts: seq, actorId: "system", type, payload };
}
const sceneAgent: SceneAgentPort = {
  describe: async ({ locName }) => `loc:${locName}`,
  summarize: async ({ trigger }) => `sum:${trigger}`,
};
const speak = (id: string, mode: string, patch: Partial<{ content: string; action: string }> = {}): string =>
  JSON.stringify({ kind: "speak", utterance: { id, mode, ...patch } });
const silent = (): string => JSON.stringify({ kind: "silent" });

class FakeAudit implements AuditPort {
  async review(): Promise<AuditVerdict> {
    return { allow: true, categories: [], severity: 0, reason: "ok" };
  }
}
/** 注入一次 append 故障；arbiter 会把它判成 E_STORE_FAULT（状态与 seq 都不变） */
class FailAppendStore extends EventSourcedStore {
  failAppend = false;
  appendCalls = 0;
  override append(roomId: string, envs: Envelope[]): void {
    this.appendCalls += 1;
    if (this.failAppend) {
      this.failAppend = false;
      throw new Error("disk write failed once");
    }
    super.append(roomId, envs);
  }
}

async function setup(opts: {
  llm?: LlmPort;
  store?: EventSourcedStore;
  policy?: ConversationPolicy;
  now?: () => number;
} = {}) {
  const store = opts.store ?? new EventSourcedStore({ worldId: "w1", locId: GATE });
  if (!opts.store) {
    store.append(ROOM, [
      env(1, "entity.created", { entity: entity(GATE, "loc", "library") }),
      env(2, "entity.created", { entity: entity(PLR, "plr", "me") }),
      env(3, "entity.created", { entity: entity(LIN, "npc", "lin") }),
      env(4, "entity.created", { entity: entity(MA, "npc", "ma") }),
      env(5, "scene.changed", { locId: GATE, presentIds: [PLR, LIN, MA] }),
    ]);
  }
  const registry = emptyRegistry();
  const memory = new EventSourcedMemory();
  const arbiter = new DefaultArbiter({ store, registry, memories: memory });
  const modes = await loadModes(MODES);
  const policy = opts.policy ?? await loadConversationPolicy(POLICY);
  const audit = new FakeAudit();
  const llm = opts.llm ?? new MockLlm({ responses: [] });
  const host = new ConversationHostV2({
    store, arbiter, registry, memory, modes, policy,
    scene: new SceneManager(sceneAgent, () => 1000),
    npc: new NpcAgent({ llm, modes, policy }),
    audit: new ConversationAudit(audit, DEFAULT_AUDIT_POLICY, new AuditGate({ arbiter, store, registry, audit, policy: DEFAULT_AUDIT_POLICY })),
    now: opts.now,
  });
  const session = await host.open({ roomId: ROOM, participants: [PLR, LIN, MA] });
  return { host, session, memory, store, llm, modes };
}

async function collect(it: AsyncIterable<ConversationEvent>): Promise<ConversationEvent[]> {
  const out: ConversationEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}
const utterance = (id: string, content: string) => ({ id, speaker: PLR, mode: "broadcast", content });
const count = (events: ConversationEvent[], type: ConversationEvent["type"]) => events.filter((e) => e.type === type).length;
const committed = (events: ConversationEvent[]) => events.find((e) => e.type === "conversation.committed");

describe("Issue #93 行为修复", () => {
  it("① NPC 的公开发言进入其他接收者下一轮上下文（不改通道）", async () => {
    const marker = "MARKER_93_ALPHA";
    const llm = new MockLlm({
      responses: [speak("utt_l1", "broadcast", { content: marker }), silent(), silent(), silent()],
    });
    const { host, session } = await setup({ llm });
    await collect(host.run(session.id, { clientTurnId: "t1", utterance: utterance("utt_p1", "start") }));
    expect(llm.calls).toBe(2);

    await collect(host.run(session.id, { clientTurnId: "t2", utterance: utterance("utt_p2", "next") }));
    expect(llm.calls).toBe(4);
    const maTurn2 = llm.requests[3];
    expect(maTurn2).toBeDefined();
    const prompt = maTurn2.messages.map((m) => m.content).join("\n");
    // 用标记做存在性断言，不比较任何叙事文案
    expect(prompt).toContain(marker);
    expect(prompt).toContain("→ 你");
  });

  it("② 事件按观察者投影：目标与旁观者拿到不同投递，心理活动永不下发", async () => {
    const secret = "MARKER_93_WHISPER";
    const toLin: Delivery = { to: LIN, speaker: PLR, utteranceId: "u1", mode: "whisper", channels: ["content"], content: secret };
    const toMa: Delivery = { to: MA, speaker: PLR, utteranceId: "u1", mode: "whisper", channels: ["action"], action: "side" };
    const state: WorldState = {
      schemaVersion: 1,
      room: { id: ROOM, mode: "solo", worldId: "w1", members: [], scene: { locId: GATE, presentIds: [PLR, LIN, MA] }, createdAt: 0, lastActiveAt: 0 },
      entities: { [PLR]: entity(PLR, "plr", "me"), [LIN]: entity(LIN, "npc", "lin") },
      links: [
        { id: "l1", kind: "knows", from: PLR, to: LIN, audience: [LIN], createdAt: 0 },
        { id: "l2", kind: "knows", from: PLR, to: MA, createdAt: 0 },
      ],
      clock: { day: 1, phase: "morning", tick: 0 },
      plots: [{ id: "p1", goal: "g", actors: [LIN], forbidReveal: "MARKER_93_GM", status: "active" }],
      moduleState: { m1: { hidden: 1 } },
    };
    const proposals: Proposal[] = [
      { op: "memory.write", args: { ownerId: PLR, content: "public", visibility: "public", tags: ["dialogue"], salience: 60 } },
      { op: "memory.write", args: { ownerId: LIN, content: secret, visibility: "secret", tags: ["mental"], salience: 80 } },
      { op: "plot.upsert", args: { id: "p1", goal: "g", forbidReveal: "MARKER_93_GM", status: "active" } },
    ];
    const events: ConversationEvent[] = [
      { type: "conversation.utterance", delivery: toLin },
      { type: "conversation.utterance", delivery: toMa },
      { type: "conversation.mental", actorId: LIN, mental: { actorId: LIN, thought: secret, salience: 4 } },
      { type: "conversation.committed", sessionId: "s", turn: 1, proposals, state },
    ];
    const members = [PLR, LIN, MA];

    const forLin = projectConversationEvents(events, LIN, members);
    expect(forLin.filter((e) => e.type === "conversation.utterance")).toHaveLength(1);
    expect(count(forLin, "conversation.mental")).toBe(0);
    const c = committed(forLin);
    expect(c?.type).toBe("conversation.committed");
    if (c?.type !== "conversation.committed") return;
    expect(c.proposals).toHaveLength(2);
    expect(c.proposals.some((p) => p.op === "plot.upsert" && "forbidReveal" in p.args)).toBe(false);
    expect(c.state.links).toHaveLength(2); // 私有边对 LIN 可见 + 公开边
    expect(Object.keys(c.state.moduleState)).toHaveLength(0);
    expect(c.state.plots[0]).not.toHaveProperty("forbidReveal");

    const forMa = projectConversationEvents(events, MA, members);
    const maUtterances = forMa.filter((e) => e.type === "conversation.utterance");
    expect(maUtterances).toHaveLength(1);
    const maCommitted = committed(forMa);
    expect(maCommitted?.type).toBe("conversation.committed");
    if (maCommitted?.type === "conversation.committed") expect(maCommitted.state.links).toHaveLength(1); // LIN 的私有边被裁掉
    expect(maUtterances[0]).not.toEqual(forLin.find((e) => e.type === "conversation.utterance"));
    expect(projectConversationEvents(events, PLR, members).filter((e) => e.type === "conversation.utterance")).toHaveLength(0);

    // 共享场景总结只看 public 模式：whisper 正文不进 recent
    const modes = await loadModes(MODES);
    const publicOne: Delivery = { ...toLin, mode: "broadcast", channels: ["content"], content: "public" };
    expect(publicSceneText([toLin, toMa, publicOne], modes)).toHaveLength(1);
  });

  it("③ 同一 requestId 写盘失败后重试成功且恰好提交一次，失败时不发布外部事件", async () => {
    const llm = new MockLlm({ responses: [speak("utt_l1", "broadcast", { content: "lin" }), silent()] });
    const store = new FailAppendStore({ worldId: "w1", locId: GATE });
    store.append(ROOM, [
      env(1, "entity.created", { entity: entity(GATE, "loc", "library") }),
      env(2, "entity.created", { entity: entity(PLR, "plr", "me") }),
      env(3, "entity.created", { entity: entity(LIN, "npc", "lin") }),
      env(4, "entity.created", { entity: entity(MA, "npc", "ma") }),
      env(5, "scene.changed", { locId: GATE, presentIds: [PLR, LIN, MA] }),
    ]);
    const { host, session } = await setup({ llm, store });
    const input = { clientTurnId: "t-store", utterance: utterance("utt_p1", "go") };

    store.failAppend = true;
    const first = await collect(host.run(session.id, input));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: "conversation.error", code: "E_STORE_FAULT", retryable: true });
    expect(count(first, "conversation.utterance")).toBe(0);
    expect(count(first, "conversation.committed")).toBe(0);
    expect(store.seq(ROOM)).toBe(5); // 状态与 seq 都未变
    expect(host.get(session.id)?.turn).toBe(0);

    const callsBefore = store.appendCalls;
    const second = await collect(host.run(session.id, input));
    expect(store.appendCalls).toBe(callsBefore + 1); // 只重试一次写盘
    expect(count(second, "conversation.error")).toBe(0);
    expect(count(second, "conversation.committed")).toBe(1);
    expect(committed(second)).toMatchObject({ turn: 1 });
    expect(host.get(session.id)?.turn).toBe(1);
    expect(llm.calls).toBe(2); // 重试不重跑 NPC
    expect(store.seq(ROOM)).toBe(7); // 玩家 + NPC 各一条 memory.write
    const third = await collect(host.run(session.id, input));
    expect(count(third, "conversation.committed")).toBe(1); // 幂等：仍是那一次提交
    expect(store.appendCalls).toBe(callsBefore + 1);
  });

  it("④ 会话 A 的回合不返回会话 B 的插话超时事件", async () => {
    let clock = 1000;
    const llm = new MockLlm({ handler: () => silent() });
    const { host, session: a } = await setup({ llm, now: () => clock });
    const b = await host.open({ roomId: ROOM, participants: [PLR, LIN, MA] });

    await collect(host.run(a.id, { clientTurnId: "ia", interject: LIN }));
    await collect(host.run(b.id, { clientTurnId: "ib", interject: LIN }));
    expect(host.get(a.id)?.phase).toBe("listening");
    expect(host.get(b.id)?.phase).toBe("listening");

    clock += 40000; // > listenTimeoutMs
    const evsA = await collect(host.run(a.id, { clientTurnId: "ta", utterance: utterance("utt_a", "go A") }));
    const phaseA = evsA.filter((e) => e.type === "conversation.phase");
    expect(phaseA).toHaveLength(1);
    expect(phaseA[0]).toMatchObject({ sessionId: a.id, phase: "speaking" });
    expect(evsA.some((e) => e.type === "conversation.phase" && e.sessionId === b.id)).toBe(false);

    const evsB = await collect(host.run(b.id, { clientTurnId: "tb", utterance: utterance("utt_b", "go B") }));
    const phaseB = evsB.filter((e) => e.type === "conversation.phase");
    expect(phaseB).toHaveLength(1);
    expect(phaseB[0]).toMatchObject({ sessionId: b.id, phase: "speaking" });
    expect(evsB.some((e) => e.type === "conversation.phase" && e.sessionId === a.id)).toBe(false);
  });

  it("⑤ 心理组合不超限，其他 NPC 的合法产出仍可提交", async () => {
    const thought = "T".repeat(300);
    const plan = "P".repeat(200);
    const llm = new MockLlm({
      responses: [
        JSON.stringify({ kind: "think", mental: { thought, plan, salience: 4 } }),
        speak("utt_ma", "broadcast", { content: "legal" }),
      ],
    });
    const { host, session } = await setup({ llm });
    const evs = await collect(host.run(session.id, { clientTurnId: "t-over", utterance: utterance("utt_p1", "start") }));
    expect(count(evs, "conversation.error")).toBe(0);
    expect(count(evs, "conversation.mental")).toBe(1);
    const c = committed(evs);
    expect(c?.type).toBe("conversation.committed");
    if (c?.type !== "conversation.committed") return;
    const writes = c.proposals.filter((p) => p.op === "memory.write");
    expect(writes).toHaveLength(3); // 玩家 + 思考 NPC + 说话 NPC
    const mentalWrite = writes.find((p) => p.args.ownerId === LIN);
    expect(mentalWrite).toBeDefined();
    expect(String(mentalWrite?.args.content).length).toBeLessThanOrEqual(500);
    expect(writes.some((p) => p.args.ownerId === MA)).toBe(true);
  });
});
