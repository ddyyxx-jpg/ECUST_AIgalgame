/**
 * PR #123 打回项 P0-C / P1-1 的真实链路回归：
 * 同 dataDir 两次 createApp（模拟进程重启）+ app.inject 发真实 HTTP 到 /conversation。
 * 断言恢复的会话确实被路由层复用、同 clientTurnId 真重放、缓存丢失时 fail-closed。
 * 只断言 SSE 事件结构（事件类型 / sessionId / turn），不断言叙事文案（AGENTS §6/§12）。
 */
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { readFile, writeFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { tempDir } from "@galgame/testkit";
import { sessionSnapshotPath } from "../../../packages/engine/src/v2/conversation-snapshot.ts";
import { createApp, type App } from "./bootstrap.ts";
import { registerRoutes } from "./routes.ts";
import type { ServerConfig } from "./config.ts";

function testConfig(): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: tempDir("galgame-conv-restart-"),
    contentDir: "content",
    adminToken: "dev-admin",
    trustUserHeader: true,
    llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
    audit: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1000 },
  };
}

const prevScan = process.env.GALGAME_GOSSIP_SCAN_MS;
afterAll(() => {
  if (prevScan === undefined) delete process.env.GALGAME_GOSSIP_SCAN_MS;
  else process.env.GALGAME_GOSSIP_SCAN_MS = prevScan;
});

/** 每次 boot 都是全新的 createApp + 全新 Fastify：route-local sessions Map 必然为空 */
async function boot(cfg: ServerConfig): Promise<{ app: FastifyInstance; deps: App }> {
  process.env.GALGAME_GOSSIP_SCAN_MS = "0";
  const deps = await createApp(cfg);
  const app = Fastify();
  registerRoutes(app, deps);
  return { app, deps };
}

type SseEvent = { type: string; data: Record<string, unknown> };
function sse(body: string): SseEvent[] {
  return body.split("\n\n").filter(Boolean).flatMap((block) => {
    const type = /^event: (.+)$/m.exec(block)?.[1];
    const raw = /^data: (.+)$/m.exec(block)?.[1];
    return type && raw ? [{ type, data: JSON.parse(raw) as Record<string, unknown> }] : [];
  });
}
function committed(body: string): { sessionId: string; turn: number } {
  const ev = sse(body).find((e) => e.type === "conversation.committed");
  expect(ev, "expected conversation.committed").toBeDefined();
  return { sessionId: String(ev!.data.sessionId), turn: Number(ev!.data.turn) };
}
const payload = (actorId: string, clientTurnId: string, content: string) => ({
  actorId,
  clientTurnId,
  utterance: { id: `utt_${clientTurnId}`, mode: "broadcast", content },
});

describe("PR #123 P0-C：恢复的会话在路由层被复用（真实 HTTP）", () => {
  it("同 dataDir 两次 createApp：第二次请求复用同一 sessionId，不再 open 新会话", async () => {
    const cfg = testConfig();
    const { app: app1, deps: deps1 } = await boot(cfg);
    const { roomId, actorId } = await deps1.createRoom("solo", "u_owner");
    const H = { "x-user-id": "u_owner" };
    const url = `/api/v1/rooms/${roomId}/conversation`;

    const first = await app1.inject({ method: "POST", url, headers: H, payload: payload(actorId, "restart-c1", "第一回合") });
    expect(first.statusCode).toBe(200);
    const c1 = committed(first.body);
    expect(sse(first.body).some((e) => e.type === "conversation.opened")).toBe(true);

    // 模拟进程重启：同 dataDir、新 host、新 route-local sessions Map
    const { app: app2, deps: deps2 } = await boot(cfg);
    expect(deps2.conversation?.host.getByRoom(roomId)?.id).toBe(c1.sessionId);

    const second = await app2.inject({ method: "POST", url, headers: H, payload: payload(actorId, "restart-c2", "重启后继续") });
    expect(second.statusCode).toBe(200);
    expect(sse(second.body).some((e) => e.type === "conversation.opened")).toBe(false); // 没有新开 conv_2
    const c2 = committed(second.body);
    expect(c2.sessionId).toBe(c1.sessionId); // 复用恢复的 conv_1
    expect(c2.turn).toBe(c1.turn + 1); // 在原会话上推进回合

    // 并发两请求（串行锁内第二次仍应复用同一会话，且各自 turn 连续）
    const [p1, p2] = await Promise.all([
      app2.inject({ method: "POST", url, headers: H, payload: payload(actorId, "concurrent-a", "并发 A") }),
      app2.inject({ method: "POST", url, headers: H, payload: payload(actorId, "concurrent-b", "并发 B") }),
    ]);
    expect(p1.statusCode).toBe(200);
    expect(p2.statusCode).toBe(200);
    expect(sse(p1.body).some((e) => e.type === "conversation.opened")).toBe(false);
    expect(sse(p2.body).some((e) => e.type === "conversation.opened")).toBe(false);
    expect([committed(p1.body).sessionId, committed(p2.body).sessionId]).toEqual([c1.sessionId, c1.sessionId]);

    await app1.close();
    await app2.close();
  });
});

