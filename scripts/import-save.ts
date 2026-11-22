/**
 * 导入存档归档（issue #99）：zod + checksum + replay + 投影比对全部通过后才落库。
 * 落库只经 FileStore.append（DefaultArbiter.apply 的同一写入通道）；坏档绝不写 data/rooms。
 *
 * 用法：npx tsx scripts/import-save.ts --file <archive.json> [--data-dir data] [--dry-run] [--json]
 * 退出码：0 = 成功，2 = 参数错误 / 坏档 / 版本不符 / checksum 不符 / 冲突。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { FileStore } from "@galgame/engine";
import { loadConfig } from "../apps/server/src/config.ts";
import { SaveIndex } from "../apps/server/src/saves.ts";
import { importArchive, inspectArchive, planImport } from "../apps/server/src/save-archive.ts";
import { boolFlag, parseCliArgs, requireArg } from "./cli-args.ts";

const USAGE = "用法: npx tsx scripts/import-save.ts --file <archive.json> [--data-dir data] [--dry-run[=true|false]] [--json]";

let args: Map<string, string>;
let file: string;
let dataDir: string;
let dryRun: boolean;
let jsonOut: boolean;
try {
  args = parseCliArgs(process.argv, ["file", "data-dir", "dry-run", "json"]);
  file = requireArg(args, "file");
  const cfg = loadConfig();
  dataDir = path.resolve(args.get("data-dir") ?? cfg.dataDir);
  dryRun = boolFlag(args, "dry-run");
  jsonOut = boolFlag(args, "json");
} catch (e) {
  console.error(`[import-save] ${e instanceof Error ? e.message : String(e)}`);
  console.error(USAGE);
  process.exit(2);
}

try {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.resolve(file!), "utf8")) as unknown;
  } catch (e) {
    console.error(`[import-save] 归档文件不可读或不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  const checked = inspectArchive(raw);
  if (!checked.ok) {
    // fail-closed：这里退出，下面一行写盘代码根本不会执行
    console.error(`[import-save] 拒绝导入（${checked.code}）：${checked.message}`);
    process.exit(2);
  }

  const store = new FileStore(path.join(dataDir, "rooms"));
  const seq = await store.load(checked.archive.roomId);
  const existing = seq > 0 ? await store.events(checked.archive.roomId, 1, seq) : [];
  const plan = planImport(checked.events, seq, existing);
  if (plan.action === "conflict") {
    console.error(`[import-save] 拒绝导入（E_PRECONDITION）：${plan.message}`);
    process.exit(2);
  }

  if (dryRun) {
    const summary = {
      roomId: checked.archive.roomId, action: plan.action,
      wouldAppend: plan.action === "noop" ? 0 : plan.toAppend.length,
      targetSeq: seq + (plan.action === "noop" ? 0 : plan.toAppend.length),
      checksum: checked.archive.checksum, dryRun: true,
    };
    console.log(jsonOut ? JSON.stringify(summary, null, 2)
      : `[import-save] 演练：${summary.action}，将追加 ${summary.wouldAppend} 条到 seq=${summary.targetSeq}（未写盘）`);
    process.exit(0);
  }

  const result = await importArchive({
    archive: checked.archive, events: checked.events, store,
    ...(checked.saveIndexData ? {
      saveIndexStore: new SaveIndex(path.join(dataDir, "users")),
      saveIndexData: checked.saveIndexData,
    } : {}),
  });
  if (!result.ok) {
    console.error(`[import-save] 导入失败（${result.code}）：${result.message}`);
    process.exit(2);
  }
  if (jsonOut) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`[import-save] ${result.roomId}: ${result.action}，追加 ${result.appended} 条，seq=${result.seq}，${result.checksum}`);
    if (result.saveIndexRestored) console.log("  存档索引快照已恢复");
    if (result.warning) console.warn(`  ${result.warning}`);
  }
} catch (e) {
  console.error(`[import-save] 导入失败：${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
