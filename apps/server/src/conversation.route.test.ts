/**
 * dev/v2 群聊 HTTP 接线回归（issue #89）：
 * - 一回合 SSE 推 ConversationEvent；
 * - clientTurnId 重放不重复调模型/落库（幂等在 ConversationHostV2 内）；
 * - 老 /turns 不受影响；越权 actorId 403。
 */
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { tempDir } from "@galgame/testkit";
import type { Proposal, WorldState } from "../../../packages/shared/src/contract/types.ts";
import type { ConversationEvent, ConversationSessionV2 } from "../../../packages/shared/src/contract/v2.ts";
import { MockLlm } from "../../../packages/llm/src/mock.ts";
import {
  AuditGate,
  DEFAULT_AUDIT_POLICY,
  NoopAudit,
  type AuditPort,
} from "../../../packages/engine/src/index.ts";
import type { EventLog } from "../../../packages/engine/src/store.ts";
import {
  ConversationAudit,
  ConversationHostV2,
  NpcAgent,
  SceneManager,
  type SceneAgentPort,
  loadConversationPolicy,
  loadModes,
} from "../../../packages/engine/src/v2/index.ts";
import { createApp, type App } from "./bootstrap.ts";
import { registerRoutes } from "./routes.ts";
import type { ServerConfig } from "./config.ts";

const CONTENT = "content";
const MODES = `${CONTENT}/v2/utterance-modes.json`;
const POLICY = `${CONTENT}/v2/conversation-policy.json`;

function testConfig(): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: tempDir("galgame-conversation-"),
    contentDir: CONTENT,
    adminToken: "dev-admin",
    trustUserHeader: true,
    llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
    audit: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1000 },
  };
}

const prevScan = process.env.GALGAME_GOSSIP_SCAN_MS;
const prevMax = process.env.GALGAME_CONVERSATION_MAX_SESSIONS;
afterAll(() => {
  if (prevScan === undefined) delete process.env.GALGAME_GOSSIP_SCAN_MS;
  else process.env.GALGAME_GOSSIP_SCAN_MS = prevScan;
  if (prevMax === undefined) delete process.env.GALGAME_CONVERSATION_MAX_SESSIONS;
  else process.env.GALGAME_CONVERSATION_MAX_SESSIONS = prevMax;
});

type LlmHandler = (req: { messages?: { role: string; content: string }[] }) => string;

/** #146：结算分支回归需要能注入「审核必拦」与更小的 auto 上限 */
interface AppWithOpts {
  audit?: AuditPort;
  maxAutoRounds?: number;
}

async function appWith(
  handler?: LlmHandler,
  opts: AppWithOpts = {},
): Promise<{ app: FastifyInstance; deps: App; roomId: string; actorId: string; llm: MockLlm }> {
  process.env.GALGAME_GOSSIP_SCAN_MS = "0";
  const deps = await createApp(testConfig());
  const { roomId, actorId } = await deps.createRoom("solo", "u_owner");

  // 用真实 host + 假 LLM：不为氛围调场景 agent，NPC 本轮一律沉默（断言只看玩家交付与结算）
  const modes = await loadModes(MODES);
  const loaded = await loadConversationPolicy(POLICY);
  // #146：auto 上限可注入（默认读 content/v2 的策略），审核端口可换成必拦实现
  const policy = opts.maxAutoRounds === undefined ? loaded : { ...loaded, maxAutoRounds: opts.maxAutoRounds };
  const scene: SceneAgentPort = { describe: async () => "test scene", summarize: async () => "test summary" };
  const llm = new MockLlm({ handler: handler ?? (() => JSON.stringify({ kind: "silent", reason: "test" })) });
  const audit = opts.audit ?? new NoopAudit();
  const store = deps.store as EventLog;
  const arbiter = deps.arbiter;
  deps.conversation = {
    host: new ConversationHostV2({
      store,
      arbiter,
      registry: deps.registry,
      memory: deps.memory,
      modes,
      policy,
      scene: new SceneManager(scene, () => 1000),
      npc: new NpcAgent({ llm, modes, policy }),
      audit: new ConversationAudit(audit, DEFAULT_AUDIT_POLICY, new AuditGate({ arbiter, store, registry: deps.registry, audit, policy: DEFAULT_AUDIT_POLICY })),
    }),
    modes,
  };

  const app = Fastify();
  registerRoutes(app, deps);
  return { app, deps, roomId, actorId, llm };
}

/** SSE 文本 → {type, data}；断言结构不断言文案（AGENTS §6） */
function sse(body: string): { type: string; data: Record<string, unknown> }[] {
  return body
    .split("\n\n")
    .filter(Boolean)
    .flatMap((block) => {
      const type = /^event: (.+)$/m.exec(block)?.[1];
      const raw = /^data: (.+)$/m.exec(block)?.[1];
      return type && raw ? [{ type, data: JSON.parse(raw) as Record<string, unknown> }] : [];
    });
}

const payload = (actorId: string, clientTurnId: string) => ({
  actorId,
  clientTurnId,
  utterance: { id: `utt_${clientTurnId}`, mode: "broadcast", content: "大家好" },
});

