import { describe, expect, it, vi } from "vitest";
import { createSessionResync } from "./session-wiring.ts";
import type { ResyncEventTarget, ResyncEventType, SessionResyncDeps } from "./session-wiring.ts";

type Handler = () => void;

/** 被测接线用到的「活状态」；各用例只改自己关心的字段 */
interface FakeLive {
  visible: boolean;
  online: boolean;
  screen: "title" | "game";
  roomId: string;
  busy: boolean;
  /** 输入框草稿：P2 后不再是决策输入，这里放一个值确认接线完全不读它 */
  draft: string;
}

interface HarnessOptions {
  /** 挂载时页面是否已经在后台（模拟后台标签页加载） */
  startHidden?: boolean;
  enterRoom?: (roomId: string, signal: AbortSignal) => Promise<void>;
}

/**
 * fake 事件源 + 假时钟：注册函数只把 handler 存进 Map，fire 时同步调用。
 * 这样测试覆盖的是「真实监听 → decideSessionSync → enterRoom/onNotice」整条链路，
 * 而不是直接把手搓的 trigger 喂给 handle。
 */
function harness(options: HarnessOptions = {}) {
  let now = 1_000_000;
  const handlers = new Map<string, Set<Handler>>();
  const key = (target: ResyncEventTarget, type: ResyncEventType) => `${target}:${type}`;
  const live: FakeLive = {
    visible: !options.startHidden,
    online: true,
    screen: "game",
    roomId: "room_1",
    busy: false,
    draft: "",
  };
  const enterRoom = vi.fn(options.enterRoom ?? (async (_roomId: string, _signal: AbortSignal) => {}));
  const onNotice = vi.fn((_error: unknown) => {});
  const resync = createSessionResync({
    now: () => now,
    on: (target, type, handler) => {
      const k = key(target, type);
      const set = handlers.get(k) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(k, set);
      return () => set.delete(handler);
    },
    isVisible: () => live.visible,
    isOnline: () => live.online,
    screen: () => live.screen,
    roomId: () => live.roomId,
    busy: () => live.busy,
    enterRoom,
    onNotice,
  });
  const fire = (target: ResyncEventTarget, type: ResyncEventType) => {
    for (const handler of [...(handlers.get(key(target, type)) ?? [])]) handler();
  };
  return {
    live,
    enterRoom,
    onNotice,
    resync,
    advance: (ms: number) => {
      now += ms;
    },
    hide: () => {
      live.visible = false;
      fire("document", "visibilitychange");
    },
    show: () => {
      live.visible = true;
      fire("document", "visibilitychange");
    },
    fireFocus: () => fire("window", "focus"),
    goOnline: () => fire("window", "online"),
    listenerCount: () => [...handlers.values()].reduce((n, set) => n + set.size, 0),
  };
}

