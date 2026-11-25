import { describe, expect, it } from "vitest";
import type { WorldState } from "../../../packages/shared/src/contract/types.ts";
import { AmbientChat } from "./ambient-chat.ts";

function state(): WorldState {
  return {
    schemaVersion: 2,
    room: {
      id: "room_a", mode: "solo", worldId: "w",
      members: [{ actorId: "plr", role: "player", joinedSeq: 1 }],
      scene: { locId: "loc_canteen", presentIds: ["plr"] },
      createdAt: 1, lastActiveAt: 1,
    },
    entities: {
      loc_canteen: { id: "loc_canteen", kind: "loc", name: "食堂", attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 },
      npc_lin: { id: "npc_lin", kind: "npc", name: "林静", attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 },
      npc_ma: { id: "npc_ma", kind: "npc", name: "马骁", attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 },
      plr: { id: "plr", kind: "plr", name: "你", attrs: {}, tags: [], origin: "seed", canon: true, status: "active", createdAt: 0, updatedAt: 0 },
    },
    links: [
      { id: "l1", kind: "located_in", from: "npc_lin", to: "loc_canteen", createdAt: 0 },
      { id: "l2", kind: "located_in", from: "npc_ma", to: "loc_canteen", createdAt: 0 },
      { id: "l3", kind: "located_in", from: "plr", to: "loc_canteen", createdAt: 0 },
    ],
    clock: { day: 1, phase: "noon", tick: 3 },
    plots: [], moduleState: {},
  };
}