/** 可控假 host：只实现路由用到的 open/get/run，让 SSE 断言不依赖 LLM/NPC 数量与文案 */
function fakeConversationHost(opts: {
  events: ConversationEvent[];
  openDelayMs?: number;
  runDelayMs?: number;
}): { host: ConversationHostV2; openCalls: () => number; closeCalls: () => string[] } {
  let opens = 0;
  const closed: string[] = [];
  const sessions = new Map<string, ConversationSessionV2>();
  const host = {
    async open(spec: { roomId: string; participants: string[] }): Promise<ConversationSessionV2> {
      opens += 1;
      if (opts.openDelayMs) await new Promise<void>((resolve) => setTimeout(resolve, opts.openDelayMs));
      const session: ConversationSessionV2 = {
        id: `conv_${opens}`,
        roomId: spec.roomId,
        participants: [...spec.participants],
        phase: "speaking", turn: 0, maxTurns: 10, status: "open",
        queue: [], injected: [], sceneBeats: [], npcSpeechStreak: 0, visibility: "scene",
      };
      sessions.set(session.id, session);
      return session;
    },
    get(id: string): ConversationSessionV2 | undefined { return sessions.get(id); },
    // #123：路由层 openOrReuse 在 Map miss 时回退 getByRoom；reserve 时用 hasCommittedByRoom 确认真重放
    getByRoom(roomId: string): ConversationSessionV2 | undefined {
      return [...sessions.values()].filter((s) => s.roomId === roomId && s.status === "open").at(-1);
    },
    hasCommittedByRoom(): boolean { return false; },
    close(id: string): boolean {
      closed.push(id);
      const s = sessions.get(id);
      if (s) s.status = "closed";
      return sessions.has(id);
    },
    async *run(_sessionId: string): AsyncIterable<ConversationEvent> {
      if (opts.runDelayMs) await new Promise<void>((resolve) => setTimeout(resolve, opts.runDelayMs));
      for (const ev of opts.events) yield ev;
    },
  } as unknown as ConversationHostV2;
  return { host, openCalls: () => opens, closeCalls: () => closed };
}

/** 换掉 host 但不换房间/账号：房间仍由 createApp 真建，guardRoom/roomGate 照常生效 */
async function appWithHost(makeHost: (roomId: string, actorId: string) => ConversationHostV2) {
  process.env.GALGAME_GOSSIP_SCAN_MS = "0";
  const deps = await createApp(testConfig());
  const { roomId, actorId } = await deps.createRoom("solo", "u_owner");
  deps.conversation = { host: makeHost(roomId, actorId) };
  const app = Fastify();
  registerRoutes(app, deps);
  return { app, deps, roomId, actorId };
}

/** 未认识某个 NPC、且该 NPC 在场的极小 committed 状态（用于姓名解锁/脱敏顺序断言） */
function unknownNpcState(roomId: string, actorId: string, npcId: string): WorldState {
  return {
    schemaVersion: 1,
    room: {
      id: roomId, mode: "solo", worldId: "w1", members: [],
      scene: { locId: "loc", presentIds: [actorId, npcId] }, createdAt: 0, lastActiveAt: 0,
    },
    entities: {
      [npcId]: {
        id: npcId, kind: "npc", name: "严守一", attrs: { knows_name: false }, tags: [],
        origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0,
      },
    },
    links: [],
    clock: { day: 1, phase: "morning", tick: 0 },
    plots: [],
    moduleState: {},
  };
}

/** 一个已认识、一个未认识的 NPC + 带私忆/GM 字段的 committed 状态（只断言结构，不断言文案） */
function viewState(roomId: string, known: string, unknown: string): WorldState {
  const npc = (id: string, name: string, knows: boolean) => ({
    id, kind: "npc" as const, name, attrs: { knows_name: knows }, tags: [],
    origin: "seed" as const, canon: true, status: "active" as const, createdAt: 0, updatedAt: 0,
  });
  return {
    schemaVersion: 1,
    room: {
      id: roomId, mode: "solo", worldId: "w1", members: [],
      scene: { locId: "loc", presentIds: [known, unknown] }, createdAt: 0, lastActiveAt: 0,
    },
    entities: { [known]: npc(known, "白晓通", true), [unknown]: npc(unknown, "严守一", false) },
    links: [],
    clock: { day: 1, phase: "morning", tick: 0 },
    plots: [{ id: "p1", goal: "g", actors: [known], forbidReveal: "GM_SECRET", status: "active" }],
    moduleState: { m1: { hidden: "HIDDEN_MODULE" } },
  };
}

