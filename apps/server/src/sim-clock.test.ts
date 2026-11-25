import { describe, expect, it } from "vitest";
import { SimClock, type SimClockMap, type SimClockStore } from "./sim-clock.ts";

function storeSnapshot(tick: number): never {
  return { clock: { tick } } as never;
}

function storeOf(ticks: Record<string, number>, rooms = Object.keys(ticks)): SimClockStore {
  return {
    listRooms: async () => rooms,
    snapshot: async (roomId) => ({ clock: { tick: ticks[roomId] ?? 0 } }),
  };
}

describe("SimClock（D22 自动推进）", () => {
  it("每个房间只推 ticks，不切 phase；到 maxTick 的房间跳过", async () => {
    const calls: { roomId: string; ticks: number }[] = [];
    const map: SimClockMap = { tick: async (roomId, opts) => { if (opts.ticks !== undefined) calls.push({ roomId, ticks: opts.ticks }); return { ok: true }; } };
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
      map: { tick: async (_roomId, opts) => { if (opts.ticks !== undefined) calls.push(opts.ticks); return { ok: true }; } },
      policy: { enabled: true, intervalMs: 60000, ticksPerBeat: 3, maxTick: 24 },
    });
    await clock.beat();
    expect(calls).toEqual([1]);
  });

  it("tick 用满 maxTick：默认停住；开 autoAdvancePhase 才自动换段", async () => {
    const advanced: boolean[] = [];
    const store = storeOf({ r1: 24 });
    const base = {
      store,
      map: { tick: async (_roomId: string, opts: { ticks?: number; advance?: boolean }) => { if (opts.advance) advanced.push(true); return { ok: true }; } },
      warn: () => undefined,
    };
    const frozen = new SimClock({ ...base, policy: { enabled: true, intervalMs: 60000, ticksPerBeat: 1, maxTick: 24 } });
    await frozen.beat();
    expect(advanced).toEqual([]);
    const auto = new SimClock({ ...base, policy: { enabled: true, intervalMs: 60000, ticksPerBeat: 1, maxTick: 24, autoAdvancePhase: true } });
    await auto.beat();
    expect(advanced).toEqual([true]);
  });

  it("beforeTick 永挂时本拍不卡死：超时后仍推进时间，下一拍还能跑", async () => {
    const warnings: string[] = [];
    const ticks: number[] = [];
    let hanging = true;
    const clock = new SimClock({
      store: storeOf({ r1: 0 }),
      map: { tick: async (_roomId, opts) => { if (opts.ticks !== undefined) ticks.push(opts.ticks); return { ok: true }; } },
      policy: { enabled: true, intervalMs: 60000, ticksPerBeat: 1, maxTick: 24 },
      roomTimeoutMs: 20,
      warn: (m) => warnings.push(m),
      beforeTick: async () => {
        if (hanging) await new Promise<void>(() => {});
      },
    });
    await clock.beat();
    expect(ticks).toEqual([1]);
    expect(warnings.some((w) => w.includes("决策超过 20ms"))).toBe(true);
    hanging = false;
    await clock.beat();
    expect(ticks).toEqual([1, 1]);
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

  it("acquire 拿不到房间锁：本拍不 snapshot、不 tick", async () => {
    let snapshots = 0;
    let ticks = 0;
    const clock = new SimClock({
      store: { listRooms: async () => ["r1"], snapshot: async () => { snapshots += 1; return storeSnapshot(0); } },
      map: { tick: async () => { ticks += 1; return { ok: true }; } },
      policy: { enabled: true, intervalMs: 60000, ticksPerBeat: 1, maxTick: 24 },
      acquire: () => null,
      warn: () => {},
    });
    await clock.beat();
    expect(snapshots).toBe(0);
    expect(ticks).toBe(0);
  });

  it("beforeTick 与 map.tick 在 acquire 锁内执行，结束后释放", async () => {
    let holds = 0;
    const clock = new SimClock({
      store: storeOf({ r1: 0 }),
      map: { tick: async () => { expect(holds).toBe(1); return { ok: true }; } },
      policy: { enabled: true, intervalMs: 60000, ticksPerBeat: 1, maxTick: 24 },
      acquire: () => { holds += 1; return () => { holds -= 1; }; },
      beforeTick: async () => { expect(holds).toBe(1); },
      warn: () => {},
    });
    await clock.beat();
    expect(holds).toBe(0);
  });

  it("beforeTick 在 tick 前执行；决策失败只 warn，不阻断本拍推进", async () => {
    const order: string[] = [];
    const clock = new SimClock({
      store: storeOf({ r1: 0, r2: 0 }),
      map: { tick: async (roomId) => { order.push(`tick:${roomId}`); return { ok: true }; } },
      policy: { enabled: true, intervalMs: 60000, ticksPerBeat: 1, maxTick: 24 },
      beforeTick: async (roomId) => {
        order.push(`decide:${roomId}`);
        if (roomId === "r2") throw new Error("model down");
      },
      warn: () => {},
    });
    await clock.beat();
    expect(order).toEqual(["decide:r1", "tick:r1", "decide:r2", "tick:r2"]);
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

  it("底层 tick 永挂时保持房间锁定，只告警不强行放锁", async () => {
    let holds = 0;
    const warnings: string[] = [];
    const clock = new SimClock({
      store: storeOf({ r1: 0 }),
      map: { tick: () => new Promise(() => {}) },
      policy: { enabled: true, intervalMs: 60000, ticksPerBeat: 1, maxTick: 24 },
      roomTimeoutMs: 5,
      acquire: () => { holds += 1; return () => { holds -= 1; }; },
      warn: (m) => warnings.push(m),
    });
    await clock.beat();
    expect(holds).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(holds).toBe(1);
    expect(warnings.join("\n")).toContain("保持房间锁定");
    expect(clock.stuckRooms()).toEqual([{ roomId: "r1", lockedMs: expect.any(Number) }]);
    // 卡死只计数一次、只告警一次；telemetry() 供 /health 之类的外部探针读取。
    expect(clock.telemetry().stuckTicks).toBe(1);
    const stuckWarns = warnings.filter((w) => w.includes("保持房间锁定"));
    expect(stuckWarns).toHaveLength(1);
    clock.stop();
    expect(clock.stuckRooms()).toEqual([]);
  });

  it("超时只停止等待：底层未结束时后续拍跳过同一房间，且锁不提前释放", async () => {
    let calls = 0;
    let holds = 0;
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => { releaseFirst = r; });
    const clock = new SimClock({
      store: storeOf({ r1: 0 }),
      map: { tick: async () => { calls += 1; if (calls === 1) await gate; return { ok: true }; } },
      policy: { enabled: true, intervalMs: 60000, ticksPerBeat: 1, maxTick: 24 },
      roomTimeoutMs: 5,
      acquire: () => { holds += 1; return () => { holds -= 1; }; },
      warn: () => {},
    });
    await clock.beat(); // 超时返回，底层仍在跑
    expect(calls).toBe(1);
    expect(holds).toBe(1); // 超时不能提前放锁
    await clock.beat(); // 同房间仍在 in-flight，必须跳过
    expect(calls).toBe(1);
    releaseFirst();
    await gate;
    await new Promise((r) => setTimeout(r, 0));
    expect(holds).toBe(0); // 底层 settle 后才释放
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
