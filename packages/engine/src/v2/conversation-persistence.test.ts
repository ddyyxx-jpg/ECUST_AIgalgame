import { fileURLToPath } from "node:url";
/**
 * issue #90 回归：ConversationSessionV2 跨重启持久化 / 重放不重复 / seq 连续。
 * 快照落独立文件，不新增 EventLog 事件类型 → 契约版本不变（见 conversation-snapshot.ts）。
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ConversationEvent, Entity, Envelope, Utterance } from "../../../shared/src/index.ts";
import { MockLlm } from "../../../llm/src/mock.ts";
import { DefaultArbiter } from "../arbiter.ts";
import { EventSourcedStore } from "../store.ts";
import { emptyRegistry } from "../registry.ts";
import { EventSourcedMemory } from "../memory.ts";
import { AuditGate } from "../audit.gate.ts";
import { DEFAULT_AUDIT_POLICY, NoopAudit } from "../audit.ts";
import { loadConversationPolicy, loadModes } from "./delivery.ts";
import { SceneManager, type SceneAgentPort } from "./scene.ts";
import { NpcAgent } from "./npc-agent.ts";
import { ConversationAudit } from "./audit.ts";
import { ConversationHostV2 } from "./conversation.ts";
import { MessageIndex } from "./message.ts";
import { loadSnapshot, saveSnapshot, sessionSnapshotPath } from "./conversation-snapshot.ts";

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
function msgEnv(seq: number, id: string, from: string, to: string): Envelope {
  return env(seq, "msg.sent", {
    message: { id, roomId: ROOM, from, to, kind: "gossip", content: `msg-${id}`, hop: 0, confidence: 1, createdAt: seq, seq },
  });
}

const sceneAgent: SceneAgentPort = {
  describe: async ({ locName }) => `开场：${locName}`,
  summarize: async ({ trigger }) => `场景更新（${trigger}）`,
};

function seed(store: EventSourcedStore): void {
  store.append(ROOM, [
    env(1, "entity.created", { entity: entity(GATE, "loc", "图书馆") }),
    env(2, "entity.created", { entity: entity(PLR, "plr", "我") }),
    env(3, "entity.created", { entity: entity(LIN, "npc", "林月") }),
    env(4, "entity.created", { entity: entity(MA, "npc", "马骁") }),
    env(5, "scene.changed", { locId: GATE, presentIds: [PLR, LIN, MA] }),
  ]);
}

async function makeHost(store: EventSourcedStore, responses: string[], clock: { t: number }) {
  const registry = emptyRegistry();
  const memory = new EventSourcedMemory();
  const arbiter = new DefaultArbiter({ store, registry, memories: memory });
  const modes = await loadModes(MODES);
  const policy = { ...(await loadConversationPolicy(POLICY)), npcHardCap: 6 };
  const llm = new MockLlm({ responses });
  const gate = new AuditGate({ arbiter, store, registry, audit: new NoopAudit(), policy: DEFAULT_AUDIT_POLICY });
  const host = new ConversationHostV2({
    store, arbiter, registry, memory, modes, policy,
    scene: new SceneManager(sceneAgent, () => 1000),
    npc: new NpcAgent({ llm, modes, policy }),
    audit: new ConversationAudit(new NoopAudit(), DEFAULT_AUDIT_POLICY, gate),
    now: () => clock.t,
  });
  return { host, llm, memory };
}

async function collect(it: AsyncIterable<ConversationEvent>): Promise<ConversationEvent[]> {
  const out: ConversationEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}
const speak = (id: string, content: string): string => JSON.stringify({ kind: "speak", utterance: { id, mode: "broadcast", content } });
const think = (text: string): string => JSON.stringify({ kind: "think", mental: { thought: text, salience: 4 } });

describe("issue #90：会话快照跨重启恢复", () => {
  it("phase/turn/queue/sceneMemory 全字段往返；重启后同房间续聊且 seq 连续", async () => {
    const store1 = new EventSourcedStore({ worldId: "w1", locId: GATE });
    seed(store1);
    const { host: host1 } = await makeHost(store1, [], { t: 1000 });
    const s1 = await host1.open({ roomId: ROOM, participants: [PLR, LIN, MA] });
    await collect(host1.run(s1.id, { clientTurnId: "before-interject", interject: LIN }));

    // 覆盖 queue/injected/sceneMemory（正常流程暂不写这两个字段，但持久化必须原样保留）
    const u: Utterance = { id: "utt_queue", speaker: PLR, mode: "broadcast", content: "排队发言" };
    s1.queue.push(u);
    s1.injected.push(u);
    s1.sceneMemory = { id: "sm_1", roomId: ROOM, origin: "scene", text: "半常驻场景记忆", createdAt: 1000 };
    const before = host1.exportSessions(ROOM);
    const seqBefore = await store1.seq(ROOM);

    const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-conv-"));
    const file = sessionSnapshotPath(dir, ROOM);
    await saveSnapshot(file, before);
    const loaded = await loadSnapshot(file);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    // 模拟重启：同房间日志回放进新 store + 新 host，再导入快照
    const store2 = new EventSourcedStore({ worldId: "w1", locId: GATE });
    store2.append(ROOM, await store1.events(ROOM, 0));
    const { host: host2, llm: llm2 } = await makeHost(store2, [speak("utt_post", "重启后继续聊"), think("重启后心想")], { t: 1000 });
    expect(host2.restoreSessions(loaded.snapshot, ROOM)).toMatchObject({ restored: 1, degraded: false });

    const s2 = host2.getByRoom(ROOM);
    expect(s2).toBeDefined();
    expect(s2!.id).toBe(s1.id);
    expect(s2!.phase).toBe(s1.phase); // listening（插话后未超时）
    expect(s2!.turn).toBe(s1.turn);
    expect(s2!.queue).toEqual([u]);
    expect(s2!.injected).toEqual([u]);
    expect(s2!.sceneBeats).toEqual(s1.sceneBeats);
    expect(s2!.sceneMemory).toEqual(s1.sceneMemory);
    expect(s2!.lastLocId).toBe(s1.lastLocId);

    const events = await collect(host2.run(s2!.id, {
      clientTurnId: "after-restart",
      utterance: { id: "utt_player", speaker: PLR, mode: "broadcast", content: "我们接着聊" },
    }));
    expect(events.some((e) => e.type === "conversation.committed" && e.turn === s1.turn + 1)).toBe(true);
    expect(events.some((e) => e.type === "conversation.phase" && e.phase === "speaking")).toBe(true);
    expect(llm2.calls).toBe(2);

    const seqAfter = await store2.seq(ROOM);
    expect(seqAfter).toBeGreaterThan(seqBefore);
    const envs = await store2.events(ROOM, 0);
    expect(envs.map((e) => e.seq)).toEqual(envs.map((_, i) => i + 1)); // seq 连续无断档
  });

  it("快照文件往返、重复导入幂等、房间过滤与 closed 会话归一", async () => {
    const store = new EventSourcedStore({ worldId: "w1", locId: GATE });
    seed(store);
    const { host } = await makeHost(store, [], { t: 1000 });
    const s = await host.open({ roomId: ROOM, participants: [PLR, LIN, MA] });
    const snap = host.exportSessions(ROOM);
    const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-conv-"));
    const file = sessionSnapshotPath(dir, ROOM);
    await saveSnapshot(file, snap);
    const loaded = await loadSnapshot(file);
    expect(loaded.ok && loaded.snapshot).toEqual(snap);

    // #106：并发/重复保存使用独立 tmp 名，不残留固定 .tmp 覆盖邻居；落盘内容仍是最后一份
    const { readdir } = await import("node:fs/promises");
    const before = (await readdir(path.dirname(file))).filter((f) => f.endsWith(".tmp"));
    expect(before).toHaveLength(0); // 原子 rename 后不留临时文件
    await Promise.all([saveSnapshot(file, snap), saveSnapshot(file, snap)]);
    const after = (await readdir(path.dirname(file))).filter((f) => f.endsWith(".tmp"));
    expect(after).toHaveLength(0);

    const store2 = new EventSourcedStore({ worldId: "w1", locId: GATE });
    seed(store2);
    const { host: host2 } = await makeHost(store2, [], { t: 1000 });
    expect(host2.restoreSessions(snap).restored).toBe(1);
    expect(host2.restoreSessions(snap).restored).toBe(0); // 同 id 重复导入不产生第二份
    expect(host2.getByRoom(ROOM)?.id).toBe(s.id);

    const store3 = new EventSourcedStore({ worldId: "w1", locId: GATE });
    seed(store3);
    const { host: host3 } = await makeHost(store3, [], { t: 1000 });
    const mismatched = host3.restoreSessions(snap, "room_other");
    expect(mismatched.restored).toBe(0); // 房间隔离
    expect(mismatched.degraded).toBe(true); // #106：错档会话计入 degraded，不静默吞掉
    expect(host3.getByRoom(ROOM)).toBeUndefined();

    // turn 达上限的旧会话恢复为 closed，不会被 getByRoom 当成可续聊会话
    const closedSnap = { version: 1 as const, sessions: [{ ...snap.sessions[0]!, turn: snap.sessions[0]!.maxTurns }] };
    const { host: host4 } = await makeHost(new EventSourcedStore({ worldId: "w1", locId: GATE }), [], { t: 1000 });
    expect(host4.restoreSessions(closedSnap).restored).toBe(1);
    expect(host4.getByRoom(ROOM)).toBeUndefined();
  });

  it("降级：快照缺失/坏版本/坏档 → 旧会话 closed，改开新会话", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-conv-"));
    const file = sessionSnapshotPath(dir, ROOM);
    expect(await loadSnapshot(file)).toEqual({ ok: false, reason: "missing" });

    const store = new EventSourcedStore({ worldId: "w1", locId: GATE });
    seed(store);
    const { host } = await makeHost(store, [], { t: 1000 });
    const old = await host.open({ roomId: ROOM, participants: [PLR, LIN, MA] });
    expect(host.restoreSessions(undefined)).toMatchObject({ degraded: true, restored: 0 });
    expect(host.get(old.id)?.status).toBe("closed");
    const fresh = await host.open({ roomId: ROOM, participants: [PLR, LIN, MA] });
    expect(fresh.id).not.toBe(old.id);

    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 2, sessions: [] }), "utf8");
    expect(await loadSnapshot(file)).toEqual({ ok: false, reason: "bad-version" });
    expect(host.restoreSessions({ version: 2, sessions: [] })).toMatchObject({ degraded: true });

    await writeFile(file, "{not json", "utf8");
    expect(await loadSnapshot(file)).toEqual({ ok: false, reason: "invalid" });
    expect(host.restoreSessions({ version: 1, sessions: "bad" })).toMatchObject({ degraded: true });
  });

  it("#123 P1-1：幂等缓存随快照跨重启恢复，同 clientTurnId 原样重放不生成新回合", async () => {
    const store1 = new EventSourcedStore({ worldId: "w1", locId: GATE });
    seed(store1);
    const { host: h1 } = await makeHost(store1, [speak("utt_replay", "第一回合"), think("第一回合心想")], { t: 1000 });
    const s1 = await h1.open({ roomId: ROOM, participants: [PLR, LIN, MA] });
    const input = { clientTurnId: "turn-replay", utterance: { id: "utt_replay", speaker: PLR, mode: "broadcast" as const, content: "第一回合" } };
    const first = await collect(h1.run(s1.id, input));
    expect(first.some((e) => e.type === "conversation.committed" && e.turn === 1)).toBe(true);
    expect(h1.hasCommitted(s1.id, PLR, "turn-replay")).toBe(true);

    const snap = h1.exportSessions(ROOM);
    expect(snap.seen?.length).toBeGreaterThan(0); // 快照真的带上了 seen
    const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-conv-"));
    const file = sessionSnapshotPath(dir, ROOM);
    await saveSnapshot(file, snap);
    const loaded = await loadSnapshot(file);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const store2 = new EventSourcedStore({ worldId: "w1", locId: GATE });
    seed(store2);
    const { host: h2, llm: llm2 } = await makeHost(store2, [speak("utt_should_not_run", "不该出现"), think("不该出现")], { t: 1000 });
    expect(h2.restoreSessions(loaded.snapshot, ROOM)).toMatchObject({ restored: 1, degraded: false });
    expect(h2.hasCommitted(s1.id, PLR, "turn-replay")).toBe(true);

    const retry = await collect(h2.run(s1.id, input));
    expect(retry).toEqual(first); // 原样缓存：事件、turn 全等
    expect(llm2.calls).toBe(0); // 没调模型 → 没生成新回合 → 不会出现未计费的重复落库
    expect(retry.filter((e) => e.type === "conversation.committed").map((e) => e.type === "conversation.committed" ? e.turn : -1)).toEqual([1]);
  });

  it("#123 P1-5：房间 B 坏档只降级 B，不关掉房间 A 已恢复的 open 会话", async () => {
    const store = new EventSourcedStore({ worldId: "w1", locId: GATE });
    seed(store);
    const { host } = await makeHost(store, [], { t: 1000 });
    const a = await host.open({ roomId: ROOM, participants: [PLR, LIN, MA] });
    expect(host.get(a.id)?.status).toBe("open");

    // 模拟 bootstrap 顺序：A 快照正常恢复 → B 坏档解析失败
    const bad = host.restoreSessions({ version: 1, sessions: "bad" }, "room_bad");
    expect(bad).toMatchObject({ restored: 0, degraded: true, reason: "invalid" });
    expect(host.get(a.id)?.status).toBe("open"); // A 不能被 B 的坏档连带关闭
    expect(host.getByRoom(ROOM)?.id).toBe(a.id); // 仍可被路由层 getByRoom 复用
  });
});

describe("issue #90：MessageIndex rebuild 幂等 / msg.sent 回放不重复", () => {
  it("重复 rebuild 与重复回放均不产生重复消息", () => {
    const index = new MessageIndex();
    const events = [msgEnv(6, "msg_a", PLR, LIN), msgEnv(7, "msg_b", LIN, MA)];
    expect(index.ingest(events)).toBe(2);
    expect(index.ingest(events)).toBe(0); // 同一事件重复回放不入库
    index.rebuild(ROOM, events);
    index.rebuild(ROOM, events); // 重复 rebuild 幂等
    expect(index.inbox(ROOM, LIN).filter((m) => m.id === "msg_a")).toHaveLength(1);
    expect(index.inbox(ROOM, MA)).toHaveLength(1);
    expect(index.byMessageId("msg_a")?.seq).toBe(6);
    expect(index.chain(ROOM, "msg_a")).toHaveLength(0); // 无 rootId，链为空
  });

  it("#136 回归：autoRounds 进快照，重启后仍受 maxAutoRounds 限制", async () => {
    const store1 = new EventSourcedStore({ worldId: "w1", locId: GATE });
    seed(store1);
    const { host: host1 } = await makeHost(store1, [speak("u1", "一"), speak("u2", "二"), speak("u3", "三"), speak("u4", "四"), speak("u5", "五")], { t: 1000 });
    const s1 = await host1.open({ roomId: ROOM, participants: [PLR, LIN, MA] });
    await collect(host1.run(s1.id, { clientTurnId: "auto-1", auto: true }));
    await collect(host1.run(s1.id, { clientTurnId: "auto-2", auto: true }));
    expect(host1.getByRoom(ROOM)?.autoRounds).toBe(2);

    const store2 = new EventSourcedStore({ worldId: "w1", locId: GATE });
    store2.append(ROOM, await store1.events(ROOM, 0));
    const { host: host2 } = await makeHost(store2, [speak("u6", "六"), speak("u7", "七"), speak("u8", "八")], { t: 1000 });
    expect(host2.restoreSessions(host1.exportSessions(ROOM), ROOM).restored).toBe(1);
    const s2 = host2.getByRoom(ROOM)!;
    expect(s2.autoRounds).toBe(2);

    // 第 3 轮仍允许，第 4 轮应被 maxAutoRounds 拦住（且不调模型）
    const third = await collect(host2.run(s2.id, { clientTurnId: "auto-3", auto: true }));
    expect(third.some((e) => e.type === "conversation.committed")).toBe(true);
    const fourth = await collect(host2.run(s2.id, { clientTurnId: "auto-4", auto: true }));
    expect(fourth.some((e) => e.type === "conversation.notice")).toBe(true);
  });
});