describe("dev/v2 群聊 HTTP 端点（issue #89）", () => {
  it("正常回合：SSE 推 opened/utterance/committed，speaker 绑定为调用者", async () => {
    const { app, roomId, actorId } = await appWith();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/conversation`,
      headers: { "x-user-id": "u_owner" },
      payload: { ...payload(actorId, "c1"), utterance: { id: "utt_c1", mode: "broadcast", content: "大家好", speaker: "npc_forged" } },
    });
    expect(res.statusCode).toBe(200);
    const events = sse(res.body);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["conversation.opened", "conversation.utterance", "conversation.committed"]));
    const deliveries = events.filter((e) => e.type === "conversation.utterance").map((e) => e.data.delivery as { speaker: string });
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries.every((d) => d.speaker === actorId)).toBe(true);
    expect(events.some((e) => e.type === "conversation.error")).toBe(false);
    await app.close();
  });

  it("clientTurnId 重放：原样重放缓存事件，不重复调模型/落库", async () => {
    const { app, deps, roomId, actorId, llm } = await appWith();
    const url = `/api/v1/rooms/${roomId}/conversation`;
    const headers = { "x-user-id": "u_owner" };
    const first = await app.inject({ method: "POST", url, headers, payload: payload(actorId, "replay-1") });
    expect(first.statusCode).toBe(200);
    const eventsBefore = await deps.store.events(roomId, 0);
    const callsAfterFirst = llm.calls;

    const second = await app.inject({ method: "POST", url, headers, payload: payload(actorId, "replay-1") });
    expect(second.statusCode).toBe(200);
    expect(llm.calls).toBe(callsAfterFirst);
    expect(await deps.store.events(roomId, 0)).toEqual(eventsBefore);
    const committed = (body: string) => sse(body).filter((e) => e.type === "conversation.committed");
    expect(committed(second.body)).toEqual(committed(first.body));
    // 重放复用同一 session，不再发 opened
    expect(sse(second.body).some((e) => e.type === "conversation.opened")).toBe(false);
    await app.close();
  });

  it("#104：会话 Map 淘汰旧 room 时调用 host.close() 清理（不泄漏）", async () => {
    const prevMax = process.env.GALGAME_CONVERSATION_MAX_SESSIONS;
    process.env.GALGAME_CONVERSATION_MAX_SESSIONS = "2";
    try {
      const fake = fakeConversationHost({ events: [] });
      process.env.GALGAME_GOSSIP_SCAN_MS = "0";
      const deps = await createApp(testConfig());
      const rooms = [await deps.createRoom("solo", "u_owner"), await deps.createRoom("solo", "u_owner"), await deps.createRoom("solo", "u_owner")];
      deps.conversation = { host: fake.host };
      const app = Fastify();
      registerRoutes(app, deps);
      const H = { "x-user-id": "u_owner" };
      for (const { roomId, actorId } of rooms) {
        const res = await app.inject({
          method: "POST", url: `/api/v1/rooms/${roomId}/conversation`, headers: H,
          payload: payload(actorId, `evict-${roomId}`),
        });
        expect(res.statusCode).toBe(200);
      }
      // 3 个房间、上限 2 → 第 1 个被淘汰，host.close 至少被调用一次且对象被标记 closed
      expect(fake.closeCalls().length).toBeGreaterThanOrEqual(1);
      expect(fake.host.get(fake.closeCalls()[0]!)?.status).toBe("closed");
      await app.close();
    } finally {
      if (prevMax === undefined) delete process.env.GALGAME_CONVERSATION_MAX_SESSIONS;
      else process.env.GALGAME_CONVERSATION_MAX_SESSIONS = prevMax;
    }
  });

  it("#104：/conversation 计入 TurnLedger 额度——成功后 committed，超额 429 且共享 /turns 账本", async () => {
    const { app, deps, roomId, actorId } = await appWith();
    const url = `/api/v1/rooms/${roomId}/conversation`;
    const H = { "x-user-id": "u_owner", origin: "https://galgame.test" };
    // 与 v1 /turns 同一 dailyLimitFor/ledger：把默认额度设为 1
    await app.inject({
      method: "PUT", url: "/api/v1/admin/settings",
      headers: { "x-admin-token": "dev-admin", origin: "https://galgame.test" },
      payload: { defaultDailyTurns: 1 },
    });

    const first = await app.inject({ method: "POST", url, headers: H, payload: payload(actorId, "quota-c1") });
    expect(first.statusCode).toBe(200);
    expect(sse(first.body).some((e) => e.type === "conversation.committed")).toBe(true);
    // 账本条目已提交（作用域：u_owner + roomId + clientTurnId）
    expect(deps.ledger.get({ userId: "u_owner", roomId, clientTurnId: "quota-c1" })?.state).toBe("committed");

    // 第二个逻辑回合：额度已用完 → 429 E_RATE_LIMITED，拒绝在 SSE 头之前（普通 JSON）
    const second = await app.inject({ method: "POST", url, headers: H, payload: payload(actorId, "quota-c2") });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ ok: false, code: "E_RATE_LIMITED" });
    expect(second.headers["content-type"]).not.toContain("text/event-stream");

    // 与 /turns 共用同一账本：v1 回合同样被额度拦住
    const v1 = await app.inject({
      method: "POST", url: `/api/v1/rooms/${roomId}/turns`, headers: H,
      payload: { actorId, input: "你好", clientTurnId: "quota-v1" },
    });
    expect(v1.statusCode).toBe(429);
    expect(v1.json()).toMatchObject({ ok: false, code: "E_RATE_LIMITED" });
    await app.close();
  });

  it("#146 审核拦截（只推 notice、无 committed）→ 账本 unconfirmed（占用额度，不释放）", async () => {
    // 审核器一律判违规：引擎只推 conversation.notice，不产出 committed/error
    const blockedAudit: AuditPort = {
      review: async () => ({ allow: false, categories: ["test"], severity: 3, reason: "test block" }),
    };
    const { app, deps, roomId, actorId } = await appWith(undefined, { audit: blockedAudit });
    const res = await app.inject({
      method: "POST", url: `/api/v1/rooms/${roomId}/conversation`,
      headers: { "x-user-id": "u_owner" },
      payload: payload(actorId, "blocked-1"),
    });
    expect(res.statusCode).toBe(200);
    const events = sse(res.body);
    expect(events.some((e) => e.type === "conversation.notice")).toBe(true);
    expect(events.some((e) => e.type === "conversation.committed")).toBe(false);
    // 审核是真实发生过的一次调用 → 不能按失败把额度放回去（#146 第 1 条）
    expect(deps.ledger.get({ userId: "u_owner", roomId, clientTurnId: "blocked-1" })?.state).toBe("unconfirmed");
    await app.close();
  });

  it("#146 auto 超 maxAutoRounds（只推 notice、未调模型）→ 账本 failed（释放额度）", async () => {
    const { app, deps, roomId, actorId } = await appWith(undefined, { maxAutoRounds: 0 });
    const res = await app.inject({
      method: "POST", url: `/api/v1/rooms/${roomId}/conversation`,
      headers: { "x-user-id": "u_owner" },
      payload: { actorId, clientTurnId: "auto-limit-1", auto: true },
    });
    expect(res.statusCode).toBe(200);
    const events = sse(res.body);
    expect(events.some((e) => e.type === "conversation.notice")).toBe(true);
    expect(events.some((e) => e.type === "conversation.committed")).toBe(false);
    // 没调模型也没写世界 → 按 failed 回收额度
    expect(deps.ledger.get({ userId: "u_owner", roomId, clientTurnId: "auto-limit-1" })?.state).toBe("failed");
    await app.close();
  });

  it("老 /turns 不受影响", async () => {
    const { app, roomId, actorId } = await appWith();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/turns`,
      headers: { "x-user-id": "u_owner" },
      payload: { actorId, input: "看看四周", clientTurnId: "v1-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(sse(res.body).map((e) => e.type)).toContain("turn.commit");
    await app.close();
  });

  it("越权 403：非本房账号不能提交群聊回合", async () => {
    const { app, roomId, actorId } = await appWith();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/conversation`,
      headers: { "x-user-id": "u_other" },
      payload: payload(actorId, "denied-1"),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ ok: false, code: "E_FORBIDDEN" });
    await app.close();
  });

  it("interject 是被插话的 NPC，不能拿来冒充调用者", async () => {
    const { app, roomId, actorId } = await appWith();
    const url = `/api/v1/rooms/${roomId}/conversation`;
    const withoutActor = await app.inject({
      method: "POST", url, headers: { "x-user-id": "u_owner" }, payload: { clientTurnId: "intercept-1", interject: "npc_lin" },
    });
    expect(withoutActor.statusCode).toBe(400);

    // 带本人 actorId 时插话只切 phase，不推进回合；引擎收到的 interject 是 NPC id 而非玩家 id
    const withActor = await app.inject({
      method: "POST", url, headers: { "x-user-id": "u_owner" },
      payload: { actorId, clientTurnId: "intercept-2", interject: "npc_lin" },
    });
    expect(withActor.statusCode).toBe(200);
    expect(sse(withActor.body).map((e) => e.type)).toContain("conversation.phase");
    await app.close();
  });

  it("#106：HTTP 边界——超长 utterance、interject+utterance 同给、未知 sessionId 均按契约拒绝/不崩", async () => {
    const { app, roomId, actorId } = await appWith();
    const url = `/api/v1/rooms/${roomId}/conversation`;
    const H = { "x-user-id": "u_owner" };

    // 1) utterance.content 超过 2000 字 → zod 400 E_SCHEMA_INVALID，不开 SSE 流
    const tooLong = await app.inject({
      method: "POST", url, headers: H,
      payload: { actorId, clientTurnId: "boundary-long", utterance: { mode: "broadcast", content: "x".repeat(2001) } },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json()).toMatchObject({ ok: false, code: "E_SCHEMA_INVALID" });

    // 2) interject 与 utterance 同时给：实现按既有语义接受（插话只切 phase，utterance 忽略），
    //    不崩且 200。显式锁住该行为，避免后续把两者同时给当成非法输入而误改（#106 记文档口径）。
    const both = await app.inject({
      method: "POST", url, headers: H,
      payload: { actorId, clientTurnId: "boundary-both", interject: "npc_lin", utterance: { mode: "broadcast", content: "大家好" } },
    });
    expect(both.statusCode).toBe(200);
    expect(both.headers["content-type"]).toContain("text/event-stream");

    // 3) 未知 sessionId：ConversationBody 不接收 sessionId 字段（strict），传了 → 400 E_SCHEMA_INVALID，
    //    服务端不会去 host.get 一个不存在的会话（无 replay/越权面）。
    const unknownSession = await app.inject({
      method: "POST", url, headers: H,
      payload: { ...payload(actorId, "boundary-session"), sessionId: "conv_missing" },
    });
    expect(unknownSession.statusCode).toBe(400);
    expect(unknownSession.json()).toMatchObject({ ok: false, code: "E_SCHEMA_INVALID" });
    await app.close();
  });

  it("事件结构与契约一致：committed 带 sessionId/turn/state", async () => {
    const { app, roomId, actorId } = await appWith();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/conversation`,
      headers: { "x-user-id": "u_owner" },
      payload: payload(actorId, "shape-1"),
    });
    const ev = sse(res.body).find((e) => e.type === "conversation.committed");
    expect(ev).toBeTruthy();
    const data = ev!.data as unknown as Extract<ConversationEvent, { type: "conversation.committed" }>;
    expect(typeof data.sessionId).toBe("string");
    expect(typeof data.turn).toBe("number");
    expect(data.state.room.id).toBe(roomId);
    await app.close();
  });

  it("BLOCKER-1：玩家 SSE 按观察者投影——无他人 mental/私聊，committed 私忆与 GM 字段裁掉，已认识名不回归", async () => {
    const KNOWN = "npc_known";
    const UNKNOWN = "npc_unknown";
    const { app, roomId, actorId } = await appWithHost((rid, viewer) => {
      const proposals: Proposal[] = [
        { op: "memory.write", args: { ownerId: KNOWN, content: "PUBLIC_MEMO", visibility: "public", tags: ["dialogue"], salience: 60 } },
        { op: "memory.write", args: { ownerId: KNOWN, content: "SECRET_THOUGHT_A", visibility: "secret", tags: ["mental"], salience: 80 } },
        { op: "plot.upsert", args: { id: "p1", goal: "g", forbidReveal: "GM_SECRET", status: "active" } },
      ];
      const events: ConversationEvent[] = [
        // 给别人的 whisper：正文里带标记，玩家侧连事件都不该收到
        { type: "conversation.utterance", delivery: { to: KNOWN, speaker: UNKNOWN, utteranceId: "u1", mode: "whisper", channels: ["content"], content: "SECRET_WHISPER" } },
        // 给玩家自己的广播：两个 NPC 名字都在正文里，只有未认识的应被遮掉
        { type: "conversation.utterance", delivery: { to: viewer, speaker: KNOWN, utteranceId: "u2", mode: "broadcast", channels: ["content"], content: "你好，白晓通和严守一" } },
        { type: "conversation.mental", actorId: KNOWN, mental: { actorId: KNOWN, thought: "SECRET_THOUGHT_B", salience: 4 } },
        { type: "conversation.committed", sessionId: "conv_1", turn: 1, proposals, state: viewState(rid, KNOWN, UNKNOWN) },
      ];
      return fakeConversationHost({ events }).host;
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/conversation`,
      headers: { "x-user-id": "u_owner" },
      payload: payload(actorId, "project-1"),
    });
    expect(res.statusCode).toBe(200);
    const events = sse(res.body);
    expect(events.some((e) => e.type === "conversation.mental")).toBe(false);
    expect(res.body).not.toContain("SECRET_THOUGHT_A");
    expect(res.body).not.toContain("SECRET_THOUGHT_B");
    expect(res.body).not.toContain("SECRET_WHISPER");
    expect(res.body).not.toContain("HIDDEN_MODULE");

    const utterances = events.filter((e) => e.type === "conversation.utterance");
    expect(utterances).toHaveLength(1);
    const delivery = (utterances[0]!.data as unknown as Extract<ConversationEvent, { type: "conversation.utterance" }>).delivery;
    expect(delivery.to).toBe(actorId);

    const committed = events.find((e) => e.type === "conversation.committed");
    expect(committed).toBeTruthy();
    const data = committed!.data as unknown as Extract<ConversationEvent, { type: "conversation.committed" }>;
    expect(data.proposals).toHaveLength(2); // 私忆 proposal 被裁掉，public 记忆与 plot 保留
    expect(data.proposals.some((p) => JSON.stringify(p).includes("SECRET_THOUGHT_A"))).toBe(false);
    expect(data.proposals.some((p) => p.op === "plot.upsert" && "forbidReveal" in p.args)).toBe(false);
    expect(data.state.plots[0]).not.toHaveProperty("forbidReveal");
    expect(Object.keys(data.state.moduleState)).toHaveLength(0);

    // 已认识的人名不回归；未认识的仍被遮成占位名（maskNamesDeep 在投影之后执行）
    expect(res.body).toContain("白晓通");
    expect(res.body).not.toContain("严守一");
    await app.close();
  });

  it("MAJOR-2：并发首回合只 open 一个会话（openOrReuse 纳入房间串行）", async () => {
    const fake = fakeConversationHost({ events: [], openDelayMs: 20, runDelayMs: 20 });
    const { app, roomId, actorId } = await appWithHost(() => fake.host);
    const url = `/api/v1/rooms/${roomId}/conversation`;
    // 两条请求带 userId（#104 起会走 TurnLedger），但不同 clientTurnId；
    // 预留+host.run+结算共用房间串行锁，第二条须等第一条 committed 后再 reserve（不应 E_TURN_BUSY）。
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url, headers: { "x-user-id": "u_owner" }, payload: payload(actorId, "race-1") }),
      app.inject({ method: "POST", url, headers: { "x-user-id": "u_owner" }, payload: payload(actorId, "race-2") }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(fake.openCalls()).toBe(1);
    const opened = [a, b].flatMap((r) => sse(r.body)).filter((e) => e.type === "conversation.opened");
    expect(opened).toHaveLength(1);
    await app.close();
  });
});

/** 前端（#85）契约对齐：GET 探测 + POST /conversation/turns 别名，保持与规范端点同一 SSE 形状 */
describe("dev/v2 群聊端点（issue #85/#89 契约对齐）", () => {
  it("GET /conversation 探测返回 200（前端据此判定 v2 可用，不再误退回 v1）", async () => {
    const { app, roomId } = await appWith();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/rooms/${roomId}/conversation`,
      headers: { "x-user-id": "u_owner" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, v2: true });
    await app.close();
  });

  it("GET /conversation/modes 返回引擎已加载的说话类型清单（只读，字段结构对）", async () => {
    const { app, roomId } = await appWith();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/rooms/${roomId}/conversation/modes`,
      headers: { "x-user-id": "u_owner" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; modes: { id: string; label: string; requiresTarget: boolean }[] };
    expect(body.ok).toBe(true);
    expect(body.modes.length).toBeGreaterThan(0);
    const broadcast = body.modes.find((m) => m.id === "broadcast");
    expect(broadcast).toMatchObject({ id: "broadcast", label: "公开说", requiresTarget: false });
    await app.close();
  });

  it("GET /conversation/modes 同样过 guardRoom——非本房账号 403", async () => {
    const { app, roomId } = await appWith();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/rooms/${roomId}/conversation/modes`,
      headers: { "x-user-id": "u_other" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("MAJOR-1：GET /conversation 探测同样过 guardRoom——非本房账号 403，不能探测房间存在", async () => {
    const { app, roomId } = await appWith();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/rooms/${roomId}/conversation`,
      headers: { "x-user-id": "u_other" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ ok: false, code: "E_FORBIDDEN" });
    await app.close();
  });

  it("POST /conversation/turns 别名接受 {actorId,input,clientTurnId}，推同样 SSE 且 speaker 绑定", async () => {
    const { app, roomId, actorId } = await appWith();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/conversation/turns`,
      headers: { "x-user-id": "u_owner" },
      payload: { actorId, input: "大家好", clientTurnId: "alias-1" },
    });
    expect(res.statusCode).toBe(200);
    const ev = sse(res.body).find((e) => e.type === "conversation.committed");
    expect(ev).toBeTruthy();
    const data = ev!.data as unknown as Extract<ConversationEvent, { type: "conversation.committed" }>;
    expect(data.state.room.id).toBe(roomId);
    await app.close();
  });

  it("别名端点带在场 targetNpcId 时仍能结算（addressed 模式，不因 target 校验失败）", async () => {
    const { app, roomId, actorId } = await appWith();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/conversation/turns`,
      headers: { "x-user-id": "u_owner" },
      payload: { actorId, input: "你好", clientTurnId: "alias-target-1", targetNpcId: "npc_lin" },
    });
    expect(res.statusCode).toBe(200);
    expect(sse(res.body).map((e) => e.type)).toContain("conversation.committed");
    await app.close();
  });

  it("别名端点越权 403 与规范端点一致", async () => {
    const { app, roomId, actorId } = await appWith();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/conversation/turns`,
      headers: { "x-user-id": "u_other" },
      payload: { actorId, input: "hi", clientTurnId: "alias-denied-1" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ ok: false, code: "E_FORBIDDEN" });
    await app.close();
  });
  it("行动文本里的目标展示名在喂给引擎前换回真名（截图 bug）", async () => {
    const { app, deps, roomId, actorId, llm } = await appWith();
    const npcId = "npc_yan";
    const cause = {
      v: 1 as const,
      id: "evt_seed_yan",
      roomId,
      seq: 1,
      ts: 1,
      actorId: "system",
      type: "room.bootstrap",
      payload: {},
    };
    // 房间自带 npc_yan（未认识）；只把它放进当前场景，确保 targetPresent。
    const seeded = await deps.arbiter.apply(roomId, [{ op: "scene.set", args: { presentIds: [actorId, npcId] } }], cause);
    expect(seeded.rejected).toEqual([]);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/conversation/turns`,
      headers: { "x-user-id": "u_owner" },
      payload: {
        actorId,
        clientTurnId: "name-1",
        targetNpcId: npcId,
        input: "对拿着文件夹、站姿笔直的中年人说：你叫什么",
      },
    });
    expect(res.statusCode).toBe(200);
    // NPC 提示词里应看到真名（模型才知道在跟谁说话），不应看到外貌占位名
    const prompt = (llm.requests.at(-1)?.messages ?? []).map((m) => m.content).join("\n");
    expect(prompt).toContain("严守一");
    expect(prompt).not.toContain("拿着文件夹、站姿笔直的中年人");
    await app.close();
  });

  it("canonical POST /conversation 同样把目标展示名换回真名（目标在场）", async () => {
    const { app, deps, roomId, actorId, llm } = await appWith();
    const npcId = "npc_yan";
    const seeded = await deps.arbiter.apply(
      roomId,
      [{ op: "scene.set", args: { presentIds: [actorId, npcId] } }],
      { v: 1, id: "evt_canon_present", roomId, seq: 1, ts: 1, actorId: "system", type: "room.bootstrap", payload: {} },
    );
    expect(seeded.rejected).toEqual([]);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/conversation`,
      headers: { "x-user-id": "u_owner" },
      payload: {
        actorId,
        clientTurnId: "canon-1",
        utterance: { mode: "addressed", target: npcId, content: "对拿着文件夹、站姿笔直的中年人说：你叫什么" },
      },
    });
    expect(res.statusCode).toBe(200);
    const prompt = (llm.requests.at(-1)?.messages ?? []).map((m) => m.content).join("\n");
    expect(prompt).toContain("严守一");
    expect(prompt).not.toContain("拿着文件夹、站姿笔直的中年人");
    await app.close();
  });

  it("目标不在场时 canonical 路径不做实名化（不会把真名塞进提示词）", async () => {
    const { app, deps, roomId, actorId, llm } = await appWith();
    const npcId = "npc_yan";
    const seeded = await deps.arbiter.apply(
      roomId,
      [{ op: "scene.set", args: { presentIds: [actorId] } }],
      { v: 1, id: "evt_canon_absent", roomId, seq: 1, ts: 1, actorId: "system", type: "room.bootstrap", payload: {} },
    );
    expect(seeded.rejected).toEqual([]);
    const before = llm.requests.length;

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/conversation`,
      headers: { "x-user-id": "u_owner" },
      payload: {
        actorId,
        clientTurnId: "canon-absent",
        utterance: { mode: "addressed", target: npcId, content: "对拿着文件夹、站姿笔直的中年人说：你叫什么" },
      },
    });
    expect(res.statusCode).toBe(200);
    const events = sse(res.body);
    expect(events.some((e) => e.type === "conversation.error")).toBe(true);
    // 引擎在 utterance 校验阶段就拒绝，NPC 提示词根本不会产生 → 真名无从泄漏
    expect(llm.requests.length).toBe(before);
    expect(JSON.stringify(events)).not.toContain("严守一");
    await app.close();
  });

  it("NPC 自报姓名先解锁再脱敏：同一回合不再把本人名字遮成外貌占位（截图 bug）", async () => {
    const npcId = "npc_yan";
    const { app, deps, roomId, actorId } = await appWithHost((rid, aid) => {
      const events: ConversationEvent[] = [
        {
          type: "conversation.utterance",
          delivery: { to: aid, speaker: npcId, utteranceId: "utt_unlock_1", mode: "addressed", channels: ["content"], content: "严守一，记一下" },
        },
        { type: "conversation.committed", sessionId: "conv_1", turn: 1, proposals: [], state: unknownNpcState(rid, aid, npcId) },
      ];
      return fakeConversationHost({ events }).host;
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/conversation`,
      headers: { "x-user-id": "u_owner" },
      payload: {
        actorId,
        clientTurnId: "unlock-1",
        utterance: { id: "utt_unlock_1", mode: "addressed", target: npcId, content: "我还不知道你叫什么呢" },
      },
    });
    expect(res.statusCode).toBe(200);
    // 解锁已落库（knows_name=true）……
    const after = await deps.store.snapshot(roomId);
    expect(after.entities[npcId]!.attrs.knows_name).toBe(true);
    // ……且发生在脱敏之前：同一回合的自报姓名不再被遮成"拿着文件夹…"这类外貌占位名
    expect(res.body).toContain("严守一");
    await app.close();
  });

  it("NPC 对别的 NPC 耳语自报姓名不算玩家认识（只统计玩家收到的 delivery）", async () => {
    const npcId = "npc_yan";
    const { app, deps, roomId, actorId } = await appWithHost((rid, aid) => {
      const events: ConversationEvent[] = [
        {
          type: "conversation.utterance",
          // to 是另一个 NPC：玩家只收到 coverAction，没听见内容
          delivery: { to: "npc_zhou", speaker: npcId, utteranceId: "utt_whisper_1", mode: "whisper", channels: ["content"], content: "我是严守一" },
        },
        { type: "conversation.committed", sessionId: "conv_1", turn: 1, proposals: [], state: unknownNpcState(rid, aid, npcId) },
      ];
      return fakeConversationHost({ events }).host;
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/conversation`,
      headers: { "x-user-id": "u_owner" },
      payload: { actorId, clientTurnId: "whisper-1", utterance: { id: "utt_w_1", mode: "broadcast", content: "嗯。" } },
    });
    expect(res.statusCode).toBe(200);
    const after = await deps.store.snapshot(roomId);
    expect(after.entities[npcId]!.attrs.knows_name ?? false).toBe(false);
    await app.close();
  });

  it("alias 路径（input + targetNpcId）问名字同样解锁", async () => {
    const npcId = "npc_yan";
    const { app, deps, roomId, actorId } = await appWithHost((rid, aid) => {
      const events: ConversationEvent[] = [
        {
          type: "conversation.utterance",
          delivery: { to: aid, speaker: npcId, utteranceId: "utt_alias_1", mode: "addressed", channels: ["content"], content: "严守一，记一下" },
        },
        { type: "conversation.committed", sessionId: "conv_1", turn: 1, proposals: [], state: unknownNpcState(rid, aid, npcId) },
      ];
      return fakeConversationHost({ events }).host;
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/conversation/turns`,
      headers: { "x-user-id": "u_owner" },
      payload: { actorId, clientTurnId: "alias-unlock-1", targetNpcId: npcId, input: "你叫什么" },
    });
    expect(res.statusCode).toBe(200);
    expect((await deps.store.snapshot(roomId)).entities[npcId]!.attrs.knows_name).toBe(true);
    await app.close();
  });
});

