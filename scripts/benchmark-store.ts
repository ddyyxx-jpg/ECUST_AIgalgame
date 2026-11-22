/** Measure whole-log FileStore commits using synthetic data on TMPDIR. */
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileStore } from "../packages/engine/src/store.ts";
import type { Envelope } from "../packages/shared/src/index.ts";

const roomId = "room_benchmark";
const event = (seq: number): Envelope => ({
  v: 1, id: `evt_bench_${seq}`, roomId, seq, ts: seq,
  actorId: "system", type: "turn.accepted", payload: { synthetic: "x".repeat(220) },
});
const root = await mkdtemp(path.join(tmpdir(), "galgame-store-bench-"));
try {
  for (const size of [1_000, 10_000, 50_000]) {
    const file = path.join(root, `${roomId}.jsonl`);
    const seed = Array.from({ length: size }, (_, i) => JSON.stringify(event(i + 1)));
    await writeFile(file, seed.join("\n") + "\n", { flush: true });
    const store = new FileStore(root);
    const loadStart = performance.now();
    await store.load(roomId);
    const loadMs = performance.now() - loadStart;
    const samples: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const start = performance.now();
      await store.append(roomId, [event(size + i)]);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    console.log(JSON.stringify({
      eventsBefore: size, bytes: (await stat(file)).size, loadMs: Math.round(loadMs),
      appendMedianMs: Math.round(samples[2]!), appendMaxMs: Math.round(samples[4]!),
    }));
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
