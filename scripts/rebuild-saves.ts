/**
 * 存档索引重建（issue #122）：只读扫描 data/rooms + data/history，重建 data/users 的
 * saves.json。停服后运行；不写 data/rooms、不过 Arbiter（索引是投影，不是世界状态）。
 *
 * 用法：
 *   npx tsx scripts/rebuild-saves.ts [--data-dir data] [--dry-run] [--json]
 * 也可以显式指定三个目录：--rooms / --history / --saves（覆盖 --data-dir 的对应项）。
 * 退出码：0 = 成功（坏档房间跳过并告警），2 = 参数错误。
 */
import path from "node:path";
import { loadConfig } from "../apps/server/src/config.ts";
import { rebuildSavesIndex } from "../apps/server/src/rebuild-saves.ts";
import { boolFlag, parseCliArgs } from "./cli-args.ts";

const USAGE = "用法: npx tsx scripts/rebuild-saves.ts [--data-dir data] [--rooms dir] [--history dir] [--saves dir] [--dry-run[=true|false]] [--json]";

let args: Map<string, string>;
let roomsDir: string;
let historyDir: string;
let savesDir: string;
let dryRun: boolean;
let jsonOut: boolean;
try {
  args = parseCliArgs(process.argv, ["data-dir", "rooms", "history", "saves", "dry-run", "json"]);
  const cfg = loadConfig();
  const dataDir = path.resolve(args.get("data-dir") ?? cfg.dataDir);
  roomsDir = path.resolve(args.get("rooms") ?? path.join(dataDir, "rooms"));
  historyDir = path.resolve(args.get("history") ?? path.join(dataDir, "history"));
  savesDir = path.resolve(args.get("saves") ?? path.join(dataDir, "users"));
  dryRun = boolFlag(args, "dry-run");
  jsonOut = boolFlag(args, "json");
} catch (e) {
  console.error(`[rebuild-saves] ${e instanceof Error ? e.message : String(e)}`);
  console.error(USAGE);
  process.exit(2);
}

const report = await rebuildSavesIndex({
  roomsDir,
  historyDir,
  savesDir,
  write: !dryRun,
});

const users = [...report.rebuilt.entries()].map(([userId, saves]) => ({ userId, count: saves.length }));
if (jsonOut) {
  console.log(JSON.stringify({
    roomsScanned: report.roomsScanned,
    roomsSkipped: report.roomsSkipped,
    written: report.written,
    backups: report.backups,
    users,
    dryRun,
  }, null, 2));
} else {
  console.log(`[rebuild-saves] 扫描房间 ${report.roomsScanned}，跳过 ${report.roomsSkipped}，重建账号 ${users.length}`);
  for (const u of users) console.log(`  ${u.userId}: ${u.count} 条`);
  if (dryRun) console.log("[rebuild-saves] 演练模式：未写盘（去掉 --dry-run 才会落盘）");
  else for (const f of report.written) console.log(`  已写入 ${f}`);
}
