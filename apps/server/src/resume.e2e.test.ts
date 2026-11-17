/**
 * issue #7 端到端：建房 → 回合 → 进程重启（同 dataDir 再 createApp）→
 * 历史与存档索引仍在，且恢复游标与事件日志一致。
 * 断言游标/结构，不断言叙事文案。
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@galgame/testkit";
import type { TurnEvent } from "../../../packages/shared/src/index.ts";
import { createApp } from "./bootstrap.ts";
import type { ServerConfig } from "./config.ts";

function testConfig(): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: tempDir("galgame-resume-e2e-"),
    contentDir: "content",
    adminToken: "dev-admin",
    trustUserHeader: true,
    llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
    audit: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1000 },
  };
}

async function collect(iterable: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

function committedSeq(events: TurnEvent[]): number {
  const last = events.at(-1);
  expect(last?.type).toBe("turn.commit");
  return last?.type === "turn.commit" ? last.seq : -1;
}

describe("会话恢复（issue #7，端到端）", () => {
  it("重启后历史与存档索引仍在，恢复游标等于最后提交 seq", async () => {
    const cfg = testConfig();

    // 第一次启动：建房 + 一个成功回合
    const app1 = await createApp(cfg);
    const { roomId } = await app1.createRoom("solo", "u_a");
    const seq1 = committedSeq(await collect(app1.turn.run({ roomId, actorId: "plr_self", input: "去图书馆", clientTurnId: "c1", userId: "u_a" })));
    // 建房登记发生在 createApp 之外（HTTP 路由层），这里模拟同一条 upsert
    await app1.saves.upsert("u_a", {
      roomId,
      scenarioId: "transfer",
      createdAt: 1,
      updatedAt: 1,
      lastTurnId: "",
      lastCommittedSeq: 0,
      formatVersion: 1,
    });
    await app1.saves.touch("u_a", roomId, "c1", seq1);

    const historyBefore = await app1.history.readAll(roomId);
    expect(historyBefore).toHaveLength(1);
    expect(historyBefore[0]?.committedSeq).toBe(seq1);
    expect(historyBefore[0]?.userId).toBe("u_a");

    // P1 回归：历史文件必须与事件日志物理隔离，否则 listRooms() 会把
    // "room_a.history" 当房间（且未来 append 该 id 会覆盖历史）。
    const listRooms = (app1.store as unknown as { listRooms: () => Promise<string[]> }).listRooms.bind(app1.store);
    expect(await listRooms()).toEqual([roomId]);
    const roomFiles = readdirSync(join(cfg.dataDir, "rooms")).filter((name) => name.endsWith(".jsonl"));
    expect(roomFiles).toHaveLength(1);
    expect(roomFiles.some((name) => name.includes(".history."))).toBe(false);
    expect(readdirSync(join(cfg.dataDir, "history")).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);

    // 第二次启动：同一 dataDir（模拟进程重启），不重新建房
    const app2 = await createApp(cfg);
    const historyAfter = await app2.history.readAll(roomId);
    expect(historyAfter).toHaveLength(1);
    expect(historyAfter[0]?.turnId).toBe(historyBefore[0]?.turnId);
    expect(historyAfter[0]?.committedSeq).toBe(seq1);

    const savesAfter = await app2.saves.list("u_a");
    expect(savesAfter).toHaveLength(1);
    expect(savesAfter[0]?.lastCommittedSeq).toBe(seq1);

    // 事件日志同源：恢复后的 world state 仍可读，且历史游标 = 事件日志最后 seq
    const snapshot = await app2.store.snapshot(roomId);
    expect(snapshot.room.members.some((member) => member.actorId === "plr_self")).toBe(true);
    const events = await app2.store.events(roomId, 0);
    expect(events.at(-1)?.seq).toBe(seq1);

    // 重启后继续玩：新回合的 seq 必须接在旧 seq 之后，历史追加而不是覆盖
    const seq2 = committedSeq(await collect(app2.turn.run({ roomId, actorId: "plr_self", input: "继续", clientTurnId: "c2" })));
    // 空回合（没有 proposal）也会 commit，但 seq 不前进；历史仍要追加、游标取 commit.seq
    expect(seq2).toBeGreaterThanOrEqual(seq1);
    const grown = await app2.history.readAll(roomId);
    expect(grown).toHaveLength(2);
    expect(grown[0]?.committedSeq).toBe(seq1);
    expect(grown[1]?.committedSeq).toBe(seq2);
    // 请求没带 userId 时也能从成员表解析（恢复后前端可能还没带上身份）
    expect(grown[1]?.userId).toBe("u_a");
  });

  it("失败的回合不推进历史与存档游标", async () => {
    const cfg = testConfig();
    const app1 = await createApp(cfg);
    const { roomId } = await app1.createRoom("solo", "u_a");
    const seq1 = committedSeq(await collect(app1.turn.run({ roomId, actorId: "plr_self", input: "你好", clientTurnId: "c1", userId: "u_a" })));
    await app1.saves.upsert("u_a", {
      roomId,
      scenarioId: "transfer",
      createdAt: 1,
      updatedAt: 1,
      lastTurnId: "c1",
      lastCommittedSeq: seq1,
      formatVersion: 1,
    });

    // 乐观并发失败：客户端拿着过期 seq 提交 → turn.rejected，不应产生历史/推进游标
    const failed = await collect(
      app1.turn.run({ roomId, actorId: "plr_self", input: "越权", clientTurnId: "c2", userId: "u_a", options: { expectedSeq: 9999 } }),
    );
    expect(failed.at(-1)?.type).toBe("turn.rejected");
    expect(await app1.history.readAll(roomId)).toHaveLength(1);

    const app2 = await createApp(cfg);
    const saves = await app2.saves.list("u_a");
    expect(saves[0]?.lastCommittedSeq).toBe(seq1);
  });
});