describe("审阅 #144：投递行把玩家显示成「玩家」而不是「你」", () => {
  const H = { "x-user-id": "u_owner" };
  it("NPC 对玩家定向说话：旁听 NPC 的提示词是「→ 玩家（你是旁听）」+ notice 也是「玩家」", async () => {
    let plr = "";
    const prompts: string[] = [];
    const { app, deps, roomId, actorId } = await appWith((req) => {
      const sys = String(req.messages?.[0]?.content ?? "");
      prompts.push(sys);
      if (!sys.includes("【这一轮】")) return JSON.stringify({ kind: "silent", reason: "init" });
      return JSON.stringify({
        kind: "speak",
        utterance: { mode: "addressed", target: plr, content: "只跟你说", action: "压低声音" },
      });
    });
    plr = actorId;
    const first = await app.inject({
      method: "POST", url: `/api/v1/rooms/${roomId}/conversation`, headers: H,
      payload: { actorId, clientTurnId: "pl-1", utterance: { id: "u-pl1", mode: "broadcast", content: "早" } },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST", url: `/api/v1/rooms/${roomId}/conversation`, headers: H,
      payload: { actorId, clientTurnId: "pl-2", utterance: { id: "u-pl2", mode: "broadcast", content: "然后呢" } },
    });
    expect(second.statusCode).toBe(200);
    const seen = prompts.filter((p) => p.includes("【更早的对话】"));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((p) => p.includes("→ 玩家（你是旁听"))).toBe(true);
    expect(seen.some((p) => p.includes("这句话是对 玩家 说的"))).toBe(true);
    expect(seen.some((p) => p.includes("→ 你（你是旁听"))).toBe(false);
    await app.close();
  });
});

