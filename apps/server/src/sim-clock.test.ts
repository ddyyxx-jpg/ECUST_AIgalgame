import { describe, expect, it } from "vitest";
import { SimClock, type SimClockMap, type SimClockStore } from "./sim-clock.ts";

function storeOf(ticks: Record<string, number>, rooms = Object.keys(ticks)): SimClockStore {
  return {
    listRooms: async () => rooms,
    snapshot: async (roomId) => ({ clock: { tick: ticks[roomId] ?? 0 } }),
  };
}

describe("SimClock（D22 自动推进）", () => {
  it("每个房间只推 ticks，不切 phase；到 maxTick 的房间跳过", async () => {
    const calls: { roomId: string; ticks: number }[] = [];
    const map: SimClockMap = { tick: async (roomId, opts) => { calls.push({ roomId, ticks: opts.ticks }); return { ok: true }; } };
    const clock = new SimClock({
      store: storeOf({ r1: 0, r2: 24 }),
      map,
      policy: { enabled: true, intervalMs: 60000, ticksPerBeat: 1, maxTick: 24 },
    });
    await clock.beat();
    expect(calls).toEqual([{ roomId: "r1", ticks: 1 }]);
  });

  it("拍长超过剩余刻度时只推到 maxTick，不越过上限", async () => {
    const calls: number[] = [];
    const clock = new SimClock({
      store: storeOf({ r1: 23 }),
      map: { tick: async (_roomId, opts) => { calls.push(opts.ticks); return { ok: true }; } },
      policy: { enabled: true, intervalMs: 60000, ticksPerBeat: 3, maxTick: 24 },
    });
    await clock.beat();
    expect(calls).toEqual([1]);
  });

  it("后台任务占用的房间跳过", async () => {
    const calls: string[] = [];
    const clock = new SimClock({
      store: storeOf({ r1: 0, r2: 0 }),
      map: { tick: async (roomId) => { calls.push(roomId); return { ok: true }; } },
      policy: { enabled: true, intervalMs: 60000, ticksPerBeat: 2, maxTick: 24 },
      isBusy: (roomId) => roomId === "r2",
    });
    await clock.beat();
    expect(calls).toEqual(["r1"]);
  });

  it("单飞：上一拍未结束时第二拍直接返回", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const clock = new SimClock({
      store: storeOf({ r1: 0 }),
      map: { tick: async () => { calls += 1; await gate; return { ok: true }; } },
      policy: { enabled: true, intervalMs: 60000, ticksPerBeat: 1, maxTick: 24 },
    });
    const first = clock.beat();
    await Promise.resolve();
    await Promise.resolve();
    const second = clock.beat();
    await second;
    expect(calls).toBe(1);
    release();
    await first;
  });

  it("超时只停止等待：底层未结束时后续拍跳过同一房间", async () => {
    let calls = 0;
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => { releaseFirst = r; });
    const clock = new SimClock({
      store: storeOf({ r1: 0 }),
      map: { tick: async () => { calls += 1; if (calls === 1) await gate; return { ok: true }; } },
      policy: { enabled: true, intervalMs: 60000, ticksPerBeat: 1, maxTick: 24 },
      roomTimeoutMs: 5,
      warn: () => {},
    });
    await clock.beat(); // 超时返回，底层仍在跑
    expect(calls).toBe(1);
    await clock.beat(); // 同房间仍在 in-flight，必须跳过
    expect(calls).toBe(1);
    releaseFirst();
    await gate;
    await new Promise((r) => setTimeout(r, 0));
    await clock.beat(); // 底层已结束，恢复推进
    expect(calls).toBe(2);
  });

  it("MapService 返回 ok:false 时 warn，并继续下一个房间", async () => {
    const calls: string[] = [];
    const warnings: string[] = [];
    const clock = new SimClock({
      store: storeOf({ r1: 0, r2: 0 }),
      map: {
        tick: async (roomId) => {
          calls.push(roomId);
          return roomId === "r1" ? { ok: false, code: "E_SEQ_GAP" } : { ok: true };
        },
      },
      policy: { enabled: true, intervalMs: 60000, ticksPerBeat: 1, maxTick: 24 },
      warn: (m) => warnings.push(m),
    });
    await clock.beat();
    expect(calls).toEqual(["r1", "r2"]);
    expect(warnings[0]).toContain("E_SEQ_GAP");
  });

  it("单个房间失败只 warn，不中断其他房间", async () => {
    const calls: string[] = [];
    const warnings: string[] = [];
    const clock = new SimClock({
      store: storeOf({ r1: 0, r2: 0 }),
      map: {
        tick: async (roomId) => {
          if (roomId === "r1") throw new Error("boom");
          calls.push(roomId);
          return { ok: true };
        },
      },
      policy: { enabled: true, intervalMs: 60000, ticksPerBeat: 1, maxTick: 24 },
      warn: (m) => warnings.push(m),
    });
    await clock.beat();
    expect(calls).toEqual(["r2"]); // 单房间失败只跳过本房间
    expect(warnings[0]).toContain("boom");
  });
});
