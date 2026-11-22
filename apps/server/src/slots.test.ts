/**
 * issue #98：命名槽单元测试 + HTTP 端点（断言结构/错误码，不断言文案）。
 * 槽是 SaveIndex 的可选投影：旧 formatVersion:1 索引无 slots 也必须兼容。
 */
import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import Fastify from "fastify";
import { tempDir } from "@galgame/testkit";
import type { ServerConfig } from "./config.ts";
import { registerRoutes } from "./routes.ts";
import { createApp } from "./bootstrap.ts";
import { MAX_SLOTS, SaveIndex, saveFilePath } from "./saves.ts";
import type { SaveEntry } from "./saves.ts";

function entry(roomId: string): SaveEntry {
  return {
    roomId, scenarioId: "default", createdAt: 1, updatedAt: 1,
    lastTurnId: "", lastCommittedSeq: 0, actorId: "plr_a", formatVersion: 1,
  };
}

function testConfig(): ServerConfig {
  return {
    port: 0, host: "127.0.0.1", dataDir: tempDir("galgame-slots-test-"),
    contentDir: "content", adminToken: "dev-admin", trustUserHeader: true,
    llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
    audit: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1000 },
  };
}

describe("SaveIndex 命名槽 (#98)", () => {
  it("旧 formatVersion:1 索引无 slots：读写兼容且条目不丢", async () => {
    const root = tempDir("galgame-slots-legacy-");
    const index = new SaveIndex(root, () => 500);
    const file = saveFilePath(root, "u_a");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(saveFilePath(root, "u_a").replace(/\/saves\.json$/, ""), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, userId: "u_a", saves: [entry("room_a")] }), "utf8");
    expect(await index.listSlots("u_a")).toEqual([]);
    expect((await index.list("u_a")).map((s) => s.roomId)).toEqual(["room_a"]);
    const created = await index.putSlot("u_a", { slotId: "s1", label: "主存档", roomId: "room_a" });
    expect(created.ok).toBe(true);
    const doc = JSON.parse(await readFile(file, "utf8")) as { saves: unknown[]; slots: unknown[] };
    expect(doc.saves).toHaveLength(1);
    expect(doc.slots).toHaveLength(1);
  });

  it("槽上限、重复槽 id / 房间已绑、槽不存在、非本人房间各自拒绝", async () => {
    const index = new SaveIndex(tempDir("galgame-slots-limit-"), () => 500);
    for (let i = 0; i < 3; i++) await index.upsert("u_a", entry(`room_${i}`));
    expect((await index.putSlot("u_a", { slotId: "bad id!", label: "x", roomId: "room_0" })).ok).toBe(false);
    expect((await index.putSlot("u_a", { slotId: "s1", label: "x", roomId: "room_missing" })))
      .toMatchObject({ ok: false, code: "E_REF_NOT_FOUND" });
    expect((await index.putSlot("u_a", { slotId: "s1", label: "x", roomId: "room_0" })).ok).toBe(true);
    expect((await index.putSlot("u_a", { slotId: "s2", label: "y", roomId: "room_0" })))
      .toMatchObject({ ok: false, code: "E_ID_TAKEN" });
    // 改绑到已绑房间同样拒绝
    expect((await index.putSlot("u_a", { slotId: "s2", label: "y", roomId: "room_0" })).ok).toBe(false);
    for (let i = 1; i < MAX_SLOTS; i++) {
      await index.upsert("u_a", entry(`extra_${i}`));
      expect((await index.putSlot("u_a", { slotId: `s${i + 1}`, label: "x", roomId: `extra_${i}` })).ok).toBe(true);
    }
    await index.upsert("u_a", entry("overflow"));
    expect((await index.putSlot("u_a", { slotId: "overflow", label: "x", roomId: "overflow" })))
      .toMatchObject({ ok: false, code: "E_OVER_LIMIT" });
  });

  it("删槽只删映射：saves 条目仍在", async () => {
    const index = new SaveIndex(tempDir("galgame-slots-remove-"), () => 500);
    await index.upsert("u_a", entry("room_a"));
    await index.putSlot("u_a", { slotId: "s1", label: "x", roomId: "room_a" });
    expect(await index.deleteSlot("u_a", "s1")).toBe(true);
    expect(await index.listSlots("u_a")).toEqual([]);
    expect((await index.list("u_a")).map((s) => s.roomId)).toEqual(["room_a"]);
    expect(await index.deleteSlot("u_a", "s1")).toBe(false);
  });

  it("PR #123：remove() 删存档时同步清理该房间的悬空槽，别的房间槽保留", async () => {
    const root = tempDir("galgame-slots-remove-save-");
    const index = new SaveIndex(root, () => 500);
    await index.upsert("u_a", entry("room_a"));
    await index.upsert("u_a", entry("room_b"));
    await index.putSlot("u_a", { slotId: "s_a", label: "a", roomId: "room_a" });
    await index.putSlot("u_a", { slotId: "s_b", label: "b", roomId: "room_b" });
    expect(await index.remove("u_a", "room_a")).toBe(true);
    expect(await index.listSlots("u_a")).toMatchObject([{ slotId: "s_b", roomId: "room_b" }]);
    expect((await index.list("u_a")).map((s) => s.roomId)).toEqual(["room_b"]);
    const doc = JSON.parse(await readFile(saveFilePath(root, "u_a"), "utf8")) as { slots: { slotId: string }[] };
    expect(doc.slots.map((s) => s.slotId)).toEqual(["s_b"]);
    expect(await index.remove("u_a", "room_a")).toBe(false);
  });
});