describe("issue #130 引擎新行为的 HTTP 集成（#131/#136）", () => {
  const H = { "x-user-id": "u_owner" };
  const npcIdsOf = (deps: App, roomId: string): string[] => {
    const st = (deps.store as EventLog).state(roomId);
    return st.room.scene.presentIds.filter((id) => st.entities[id]?.kind === "npc");
  };

  it("#136 auto 轮：玩家沉默也能推进 NPC 决策，且回放里没有玩家台词", async () => {
    const { app, deps, roomId, actorId, llm } = await appWith(() => JSON.stringify({ kind: "speak", utterance: { mode: "broadcast", content: "我先说" } }));
    expect(npcIdsOf(deps, roomId).length).toBeGreaterThan(0);
    const callsBefore = llm.calls;
    const res = await app.inject({
      method: "POST", url: `/api/v1/rooms/${roomId}/conversation`, headers: H,
      payload: { actorId, clientTurnId: "auto-1", auto: true },
    });
    expect(res.statusCode).toBe(200);
    const events = sse(res.body);
    expect(events.some((e) => e.type === "conversation.committed")).toBe(true);
    expect(llm.calls).toBeGreaterThan(callsBefore);
    expect(events.some((e) => e.type === "conversation.utterance" && (e.data.delivery as { speaker: string }).speaker === actorId)).toBe(false);
    await app.close();
  });

  it("#136 interject + 同请求台词：台词不丢，phase listening → speaking", async () => {
    const { app, deps, roomId, actorId } = await appWith();
    const npc = npcIdsOf(deps, roomId)[0]!;
    const res = await app.inject({
      method: "POST", url: `/api/v1/rooms/${roomId}/conversation`, headers: H,
      payload: {
        actorId, clientTurnId: "int-1", interject: npc,
        utterance: { id: "u-int", mode: "broadcast", content: "等一下" },
      },
    });
    expect(res.statusCode).toBe(200);
    const events = sse(res.body);
    const contents = events.filter((e) => e.type === "conversation.utterance").map((e) => (e.data.delivery as { content?: string }).content);
    expect(contents).toContain("等一下");
    const phases = events.filter((e) => e.type === "conversation.phase").map((e) => e.data.phase);
    expect(phases).toContain("listening");
    expect(phases).toContain("speaking");
    await app.close();
  });

  it("审阅 P2：utterance.salience 被 schema 接受（docs/03 已登记，之前 .strict() 会 400）", async () => {
    const { app, deps, roomId, actorId } = await appWith();
    const res = await app.inject({
      method: "POST", url: `/api/v1/rooms/${roomId}/conversation`, headers: H,
      payload: { actorId, clientTurnId: "sal-1", utterance: { id: "u-sal", mode: "broadcast", content: "记一下", salience: 4 } },
    });
    expect(res.statusCode).toBe(200);
    // 端到端：salience 4 必须落成 memory.write.salience=80（不是只验证「不 400」）
    const envs = await (deps.store as EventLog).events(roomId, 0);
    const written = envs.filter((e) => e.type === "memory.written")
      .map((e) => e.payload as { content?: string; salience?: number })
      .filter((p) => (p.content ?? "").includes("记一下"));
    // docs/03 约定 salience 是 1–5 档（打分权重 salience/5），引擎内部归一后仍是 4
    expect(written.at(-1)?.salience).toBe(4);
    await app.close();
  });

  it("#131/#137 NPC prompt：在场者段、这一轮段、玩家文本被 <player_input> 包裹", async () => {
    const prompts: string[] = [];
    const { app, deps, roomId, actorId } = await appWith((req) => {
      prompts.push(String(req.messages?.[0]?.content ?? ""));
      return JSON.stringify({ kind: "silent", reason: "capture" });
    });
    expect(npcIdsOf(deps, roomId).length).toBeGreaterThan(0);
    const res = await app.inject({
      method: "POST", url: `/api/v1/rooms/${roomId}/conversation`, headers: H,
      payload: { actorId, clientTurnId: "p-131", utterance: { id: "u-131", mode: "broadcast", content: "大家早" } },
    });
    expect(res.statusCode).toBe(200);
    const npcPrompt = prompts.find((p) => p.includes("【在场者】"));
    expect(npcPrompt).toBeTruthy();
    expect(npcPrompt).toContain("【这一轮】");
    // #131 / 审阅 P1-a：在场者里玩家显示「玩家」，不能是实体名「你」
    expect(npcPrompt).toMatch(/plr_[a-z0-9_]+（玩家）/);
    expect(npcPrompt).not.toMatch(/plr_[a-z0-9_]+（你/);
    expect(npcPrompt).toContain('<player_input speaker="玩家">');
    expect(npcPrompt).toContain("大家早");
    await app.close();
  });
});

