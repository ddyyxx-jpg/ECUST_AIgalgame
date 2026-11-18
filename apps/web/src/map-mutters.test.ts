import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nextBubbleState } from "./CampusMap.tsx";
import type { BubbleState, GalleryOutcome } from "./CampusMap.tsx";
import type { GalleryNpc } from "./api-gallery.ts";

const met = (id: string, mutter?: string): GalleryNpc => ({
  id,
  name: id,
  met: true,
  present: true,
  mutter,
  stats: [],
});

const stranger = (id: string, mutter?: string): GalleryNpc => ({
  id,
  name: id,
  met: false,
  present: true,
  mutter,
  stats: [],
});

const ok = (npcs: GalleryNpc[]): GalleryOutcome => ({ ok: true, npcs });
const fail: GalleryOutcome = { ok: false };
const EMPTY: BubbleState = { roomId: "", mutters: {} };

describe("nextBubbleState（地图图鉴气泡状态机）", () => {
  describe("图鉴拉取成功", () => {
    it("只收录 met 且带 mutter 的 NPC：未认识 / 无 mutter 不出气泡（不回归 #54）", () => {
      const next = nextBubbleState(
        EMPTY,
        "room-a",
        ok([met("npc_met", "走近点"), met("npc_silent"), stranger("npc_stranger", "不该出现")]),
      );
      expect(next).toEqual({ roomId: "room-a", mutters: { npc_met: "走近点" } });
    });

    it("同一房间 version 重拉成功：用新结果覆盖旧气泡", () => {
      const prev: BubbleState = { roomId: "room-a", mutters: { npc_old: "旧台词" } };
      const next = nextBubbleState(prev, "room-a", ok([met("npc_new", "新台词")]));
      expect(next).toEqual({ roomId: "room-a", mutters: { npc_new: "新台词" } });
    });
  });

  describe("换房间（roomId 变化）", () => {
    it("加载开始即清空上一房间气泡，不串房泄露", () => {
      const prev: BubbleState = { roomId: "room-a", mutters: { npc_a: "a 的台词" } };
      const next = nextBubbleState(prev, "room-b", null);
      expect(next).toEqual({ roomId: "room-b", mutters: {} });
    });

    it("换房间拉取失败：保持空表，不沿用旧房间气泡", () => {
      const prev: BubbleState = { roomId: "room-a", mutters: { npc_a: "a 的台词" } };
      const next = nextBubbleState(prev, "room-b", fail);
      expect(next).toEqual({ roomId: "room-b", mutters: {} });
    });
  });

  describe("同一房间 version 变化重拉", () => {
    it("加载开始保留上次成功值，避免闪烁（返回同一对象，不触发无谓重渲染）", () => {
      const prev: BubbleState = { roomId: "room-a", mutters: { npc_a: "上次台词" } };
      const next = nextBubbleState(prev, "room-a", null);
      expect(next).toBe(prev);
      expect(next.mutters).toEqual({ npc_a: "上次台词" });
    });

    it("拉取失败不清空：保留上次成功值", () => {
      const prev: BubbleState = { roomId: "room-a", mutters: { npc_a: "上次台词" } };
      const next = nextBubbleState(prev, "room-a", fail);
      expect(next).toBe(prev);
      expect(next.mutters).toEqual({ npc_a: "上次台词" });
    });
  });

  describe("局内解锁 NPC 的完整序列", () => {
    it("未认识→认识：version 变化触发同房间重拉后气泡出现，全程无需重挂载", () => {
      // 1. 初次进房：NPC 未认识，无气泡
      let state = nextBubbleState(EMPTY, "room-a", ok([stranger("npc_x", "服务端误下发")]));
      expect(state.mutters).toEqual({});

      // 2. 问名字解锁后，stateRev 变化 → effect 以同一房间重新拉取
      state = nextBubbleState(state, "room-a", null); // 加载开始：保留旧值（空表）
      expect(state.mutters).toEqual({});
      state = nextBubbleState(state, "room-a", ok([met("npc_x", "解锁后的台词")]));
      expect(state).toEqual({ roomId: "room-a", mutters: { npc_x: "解锁后的台词" } });
    });
  });
});

describe("CampusMap gallery effect 的依赖", () => {
  it("effect 依赖含 roomId 与 version：version 变化会重拉 gallery，无需重挂载", () => {
    // 组件行为依赖 effect 的依赖数组，纯函数单测覆盖不到；此断言锁定本次修复的核心机制。
    const file = fileURLToPath(new URL("./CampusMap.tsx", import.meta.url));
    const src = readFileSync(file, "utf8");
    const effect = src.match(/fetchGallery\(roomId\)[\s\S]*?\n\s*\}, \[([^\]]*)\]\)/);
    expect(effect).not.toBeNull();
    const deps = (effect as RegExpMatchArray)[1]!.split(",").map((d) => d.trim());
    expect(deps).toContain("roomId");
    expect(deps).toContain("version");
  });
});
