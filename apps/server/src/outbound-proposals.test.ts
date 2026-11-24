import { describe, expect, it } from "vitest";
import type { Proposal } from "../../../packages/shared/src/contract/types.ts";
import type { Envelope } from "../../../packages/shared/src/contract/types.ts";
import { projectEventsForPlayer, projectProposalsForPlayer, projectTurnEventForPlayer } from "./outbound-secrets.ts";

describe("projectProposalsForPlayer", () => {
  it("整条丢掉引擎内部属性写入，保留普通属性与公开记忆", () => {
    const proposals = [
      { op: "attr.set", args: { entityId: "npc_1", key: "sim_lease", value: '{"action":"move"}' }, reason: "租约", by: "tick" },
      { op: "attr.delta", args: { entityId: "npc_1", key: "stamina", delta: -1 }, reason: "消耗", by: "tick" },
      { op: "memory.write", args: { ownerId: "npc_1", content: "公开", tags: [], visibility: "public", importance: 3 }, reason: "记忆", by: "tick" },
    ] as unknown as Proposal[];
    const out = projectProposalsForPlayer(proposals);
    expect(out).toHaveLength(2);
    expect(out.map((p) => p.op)).toEqual(["attr.delta", "memory.write"]);
    expect(JSON.stringify(out)).not.toContain("sim_lease");
  });

  it("防御 entity.update 的 attrs patch：带内部属性整条丢掉，普通更新保留", () => {
    const proposals = [
      { op: "entity.update", args: { entityId: "npc_1", attrs: { sim_lease: "x" } }, reason: "租约", by: "tick" },
      { op: "entity.update", args: { entityId: "npc_1", status: "active" }, reason: "状态", by: "tick" },
    ] as unknown as Proposal[];
    const out = projectProposalsForPlayer(proposals);
    expect(out).toHaveLength(1);
    expect(out[0]?.args).toEqual({ entityId: "npc_1", status: "active" });
  });
});

describe("projectTurnEventForPlayer", () => {
  it("v1 turn.patch 的 state 与 ops 都剥掉 sim_lease", () => {
    const ev = {
      type: "turn.patch",
      state: {
        entities: { npc_1: { id: "npc_1", kind: "npc", attrs: { sim_lease: "LEAK" } } },
        plots: [],
      },
      ops: [
        { op: "attr.set", args: { entityId: "npc_1", key: "sim_lease", value: "LEAK" }, reason: "x", by: "tick" },
      ],
    };
    const out = projectTurnEventForPlayer(ev);
    expect(JSON.stringify(out)).not.toContain("sim_lease");
    expect(out.ops).toEqual([]);
  });
});

describe("projectEventsForPlayer", () => {
  it("/events 的 turn.patch envelope 同样剥掉 state/ops 里的 sim_lease", () => {
    const event = {
      roomId: "r1",
      seq: 3,
      ts: "2026-11-22T00:00:00.000Z",
      type: "turn.patch",
      payload: {
        state: {
          entities: { npc_1: { id: "npc_1", kind: "npc", attrs: { sim_lease: "LEAK" } } },
          plots: [],
        },
        ops: [
          { op: "attr.set", args: { entityId: "npc_1", key: "sim_lease", value: "LEAK" }, reason: "x", by: "tick" },
        ],
      },
    } as unknown as Envelope;
    const out = projectEventsForPlayer([event]);
    expect(out).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain("sim_lease");
    expect((out[0]?.payload as { ops?: unknown }).ops).toEqual([]);
  });
});