describe("审阅 #144 P1-b：插话后的当轮台词必须有 NPC 回应", () => {
  const H = { "x-user-id": "u_owner" };
  it("interject + utterance：phase 先回到 speaking，committed.outcomes 里有 speak", async () => {
    const { app, deps, roomId, actorId } = await appWith((req) => {
      const sys = String(req.messages?.[0]?.content ?? "");
      const me = /【你】\s*([a-z0-9_]+)/.exec(sys)?.[1] ?? "npc_x";
      return JSON.stringify({ kind: "speak", utterance: { id: `utt_${me}`, speaker: me, mode: "broadcast", content: "我接着说" } });
    });
    const st = (deps.store as EventLog).state(roomId);
    const npc = st.room.scene.presentIds.find((id) => st.entities[id]?.kind === "npc")!;
    const res = await app.inject({
      method: "POST", url: `/api/v1/rooms/${roomId}/conversation`, headers: H,
      payload: {
        actorId, clientTurnId: "int-2", interject: npc,
        utterance: { id: "u-int2", mode: "broadcast", content: "我插一句" },
      },
    });
    expect(res.statusCode).toBe(200);
    const events = sse(res.body);
    const committed = events.find((e) => e.type === "conversation.committed");
    const outcomes = (committed?.data.outcomes ?? []) as { kind: string; reason?: string }[];
    expect(outcomes.some((o) => o.kind === "speak")).toBe(true);
    expect(outcomes.every((o) => o.kind !== "silent" || o.reason !== "phase_or_cap")).toBe(true);
    await app.close();
  });
});
