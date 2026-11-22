/** issue #98 Web 侧：槽 API 的响应拆包（断言结构，不断言文案）。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlot, deleteSlot, fetchSaves, fetchSlots, updateSlot } from "./api.ts";

afterEach(() => vi.unstubAllGlobals());

const slot = { slotId: "s1", label: "白天线", roomId: "room_a", createdAt: 1, updatedAt: 2 };

describe("命名槽 HTTP 层 (#98)", () => {
  it("fetchSaves 解析 slots；旧服务端无 slots 时降级为空数组", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, saves: [], slots: [slot] }))));
    expect((await fetchSaves()).slots).toEqual([slot]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, saves: [] }))));
    expect((await fetchSaves()).slots).toEqual([]);
  });

  it("fetchSlots 解析槽列表；失败状态抛错", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, slots: [slot] }))));
    expect((await fetchSlots())[0]?.slotId).toBe("s1");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, code: "E_SCHEMA_INVALID" }), { status: 400 })));
    await expect(fetchSlots()).rejects.toMatchObject({ status: 400 });
  });

  it("createSlot / updateSlot / deleteSlot 发送正确方法并解析结构", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"}`);
      return new Response(JSON.stringify(init?.method === "DELETE" ? { ok: true, removed: true } : { ok: true, slot }));
    }));
    expect((await createSlot("白天线", "room_a", "s1")).slotId).toBe("s1");
    expect((await updateSlot("s1", { label: "夜晚线" })).slotId).toBe("s1");
    expect(await deleteSlot("s1")).toBe(true);
    expect(calls).toEqual(["POST", "PUT", "DELETE"]);
  });
});
