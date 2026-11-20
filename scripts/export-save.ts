/**
 * 导出房间存档为可移植归档（issue #99）：读权威事件日志 + 内存投影 → 一个 JSON 文件。
 * 只读 data/rooms，不写世界状态；--dry-run 只算 checksum 不落盘。
 *
 * 用法：npx tsx scripts/export-save.ts --room <roomId> [--data-dir data]
 *       [--out <file>] [--user <userId>] [--dry-run] [--json]
 * 退出码：0 = 成功，2 = 参数错误 / 房间不存在 / 导出失败。
 */
import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileStore } from "@galgame/engine";
import { loadConfig } from "../apps/server/src/config.ts";
import { SaveIndex } from "../apps/server/src/saves.ts";
import { buildArchive } from "../apps/server/src/save-archive.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") ? "" : (process.argv[++i] ?? ""));
}

const roomId = args.get("room");
if (!roomId) {
  console.error("用法: npx tsx scripts/export-save.ts --room <roomId> [--data-dir data] [--out <file>] [--user <userId>] [--dry-run] [--json]");
  process.exit(2);
}

const cfg = loadConfig();
const dataDir = path.resolve(args.get("data-dir") ?? cfg.dataDir);
const out = path.resolve(args.get("out") ?? path.join(dataDir, "archives", `${roomId}.json`));
const dryRun = args.has("dry-run");
const userId = args.get("user");

// #123 P1-F：--out 必须落在数据目录中的非权威区域；否则一条命令就能把事件日志/存档索引覆盖掉。
if (!dryRun) {
  const guarded = ["rooms", "history", "users"].map((d) => path.join(dataDir, d) + path.sep);
  if (guarded.some((dir) => out === dir.slice(0, -1) || out.startsWith(dir))) {
    console.error(`[export-save] 拒绝写入权威数据目录（rooms/history/users）：${out}`);
    process.exit(2);
  }
}

try {
  const store = new FileStore(path.join(dataDir, "rooms"));
  const seq = await store.load(roomId!);
  if (seq === 0) {
    console.error(`[export-save] 房间不存在或无事件：${roomId}`);
    process.exit(2);
  }
  const events = await store.events(roomId!, 1);
  const projection = await store.snapshot(roomId!);

  // 存档索引是投影，不是世界状态：带上它只为让导入端能恢复「我的存档」列表
  let saveIndex: { userId: string; saves: Awaited<ReturnType<SaveIndex["list"]>>; slots?: Awaited<ReturnType<SaveIndex["listSlots"]>> } | undefined;
  if (userId) {
    const index = new SaveIndex(path.join(dataDir, "users"));
    const saves = await index.list(userId);
    const slots = await index.listSlots(userId);
    saveIndex = { userId, saves, ...(slots.length > 0 ? { slots } : {}) };
  }

  const archive = buildArchive({ roomId: roomId!, events, projection, saveIndex });
  if (!dryRun) {
    await mkdir(path.dirname(out), { recursive: true });
    const tmp = `${out}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, JSON.stringify(archive), "utf8");
    await rename(tmp, out);
  }
  const summary = {
    roomId, seq: archive.seq, eventCount: archive.eventCount,
    schemaVersion: archive.schemaVersion, contractVersion: archive.contractVersion,
    checksum: archive.checksum, savedAt: archive.savedAt,
    saveIndexUser: userId ?? null, out, dryRun,
  };
  if (args.has("json")) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`[export-save] ${roomId}: ${archive.eventCount} 条事件，seq=${archive.seq}，${archive.checksum}`);
    console.log(`  schemaVersion=${archive.schemaVersion} contractVersion=${archive.contractVersion}`);
    if (dryRun) console.log("[export-save] 演练模式：未写盘（去掉 --dry-run 才会落盘）");
    else console.log(`  已写入 ${out}`);
  }
} catch (e) {
  console.error(`[export-save] 导出失败：${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
