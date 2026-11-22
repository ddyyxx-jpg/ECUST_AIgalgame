/**
 * PR #123 返工：CLI 参数解析与导出目标防覆盖。
 * --dry-run=true 曾被静默当成未知参数导致真写盘；--out 曾可被指到 rooms/ 覆盖权威日志。
 * 测试只断言结构与错误类型/错误码语义，不断言文案。
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { FileStore } from "@galgame/engine";
import { tempDir } from "@galgame/testkit";
import {
  CliArgsError, parseCliArgs, boolFlag, requireArg, assertSafeArchiveOut,
} from "../../../scripts/cli-args.ts";

const KNOWN = ["room", "out", "json", "dry-run", "data-dir"] as const;

describe("parseCliArgs / boolFlag", () => {
  it("--key value、--flag、--flag=true/false 都被识别", () => {
    const args = parseCliArgs(
      ["node", "x", "--room", "r1", "--out", "o.json", "--json", "--dry-run=true", "--data-dir=false"],
      KNOWN,
    );
    expect(args.get("room")).toBe("r1");
    expect(args.get("out")).toBe("o.json");
    expect(boolFlag(args, "json")).toBe(true);
    expect(boolFlag(args, "dry-run")).toBe(true);
    expect(boolFlag(args, "data-dir")).toBe(false);
  });

  it("未提供的 flag 为 false；--dry-run=false 不会误判为真", () => {
    const args = parseCliArgs(["node", "x", "--dry-run=false"], KNOWN);
    expect(boolFlag(args, "dry-run")).toBe(false);
    expect(boolFlag(args, "json")).toBe(false);
  });

  it("未知参数与位置参数一律 CliArgsError（调用方 exit 2）", () => {
    expect(() => parseCliArgs(["node", "x", "--bogus"], KNOWN)).toThrow(CliArgsError);
    // 布尔取值由 boolFlag 统一 fail-closed（parseCliArgs 对值保持泛型）
    expect(() => boolFlag(parseCliArgs(["node", "x", "--dry-run=nope"], KNOWN), "dry-run")).toThrow(CliArgsError);
    const bad = new Map([["dry-run", "yes"]]);
    expect(() => boolFlag(bad, "dry-run")).toThrow(CliArgsError);
    expect(() => parseCliArgs(["node", "x", "positional"], KNOWN)).toThrow(CliArgsError);
  });

  it("requireArg 缺参数抛错而不是静默 undefined", () => {
    expect(() => requireArg(new Map(), "room")).toThrow(CliArgsError);
    expect(requireArg(new Map([["room", "r1"]]), "room")).toBe("r1");
  });
});

describe("assertSafeArchiveOut", () => {
  it("拒绝 out 落在 rooms/ 内（含 .. 与子路径）", () => {
    const dataDir = tempDir("galgame-cli-guard-");
    const inside = path.join(dataDir, "rooms", "room_a.jsonl");
    expect(() => assertSafeArchiveOut(dataDir, inside)).toThrow(CliArgsError);
    expect(() => assertSafeArchiveOut(dataDir, path.join(dataDir, "rooms", "sub", "x.json"))).toThrow(CliArgsError);
    expect(() => assertSafeArchiveOut(dataDir, path.join(dataDir, "rooms"))).toThrow(CliArgsError);
    expect(() => assertSafeArchiveOut(dataDir, path.join(dataDir, "users", "..", "rooms", "r.jsonl"))).toThrow(CliArgsError);
  });

  it("允许归档目录与同名前缀兄弟目录 / rooms2", () => {
    const dataDir = tempDir("galgame-cli-guard-");
    expect(() => assertSafeArchiveOut(dataDir, path.join(dataDir, "archives", "s.json"))).not.toThrow();
    expect(() => assertSafeArchiveOut(dataDir, path.join(dataDir, "rooms2", "s.json"))).not.toThrow();
    expect(() => assertSafeArchiveOut(dataDir, path.join(dataDir, "users", "u", "saves.json"))).not.toThrow();
  });

  it("真实 CLI：export-save --out 指向真实房间日志 → exit 2 且日志字节不变", async () => {
    const dataDir = tempDir("galgame-export-guard-");
    const store = new FileStore(path.join(dataDir, "rooms"));
    await store.append("room_a", [{
      v: 1, id: "evt_seed", roomId: "room_a", seq: 1, ts: 1000, actorId: "system",
      type: "entity.created", payload: { entity: { id: "e1" } },
    }]);
    const logPath = path.join(dataDir, "rooms", "room_a.jsonl");
    const before = await readFile(logPath, "utf8");
    const tsxBin = path.resolve("node_modules/.bin/tsx");
    const run = spawnSync(process.execPath, [tsxBin, "scripts/export-save.ts",
      "--data-dir", dataDir, "--room", "room_a", "--out", logPath], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(await readFile(logPath, "utf8")).toBe(before);
  });
});