/** 让 enterRoom 的 promise 链（catch/finally）跑完 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createSessionResync（前台恢复接线：真实监听 → 判定 → enterRoom）", () => {
  it("① 正常回前台恰好触发一次；visibilitychange 与 focus 成对触发不重复", async () => {
    const h = harness();
    expect(h.listenerCount()).toBe(3);
    h.hide();
    h.advance(10_000);
    h.show();
    h.fireFocus(); // 浏览器回到前台通常 visibilitychange 之后紧跟 focus
    await flush();
    expect(h.enterRoom).toHaveBeenCalledTimes(1);
    expect(h.enterRoom).toHaveBeenCalledWith("room_1", expect.any(AbortSignal));
    expect(h.onNotice).not.toHaveBeenCalled();
  });

  it("② 标题页 / 没有房间 / busy：不调用 enterRoom", async () => {
    const h = harness();
    h.live.screen = "title";
    h.hide();
    h.advance(10_000);
    h.show();
    await flush();
    expect(h.enterRoom).not.toHaveBeenCalled();

    h.live.screen = "game";
    h.live.roomId = "";
    h.hide();
    h.advance(10_000);
    h.show();
    await flush();
    expect(h.enterRoom).not.toHaveBeenCalled();

    h.live.roomId = "room_1";
    h.live.busy = true;
    h.hide();
    h.advance(10_000);
    h.show();
    await flush();
    expect(h.enterRoom).not.toHaveBeenCalled();
  });

  it("快速切回（<5s）不重拉：避免 alt-tab 抖动触发全量拉取", async () => {
    const h = harness();
    h.hide();
    h.advance(1_000);
    h.show();
    await flush();
    expect(h.enterRoom).not.toHaveBeenCalled();
  });

  it("busy 挡掉后，busy 结束的 focus 仍能用真实 awayMs 恢复（P2：隐藏起点不在 attempt 前清空）", async () => {
    const h = harness();
    h.hide();
    h.advance(10_000);
    h.live.busy = true;
    h.show(); // 被 busy 挡掉
    await flush();
    expect(h.enterRoom).not.toHaveBeenCalled();
    h.live.busy = false;
    h.fireFocus(); // 若 hiddenSince 被提前清空，这里 awayMs=0 会被 too-soon 永久挡死
    await flush();
    expect(h.enterRoom).toHaveBeenCalledTimes(1);
    expect(h.enterRoom).toHaveBeenCalledWith("room_1", expect.any(AbortSignal));
  });

  it("节流：距上次同步 <30s 不重拉，超过 30s 后可再次重拉", async () => {
    const h = harness();
    h.hide();
    h.advance(10_000);
    h.show();
    await flush();
    expect(h.enterRoom).toHaveBeenCalledTimes(1);

    h.hide();
    h.advance(10_000);
    h.show(); // 离开够久，但距上次同步只有 10s
    await flush();
    expect(h.enterRoom).toHaveBeenCalledTimes(1);

    h.advance(20_000);
    h.show(); // 距上次同步 30s
    await flush();
    expect(h.enterRoom).toHaveBeenCalledTimes(2);
  });

  it("③ enterRoom 失败：不抛、走 onNotice，失败也计一次同步；过 30s 后仍可重试", async () => {
    const boom = new Error("网络断了");
    const h = harness({
      enterRoom: async () => {
        throw boom;
      },
    });
    h.hide();
    h.advance(10_000);
    h.show();
    await flush();
    expect(h.onNotice).toHaveBeenCalledTimes(1);
    expect(h.onNotice).toHaveBeenCalledWith(boom);
    expect(h.enterRoom).toHaveBeenCalledTimes(1);

    // 失败也计一次同步：紧接着离开 10s 回来仍被 30s 节流挡住（不会反复打失败请求）
    h.hide();
    h.advance(10_000);
    h.show();
    await flush();
    expect(h.enterRoom).toHaveBeenCalledTimes(1);

    // 30s 之后可重试：失败没有把接线卡死（旧画面/可重试状态由 App 保留）
    h.advance(20_000);
    h.show();
    await flush();
    expect(h.enterRoom).toHaveBeenCalledTimes(2);
    expect(h.onNotice).toHaveBeenCalledTimes(2);
  });

  it("P2-5：deadline 超时时 enterRoom reject 到 onNotice，resyncing 占位归还可重试", async () => {
    const { TimeoutError } = await import("./timeout.ts");
    const boom = new TimeoutError("装载超时");
    const h = harness({
      enterRoom: async () => {
        throw boom;
      },
    });
    h.hide();
    h.advance(10_000);
    h.show();
    await flush();
    expect(h.onNotice).toHaveBeenCalledWith(boom);
    h.hide();
    h.advance(31_000);
    h.show();
    await flush();
    expect(h.enterRoom).toHaveBeenCalledTimes(2);
    expect(h.onNotice).toHaveBeenCalledTimes(2);
  });

  it("P2-5：dispose 中止在途 enterRoom 的 signal，onNotice 不再触发", async () => {
    let observed: AbortSignal | null = null;
    const h = harness({
      enterRoom: (_roomId, signal) => {
        observed = signal;
        return new Promise<void>(() => {});
      },
    });
    h.hide();
    h.advance(10_000);
    h.show();
    await flush();
    expect(observed).not.toBeNull();
    h.resync.dispose();
    expect(observed!.aborted).toBe(true);
    expect(observed!.reason).toBeInstanceOf(DOMException);
    await flush();
    expect(h.onNotice).not.toHaveBeenCalled();
  });

  it("防重入：enterRoom 在途时重复事件不再发起", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ enterRoom: () => pending });
    h.hide();
    h.advance(10_000);
    h.show();
    h.fireFocus();
    h.goOnline();
    await flush();
    expect(h.enterRoom).toHaveBeenCalledTimes(1);
    release();
    await flush();
  });

  it("online 触发绕过离开时长；仍需 30s 节流", async () => {
    const h = harness();
    h.goOnline();
    await flush();
    expect(h.enterRoom).toHaveBeenCalledTimes(1);

    h.advance(5_000);
    h.goOnline();
    await flush();
    expect(h.enterRoom).toHaveBeenCalledTimes(1);

    h.advance(25_000);
    h.goOnline();
    await flush();
    expect(h.enterRoom).toHaveBeenCalledTimes(2);
  });

  it("草稿不阻止恢复（P2）：接线不读输入框，草稿由 App 在 reset 后恢复", async () => {
    const h = harness();
    h.live.draft = "我还没发出去的话";
    h.hide();
    h.advance(10_000);
    h.show();
    await flush();
    expect(h.enterRoom).toHaveBeenCalledTimes(1);
  });

  it("页面在后台挂载：创建时把当前时刻当作隐藏起点，回到前台能恢复", async () => {
    const h = harness({ startHidden: true });
    h.advance(10_000);
    h.show();
    await flush();
    expect(h.enterRoom).toHaveBeenCalledTimes(1);
  });

  it("markSynced（正常进房成功回写）：6s 后回前台不触发，30s 后可触发", async () => {
    const h = harness();
    // 模拟 App 在 enterRoom 成功后调用 markSynced：此刻起算 30s 节流
    h.resync.markSynced();
    h.hide();
    h.advance(6_000);
    h.show(); // 离开 6s 够格，但距上次同步只有 6s
    await flush();
    expect(h.enterRoom).not.toHaveBeenCalled();

    h.advance(24_000); // 距 markSynced 恰好 30s；隐藏起点仍在，awayMs 也够
    h.show();
    await flush();
    expect(h.enterRoom).toHaveBeenCalledTimes(1);
  });

  it("dispose 后不再响应任何事件，且可重复调用", async () => {
    const h = harness();
    h.resync.dispose();
    h.resync.dispose();
    expect(h.listenerCount()).toBe(0);
    h.hide();
    h.advance(10_000);
    h.show();
    h.fireFocus();
    h.goOnline();
    await flush();
    expect(h.enterRoom).not.toHaveBeenCalled();
  });
});
