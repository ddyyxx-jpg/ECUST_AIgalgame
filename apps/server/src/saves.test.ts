/**
 * issue #7：存档索引（SaveIndex）的纯单元测试——目录隔离、幂等、游标推进、删除语义。
 * HTTP 层的登记/更新/只读本人/删除在 turn-history.test.ts 与 resume.e2e.test.ts 覆盖。
 */
import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tempDir } from "@galgame/testkit";
import { SaveIndex } from "./saves.ts";
import type { SaveEntry } from "./saves.ts";

function entry(overrides: Partial<SaveEntry> = {}): SaveEntry {
  return {
    roomId: "room_a",
    scenarioId: "transfer",
    createdAt: 100,
    updatedAt: 100,
    lastTurnId: "",
    lastCommittedSeq: 0,
    formatVersion: 1,
    ...overrides,
  };
}

describe("SaveIndex", () => {
  it("upsert 幂等：同房间重复登记不新增条目，保留最早 createdAt", async () => {
    const index = new SaveIndex(tempDir("galgame-saves-unit-"), () => 500);
    await index.upsert("u_a", entry());
    await index.upsert("u_a", entry({ scenarioId: "scholarship", lastCommittedSeq: 12 }));
    const list = await index.list("u_a");
    expect(list).toHaveLength(1);
    expect(list[0]?.createdAt).toBe(100);
    expect(list[0]?.scenarioId).toBe("scholarship");
    expect(list[0]?.lastCommittedSeq).toBe(12);
  });

  it("touch 推进 lastTurnId/lastCommittedSeq；索引里没有的房间返回 false（历史照记）", async () => {
    const index = new SaveIndex(tempDir("galgame-saves-touch-"), () => 900);
    await index.upsert("u_a", entry());
    expect(await index.touch("u_a", "room_a", "t1", 5)).toBe(true);
    expect(await index.touch("u_a", "room_missing", "t1", 5)).toBe(false);
    const list = await index.list("u_a");
    expect(list[0]).toMatchObject({ lastTurnId: "t1", lastCommittedSeq: 5, updatedAt: 900 });
  });

  it("按 userId 隔离：u_b 看不到 u_a 的存档；remove 只删自己的", async () => {
    const index = new SaveIndex(tempDir("galgame-saves-iso-"));
    await index.upsert("u_a", entry());
    expect(await index.list("u_b")).toHaveLength(0);
    expect(await index.remove("u_b", "room_a")).toBe(false);
    expect(await index.remove("u_a", "room_a")).toBe(true);
    expect(await index.list("u_a")).toHaveLength(0);
  });

  it("列表按 updatedAt 降序；文件损坏时按空列表处理而不是抛错", async () => {
    const root = tempDir("galgame-saves-sort-");
    const index = new SaveIndex(root);
    await index.upsert("u_a", entry({ roomId: "room_old", updatedAt: 10 }));
    await index.upsert("u_a", entry({ roomId: "room_new", updatedAt: 20 }));
    expect((await index.list("u_a")).map((s) => s.roomId)).toEqual(["room_new", "room_old"]);

    // 直接弄坏 JSON：索引是可重建投影，读失败必须降级为空
    const anyIndex = index as unknown as { file(userId: string): string };
    await mkdir(path.dirname(anyIndex.file("u_bad")), { recursive: true });
    await writeFile(anyIndex.file("u_bad"), "{not json", "utf8");
    expect(await index.list("u_bad")).toEqual([]);
  });

  it("不同 userId 的可读前缀相同也不会写到同一文件（sha256 后缀去重）", async () => {
    const root = tempDir("galgame-saves-sha-");
    const index = new SaveIndex(root);
    await index.upsert("a/b", entry({ roomId: "room_slash" }));
    await index.upsert("a_b", entry({ roomId: "room_underscore" }));
    expect((await index.list("a/b")).map((s) => s.roomId)).toEqual(["room_slash"]);
    expect((await index.list("a_b")).map((s) => s.roomId)).toEqual(["room_underscore"]);
    const anyIndex = index as unknown as { file(userId: string): string };
    expect(anyIndex.file("a/b")).not.toBe(anyIndex.file("a_b"));
    expect(path.basename(anyIndex.file("a/b"))).toBe("saves.json");
  });
});
