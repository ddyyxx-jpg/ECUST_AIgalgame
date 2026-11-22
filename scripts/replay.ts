/**
 * 校验 JSONL 并执行与服务端相同的事件投影。
 * 用法：npm run replay -- --file data/rooms/room_x.jsonl [--to 42] [--json]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createInitialState } from "../packages/engine/src/projection.ts";
import { decodeRoomLog, projectRoomEvents } from "../packages/engine/src/room-log.ts";

const { values } = parseArgs({
  options: { file: { type: "string" }, to: { type: "string" }, json: { type: "boolean" } },
});
const { file, json } = values;
const to = values.to === undefined ? Number.POSITIVE_INFINITY : Number(values.to);
if (!file || (values.to !== undefined && (!/^\d+$/.test(values.to) || !Number.isSafeInteger(to)))) {
  console.error("用法: npm run replay -- --file <jsonl> [--to seq] [--json]");
  process.exit(2);
}

try {
  const events = decodeRoomLog(readFileSync(file, "utf8"));
  const contentDir = process.env.GALGAME_CONTENT_DIR || "content";
  const canon = JSON.parse(readFileSync(resolve(contentDir, "canon", "world.json"), "utf8")) as {
    worldId: string; startLocId?: string; locs: { id: string }[];
  };
  const initial = createInitialState(events[0]?.roomId ?? "", {
    worldId: canon.worldId, locId: canon.startLocId ?? canon.locs[0]?.id,
  });
  projectRoomEvents(initial, events, to);
  const types = new Map<string, number>();
  let replayedTo = 0;
  for (const event of events) {
    if (event.seq > to) break;
    replayedTo = event.seq;
    types.set(event.type, (types.get(event.type) ?? 0) + 1);
  }
  const summary = {
    file, total: events.length, replayedTo, seqGaps: 0,
    types: Object.fromEntries([...types.entries()].sort()), ok: true,
  };
  if (json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`事件 ${summary.total} 条，重放到 seq=${replayedTo}，seq 断档 0 处`);
    for (const [type, count] of types) console.log(`  ${type} × ${count}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (json) console.log(JSON.stringify({ file, ok: false, error: message }, null, 2));
  else console.error(message);
  process.exitCode = 1;
}
