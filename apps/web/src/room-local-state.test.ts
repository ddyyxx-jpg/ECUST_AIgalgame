import { describe, expect, it } from "vitest";
import { keepRoomLocalState, restoreRoomLocalState, shouldKeepRoomUi } from "./room-local-state.ts";

const BASE = {
  resumed: true,
  targetRoomId: "room_1",
  currentRoomId: "room_1",
  currentDraft: "不要重拉时丢我",
  currentConvMode: "v2" as const,
};

describe("keepRoomLocalState（进房时保留什么）", () => {
  it("同房间的前台恢复：保留草稿、已探测的 v2 模式与 v2 会话行", () => {
    expect(keepRoomLocalState({ ...BASE, currentConvLines: [{ id: 1, kind: "player", text: "已经说过的话" }] })).toEqual({
      draft: "不要重拉时丢我",
      convMode: "v2",
      convLines: [{ id: 1, kind: "player", text: "已经说过的话" }],
      preserved: true,
    });
  });

  it("resumed 但房间不同（换房）：清空草稿、模式回 v1", () => {
    expect(keepRoomLocalState({ ...BASE, targetRoomId: "room_2" })).toEqual({
      draft: "",
      convMode: "v1",
      convLines: null,
      preserved: false,
    });
  });

  it("普通进房/打开存档（非 resumed）：即使同房间也清空", () => {
    expect(keepRoomLocalState({ ...BASE, resumed: false })).toEqual({
      draft: "",
      convMode: "v1",
      convLines: null,
      preserved: false,
    });
  });

  it("未进房（currentRoomId 为 null/空串）：清空", () => {
    const cleared = { draft: "", convMode: "v1", convLines: null, preserved: false };
    expect(keepRoomLocalState({ ...BASE, currentRoomId: null })).toEqual(cleared);
    expect(keepRoomLocalState({ ...BASE, currentRoomId: "" })).toEqual(cleared);
  });

  it("v1 房间也按原模式保留（不凭空翻成 v2）", () => {
    expect(keepRoomLocalState({ ...BASE, currentConvMode: "v1" })).toEqual({
      draft: "不要重拉时丢我",
      convMode: "v1",
      convLines: null,
      preserved: true,
    });
  });
});

describe("shouldKeepRoomUi（v2 会话行是否跨恢复保留，P2-1）", () => {
  it("同一房间 resumed：保留已有 convLines", () => {
    expect(shouldKeepRoomUi({ resumed: true, targetRoomId: "room_1", currentRoomId: "room_1" })).toBe(true);
  });

  it("换房间 resumed：不保留（换房必须清）", () => {
    expect(shouldKeepRoomUi({ resumed: true, targetRoomId: "room_2", currentRoomId: "room_1" })).toBe(false);
  });

  it("非 resumed / 未进房：不保留", () => {
    expect(shouldKeepRoomUi({ resumed: false, targetRoomId: "room_1", currentRoomId: "room_1" })).toBe(false);
    expect(shouldKeepRoomUi({ resumed: true, targetRoomId: "room_1", currentRoomId: null })).toBe(false);
  });
});

describe("restoreRoomLocalState（reset 之后回填什么）", () => {
  it("保留且草稿非空、模式 v2：回填两者", () => {
    expect(restoreRoomLocalState({ draft: "不要重拉时丢我", convMode: "v2", convLines: [{ id: 7, kind: "npc", text: "NPC 台词" }], preserved: true })).toEqual({
      input: "不要重拉时丢我",
      convMode: "v2",
      convLines: [{ id: 7, kind: "npc", text: "NPC 台词" }],
    });
  });

  it("保留但草稿为空、模式 v1：不产生多余的 setState", () => {
    expect(restoreRoomLocalState({ draft: "", convMode: "v1", convLines: null, preserved: true })).toEqual({
      input: null,
      convMode: null,
      convLines: null,
    });
  });

  it("未保留：什么都不改（resetRoomUi 的默认值即最终值）", () => {
    expect(restoreRoomLocalState({ draft: "", convMode: "v1", convLines: null, preserved: false })).toEqual({
      input: null,
      convMode: null,
      convLines: null,
    });
  });
});