describe("PR #123 P1-1：重启后同 clientTurnId 的重放判定（真实 HTTP）", () => {
  it("幂等缓存随快照恢复：同 clientTurnId 原样重放，不生成新回合", async () => {
    const cfg = testConfig();
    const { app: app1, deps: deps1 } = await boot(cfg);
    const { roomId, actorId } = await deps1.createRoom("solo", "u_owner");
    const H = { "x-user-id": "u_owner" };
    const url = `/api/v1/rooms/${roomId}/conversation`;
    const body = payload(actorId, "replay-key", "只说一次");

    const first = await app1.inject({ method: "POST", url, headers: H, payload: body });
    expect(first.statusCode).toBe(200);
    const c1 = committed(first.body);

    const { app: app2, deps: deps2 } = await boot(cfg);
    expect(deps2.conversation?.host.hasCommittedByRoom(roomId, actorId, "replay-key")).toBe(true);

    const retry = await app2.inject({ method: "POST", url, headers: H, payload: body });
    expect(retry.statusCode).toBe(200);
    expect(committed(retry.body)).toEqual(c1); // turn 不变 = 真重放，没有新落库
    expect(sse(retry.body).some((e) => e.type === "conversation.opened")).toBe(false);
    // 账本条目仍是 committed（重放不重复计费，也不产生未计费新回合）
    expect(deps2.ledger.get({ userId: "u_owner", roomId, clientTurnId: "replay-key" })?.state).toBe("committed");

    await app1.close();
    await app2.close();
  });

  it("失败路径：快照丢失 seen 时，ledger 的 committed 不再被当成重放放行（409）", async () => {
    const cfg = testConfig();
    const { app: app1, deps: deps1 } = await boot(cfg);
    const { roomId, actorId } = await deps1.createRoom("solo", "u_owner");
    const H = { "x-user-id": "u_owner" };
    const url = `/api/v1/rooms/${roomId}/conversation`;
    const body = payload(actorId, "orphan-key", "提交后缓存丢失");
    const first = await app1.inject({ method: "POST", url, headers: H, payload: body });
    expect(first.statusCode).toBe(200);

    // 模拟旧版本快照 / 缓存丢失：抹掉 seen，但 ledger 里仍是 committed
    const file = sessionSnapshotPath(cfg.dataDir, roomId);
    const snap = JSON.parse(await readFile(file, "utf8")) as { seen?: unknown };
    expect(Array.isArray(snap.seen)).toBe(true); // 修复后快照确实带 seen
    delete snap.seen;
    await writeFile(file, JSON.stringify(snap), "utf8");

    const { app: app2, deps: deps2 } = await boot(cfg);
    expect(deps2.conversation?.host.hasCommittedByRoom(roomId, actorId, "orphan-key")).toBe(false);
    const retry = await app2.inject({ method: "POST", url, headers: H, payload: body });
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toMatchObject({ ok: false, code: "E_PRECONDITION" });

    await app1.close();
    await app2.close();
  });
});
