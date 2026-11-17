/**
 * 世界印象端到端（P1-A 复审项）：**回合写记忆 → canonize → impressions.json → 下回合 facts**。
 *
 * 这条链之前是死的：`attachAboutUserIds` 全仓无调用 → 回合记忆的 aboutUserIds 恒空 →
 * canonize 的候选恒空 → `onImpression` 条件恒假 → 「世界记住你」永远不会出现。
 * 这里全程走真实实现（DefaultTurn + CanonizeJob + FileImpressions），只把模型换成 MockLlm。
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Entity, Envelope, TurnEvent } from "../../../packages/shared/src/index.ts";
import { tempDir } from "../../../packages/testkit/src/index.ts";
import { MockLlm } from "../../../packages/llm/src/mock.ts";
import { DefaultArbiter } from "../../../packages/engine/src/arbiter.ts";
import { EventSourcedStore } from "../../../packages/engine/src/store.ts";
import { emptyRegistry } from "../../../packages/engine/src/registry.ts";
import { DefaultTurn } from "../../../packages/engine/src/turn.ts";
import { ModuleHost } from "../../../packages/engine/src/modules.ts";
import { EventSourcedMemory, worldRoomId } from "../../../packages/engine/src/memory.ts";
import { CanonizeJob } from "../../../packages/engine/src/canonize.ts";
import { FileImpressions } from "./impressions.ts";

const ROOM = "room_imp";
const WORLD = "w1";
const WORLD_ROOM = worldRoomId(WORLD);
const PLR = "plr_self";
const LIN = "npc_lin";
const MA = "npc_ma";
const GATE = "loc_gate";
const STUDENT = "user_alpha";

function entity(id: string, kind: string, name: string): Entity {
  return { id, kind: kind as Entity["kind"], name, attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 };
}

async function collect(it: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe("世界印象端到端（回合 → canonize → 用户投影）", () => {
  it("回合里写下的公开记忆被 canonize 提成世界层，下一回合以【世界印象】告知玩家", async () => {
    const dir = tempDir("galgame-impressions-e2e-");
    const store = new EventSourcedStore({ worldId: WORLD, locId: GATE });
    store.append(ROOM, [
      {
        v: 1,
        id: "evt_1",
        roomId: ROOM,
        seq: 1,
        ts: 1,
        actorId: "system",
        type: "entity.created",
        payload: { entity: entity(GATE, "loc", "校门") },
      },
      { v: 1, id: "evt_2", roomId: ROOM, seq: 2, ts: 2, actorId: "system", type: "entity.created", payload: { entity: entity(PLR, "plr", "我") } },
      { v: 1, id: "evt_3", roomId: ROOM, seq: 3, ts: 3, actorId: "system", type: "entity.created", payload: { entity: entity(LIN, "npc", "林月") } },
      { v: 1, id: "evt_4", roomId: ROOM, seq: 4, ts: 4, actorId: "system", type: "entity.created", payload: { entity: entity(MA, "npc", "马骁") } },
      { v: 1, id: "evt_5", roomId: ROOM, seq: 5, ts: 5, actorId: "system", type: "scene.changed", payload: { locId: GATE, presentIds: [PLR, LIN] } },
      // 成员表：userId 是 aboutUserIds 的唯一来源（回合里由 room.member.joined 写入）
      {
        v: 1,
        id: "evt_6",
        roomId: ROOM,
        seq: 6,
        ts: 6,
        actorId: "system",
        type: "room.member.joined",
        payload: { member: { actorId: PLR, role: "player", joinedSeq: 6, online: true, userId: STUDENT } },
      },
    ]);

    const memory = new EventSourcedMemory();
    const arbiter = new DefaultArbiter({ store, registry: emptyRegistry(), memories: memory });
    const modules = new ModuleHost({ dir: "/tmp/galgame-no-modules" });
    await modules.load();

    const clock = 1_700_000_000_000;
    const impressions = new FileImpressions(path.join(dir, "users"), { ttlDays: 30, now: () => clock });
    const fact = "林月在图书馆帮新生找回了丢掉的校园卡";
    // 两个不同的在场 NPC 各记一次同一件事：canonize 的"≥2 见证者"才可能成立
    const llm = new MockLlm({
      responses: [
        JSON.stringify({
          narrative: "林月把校园卡递回去。",
          proposals: [{ op: "scene.set", args: { locId: GATE, presentIds: [PLR, LIN] }, reason: "在场", by: "llm" }],
          memory: [{ content: fact, tags: ["图书馆", "帮忙"], salience: 5, about: [PLR], visibility: "public", tier: "long" }],
        }),
        JSON.stringify({
          narrative: "马骁在旁边看着。",
          proposals: [],
          memory: [{ content: fact, tags: ["图书馆", "帮忙"], salience: 5, about: [PLR], visibility: "public", tier: "long" }],
        }),
        JSON.stringify({ narrative: "第二天，走廊里的人看你的眼神有点不一样。", proposals: [] }),
      ],
    });
    const turn = new DefaultTurn({ store, arbiter, registry: emptyRegistry(), modules, llm, memory, impressions });

    await collect(turn.run({ roomId: ROOM, actorId: PLR, input: "谢谢林月", clientTurnId: "c1", userId: STUDENT }));

    // 换场景到马骁在场：owner 的选择只看"当前在场的唯一 NPC"，所以换人得先换场景
    const seqNow = await store.load(ROOM);
    const cause: Envelope = {
      v: 1,
      id: "evt_test_scene",
      roomId: ROOM,
      seq: seqNow,
      ts: 9,
      actorId: "system",
      type: "test.scene",
      payload: {},
    };
    const moved = await arbiter.apply(
      ROOM,
      [{ op: "scene.set", args: { locId: GATE, presentIds: [PLR, MA] }, reason: "换人", by: "test" }],
      cause,
      { expectedSeq: seqNow },
    );
    expect(moved.ok, JSON.stringify(moved.error ?? moved.rejected)).toBe(true);
    await collect(turn.run({ roomId: ROOM, actorId: PLR, input: "跟马骁说起这事", clientTurnId: "c2", userId: STUDENT }));

    // 两个 owner 各有一条带 aboutUserIds 的公开记忆（attachAboutUserIds 在 turn.ts 里接线）
    const wrote = memory.all(ROOM).filter((r) => r.content === fact);
    expect(new Set(wrote.map((r) => r.ownerId)).size).toBeGreaterThanOrEqual(2);
    expect(wrote.every((r) => (r.aboutUserIds ?? []).includes(STUDENT))).toBe(true);

    // canonize：真实 FileImpressions 落盘（用户投影 data/users/<hash>/impressions.json）
    const canonize = new CanonizeJob({
      store,
      arbiter,
      worldRoom: WORLD_ROOM,
      worldId: WORLD,
      memory,
      judge: { review: async () => ({ allow: true }) },
      limits: { enabled: true, dailyCap: 200, minWitness: 2, perSourceCap: 2 },
      onImpression: async (notice) => impressions.enqueue([notice]),
      now: () => clock,
    });
    const report = await canonize.retireRoom(ROOM);
    expect(report.written.length).toBeGreaterThanOrEqual(1);

    const pending = await impressions.pending(STUDENT, ROOM, 5);
    expect(pending.length).toBe(1);
    expect(pending[0]?.subjectText).toBeTruthy();

    // 下一回合：facts 里出现【世界印象】，且投递后标记已读
    const events = await collect(turn.run({ roomId: ROOM, actorId: PLR, input: "去上课", clientTurnId: "c3", userId: STUDENT }));
    const facts = events.filter((e) => e.type === "turn.facts").flatMap((e) => (e.type === "turn.facts" ? e.facts : []));
    expect(facts.some((f) => f.includes("【世界印象】"))).toBe(true);
    expect(await impressions.pending(STUDENT, ROOM, 5)).toHaveLength(0);

    // 落盘文件真的存在（不是只活在内存里）
    const { readdir } = await import("node:fs/promises");
    const userDirs = await readdir(path.join(dir, "users"));
    expect(userDirs).toHaveLength(1);
  });
});