describe("AmbientChat（气泡闲聊）", () => {
  it("同地点 ≥2 个 NPC 时产 1~2 句气泡，说话人只能是名单里的人", async () => {
    let now = 1000;
    const chat = new AmbientChat(
      {
        store: { listRooms: async () => ["room_a"], snapshot: async () => state() },
        llm: {
          chat: async () => ({
            raw: '[{"speaker":"林静","line":"窗口队排到楼梯口了"},{"speaker":"路人","line":"不该收"}]',
            json: [{ speaker: "林静", line: "窗口队排到楼梯口了" }, { speaker: "路人", line: "不该收" }],
            usage: { promptTokens: 1, completionTokens: 1, calls: 1 },
            model: "fake",
            latencyMs: 1,
          }),
        },
        now: () => now,
      },
      { enabled: true, intervalMs: 30_000, ttlMs: 10_000, maxBubbles: 3 },
    );
    await chat.beat();
    const lines = chat.recent("room_a");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ speakerId: "npc_lin", speaker: "林静", locId: "loc_canteen", text: "窗口队排到楼梯口了" });
    now = 20_000;
    expect(chat.recent("room_a")).toEqual([]);
  });

  it("模型只返回单个对象（不是数组）时也接受", async () => {
    const chat = new AmbientChat(
      {
        store: { listRooms: async () => ["room_a"], snapshot: async () => state() },
        llm: {
          chat: async () => ({
            raw: '{"speaker":"马骁","line":"这队排得也太长了。"}',
            usage: { promptTokens: 1, completionTokens: 1, calls: 1 },
            model: "fake",
            latencyMs: 1,
          }),
        },
        now: () => 5,
      },
      { enabled: true, intervalMs: 30_000, ttlMs: 10_000 },
    );
    await chat.beat();
    expect(chat.recent("room_a").map((l) => l.speakerId)).toEqual(["npc_ma"]);
  });

  it("同地点不足 2 人时不调模型", async () => {
    let calls = 0;
    const only = state();
    const oneNpc = { ...only, links: only.links.filter((l) => l.from !== "npc_ma") } as WorldState;
    const chat = new AmbientChat(
      {
        store: { listRooms: async () => ["room_a"], snapshot: async () => oneNpc },
        llm: { chat: async () => { calls += 1; return { raw: "[]", usage: { promptTokens: 0, completionTokens: 0, calls: 1 }, model: "fake", latencyMs: 1 }; } },
        now: () => 1,
      },
      { enabled: true, intervalMs: 30_000, ttlMs: 10_000 },
    );
    await chat.beat();
    expect(calls).toBe(0);
    expect(chat.recent("room_a")).toEqual([]);
  });

  it("正在跑回合的房间本拍跳过（不和玩家抢 LLM，也不读半截状态）", async () => {
    let calls = 0;
    const chat = new AmbientChat(
      {
        store: { listRooms: async () => ["room_a"], snapshot: async () => state() },
        llm: { chat: async () => { calls += 1; return { raw: "[]", usage: { promptTokens: 0, completionTokens: 0, calls: 1 }, model: "fake", latencyMs: 1 }; } },
        isBusy: () => true,
        now: () => 1,
      },
      { enabled: true, intervalMs: 30_000, ttlMs: 10_000 },
    );
    await chat.beat();
    expect(calls).toBe(0);
  });

  it("玩家所在地点不足 2 人时不去别处凑数（别处气泡玩家看不到，还会泄漏别处动静）", async () => {
    let calls = 0;
    const alone = state();
    alone.room.scene.locId = "loc_library";
    const withLib = {
      ...alone,
      entities: { ...alone.entities, loc_library: { ...alone.entities.loc_canteen!, id: "loc_library", name: "图书馆" } },
      links: [...alone.links, { id: "l4", kind: "located_in", from: "plr", to: "loc_library" }],
    } as WorldState;
    const chat = new AmbientChat(
      {
        store: { listRooms: async () => ["room_a"], snapshot: async () => withLib },
        llm: { chat: async () => { calls += 1; return { raw: "[]", usage: { promptTokens: 0, completionTokens: 0, calls: 1 }, model: "fake", latencyMs: 1 }; } },
        now: () => 1,
      },
      { enabled: true, intervalMs: 30_000, ttlMs: 10_000 },
    );
    await chat.beat();
    expect(calls).toBe(0);
  });

  it("recent 按地点过滤：别处产生的气泡不返回", async () => {
    const chat = new AmbientChat(
      {
        store: { listRooms: async () => ["room_a"], snapshot: async () => state() },
        llm: {
          chat: async () => ({
            raw: '[{"speaker":"林静","line":"食堂这边人挺多"}]',
            json: [{ speaker: "林静", line: "食堂这边人挺多" }],
            usage: { promptTokens: 1, completionTokens: 1, calls: 1 },
            model: "fake",
            latencyMs: 1,
          }),
        },
        now: () => 100,
      },
      { enabled: true, intervalMs: 30_000, ttlMs: 10_000 },
    );
    await chat.beat();
    expect(chat.recent("room_a", "loc_canteen")).toHaveLength(1);
    expect(chat.recent("room_a", "loc_library")).toHaveLength(0);
  });

  it("审核 blocked 的那条直接丢，其余照发", async () => {
    const chat = new AmbientChat(
      {
        store: { listRooms: async () => ["room_a"], snapshot: async () => state() },
        llm: {
          chat: async () => ({
            raw: '[{"speaker":"林静","line":"这句不该出现"},{"speaker":"马骁","line":"这句可以"}]',
            json: [{ speaker: "林静", line: "这句不该出现" }, { speaker: "马骁", line: "这句可以" }],
            usage: { promptTokens: 1, completionTokens: 1, calls: 1 },
            model: "fake",
            latencyMs: 1,
          }),
        },
        review: async ({ text }) => (text.includes("不该") ? "blocked" : "ok"),
        now: () => 10,
      },
      { enabled: true, intervalMs: 30_000, ttlMs: 10_000 },
    );
    await chat.beat();
    expect(chat.recent("room_a").map((l) => l.text)).toEqual(["这句可以"]);
  });

  it("审核 unavailable 时整轮不发布（fail-closed）", async () => {
    const chat = new AmbientChat(
      {
        store: { listRooms: async () => ["room_a"], snapshot: async () => state() },
        llm: {
          chat: async () => ({
            raw: '[{"speaker":"林静","line":"随便说说"}]',
            json: [{ speaker: "林静", line: "随便说说" }],
            usage: { promptTokens: 1, completionTokens: 1, calls: 1 },
            model: "fake",
            latencyMs: 1,
          }),
        },
        review: async () => "unavailable",
        now: () => 10,
      },
      { enabled: true, intervalMs: 30_000, ttlMs: 10_000 },
    );
    await chat.beat();
    expect(chat.recent("room_a")).toEqual([]);
  });
});