describe("命名槽 HTTP 端点 (#98)", () => {
  it("GET/POST/PUT/DELETE 结构正确；删槽后房间事件/历史仍在", async () => {
    const cfg = testConfig();
    const app = await createApp(cfg);
    const wrapped = Fastify();
    registerRoutes(wrapped, { ...app, version: "test" });
    await wrapped.ready();
    const h = { "X-User-Id": "u_a" };
    const room = await wrapped.inject({ method: "POST", url: "/api/v1/rooms", headers: h,
      payload: { mode: "solo", scenarioId: "default" } });
    expect(room.statusCode).toBe(200);
    const roomId = (room.json() as { roomId: string }).roomId;

    const list0 = await wrapped.inject({ method: "GET", url: "/api/v1/me/saves/slots", headers: h });
    expect(list0.statusCode).toBe(200);
    expect(list0.json()).toMatchObject({ ok: true, userId: "u_a", slots: [] });

    const created = await wrapped.inject({ method: "POST", url: "/api/v1/me/saves/slots", headers: h,
      payload: { slotId: "s1", label: "白天线", roomId } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ ok: true, slot: { slotId: "s1", label: "白天线", roomId } });

    const updated = await wrapped.inject({ method: "PUT", url: "/api/v1/me/saves/slots/s1", headers: h,
      payload: { label: "夜晚线" } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ ok: true, slot: { slotId: "s1", label: "夜晚线" } });

    const withSlots = await wrapped.inject({ method: "GET", url: "/api/v1/me/saves", headers: h });
    expect(withSlots.json()).toMatchObject({ ok: true, slots: [{ slotId: "s1" }] });

    const removed = await wrapped.inject({ method: "DELETE", url: "/api/v1/me/saves/slots/s1", headers: h });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ ok: true, slotId: "s1", removed: true });
    const after = await wrapped.inject({ method: "GET", url: "/api/v1/me/saves/slots", headers: h });
    expect(after.json()).toMatchObject({ slots: [] });
    // 房间本身仍在：历史/事件不随槽删除
    const history = await wrapped.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/history`, headers: h });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({ ok: true, roomId, history: [] });
    await wrapped.close();
  });

  it("PR #123：POST 显式带已存在 slotId → 409 E_ID_TAKEN（更新走 PUT）", async () => {
    const cfg = testConfig();
    const app = await createApp(cfg);
    const wrapped = Fastify();
    registerRoutes(wrapped, { ...app, version: "test" });
    await wrapped.ready();
    const h = { "X-User-Id": "u_a" };
    const room = await wrapped.inject({ method: "POST", url: "/api/v1/rooms", headers: h,
      payload: { mode: "solo", scenarioId: "default" } });
    const roomId = (room.json() as { roomId: string }).roomId;
    const first = await wrapped.inject({ method: "POST", url: "/api/v1/me/saves/slots", headers: h,
      payload: { slotId: "s1", label: "白天线", roomId } });
    expect(first.statusCode).toBe(201);
    const duplicate = await wrapped.inject({ method: "POST", url: "/api/v1/me/saves/slots", headers: h,
      payload: { slotId: "s1", label: "改名", roomId } });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ ok: false, code: "E_ID_TAKEN" });
    const updated = await wrapped.inject({ method: "PUT", url: "/api/v1/me/saves/slots/s1", headers: h,
      payload: { label: "改名" } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ ok: true, slot: { slotId: "s1", label: "改名" } });
    await wrapped.close();
  });

  it("未带账号返回 400；未知槽 PUT 返回 404（闭集错误码）", async () => {
    const cfg = testConfig();
    const app = await createApp(cfg);
    const wrapped = Fastify();
    registerRoutes(wrapped, { ...app, version: "test" });
    await wrapped.ready();
    const noUser = await wrapped.inject({ method: "GET", url: "/api/v1/me/saves/slots" });
    expect(noUser.statusCode).toBe(400);
    expect(noUser.json()).toMatchObject({ ok: false, code: "E_SCHEMA_INVALID" });
    const missing = await wrapped.inject({ method: "PUT", url: "/api/v1/me/saves/slots/nope", headers: { "X-User-Id": "u_a" }, payload: { label: "x" } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ ok: false, code: "E_REF_NOT_FOUND" });
    await wrapped.close();
  });
});
