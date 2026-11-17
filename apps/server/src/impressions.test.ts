/**
 * 世界印象落盘（P4）：入队去重、TTL 过期、投递后不再返回、跨实例一致。
 * 落盘是"用户投影"，坏了不能影响存档，所以读失败一律当空处理。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ImpressionNotice } from "../../../packages/shared/src/index.ts";
import { FileImpressions } from "./impressions.ts";

const ROOM = "room_imp";

function notice(over: Partial<ImpressionNotice> = {}): ImpressionNotice {
  return { id: "imp_1", memoryId: "mem_1", userId: "u_a", worldId: "w1", subjectText: "在校门口帮人捡起散落的书", createdAt: 1000, ...over };
}

describe("FileImpressions（用户投影）", () => {
  it("入队按 memoryId 去重；投递后不再返回；计数归零", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "galgame-imp-"));
    const store = new FileImpressions(dir, { ttlDays: 30, now: () => 1000 });
    await store.enqueue([notice()]);
    await store.enqueue([notice()]);
    expect((await store.pending("u_a", ROOM, 2)).map((n) => n.id)).toEqual(["imp_1"]);
    expect(await store.count("u_a")).toBe(1);
    await store.markDelivered([notice()]);
    expect(await store.pending("u_a", ROOM, 2)).toEqual([]);
    expect(await store.count("u_a")).toBe(0);
  });

  it("超过 TTL 的不再投递；新实例读到同一份文件（可重建）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "galgame-imp-"));
    const early = new FileImpressions(dir, { ttlDays: 30, now: () => 1000 });
    await early.enqueue([notice()]);
    const later = new FileImpressions(dir, { ttlDays: 30, now: () => 1000 + 31 * 24 * 3600 * 1000 });
    expect(await later.pending("u_a", ROOM, 2)).toEqual([]);
    const same = new FileImpressions(dir, { ttlDays: 30, now: () => 1000 });
    expect((await same.pending("u_a", ROOM, 2)).map((n) => n.id)).toEqual(["imp_1"]);
  });

  it("不同用户互不可见；非法 userId 不会穿越目录", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "galgame-imp-"));
    const store = new FileImpressions(dir, { ttlDays: 30, now: () => 1000 });
    await store.enqueue([notice(), notice({ id: "imp_2", memoryId: "mem_2", userId: "../../etc" })]);
    expect(await store.pending("u_a", ROOM, 5)).toHaveLength(1);
    expect(await store.pending("u_b", ROOM, 5)).toEqual([]);
    expect((await store.pending("../../etc", ROOM, 5)).map((n) => n.id)).toEqual(["imp_2"]);
  });
});
