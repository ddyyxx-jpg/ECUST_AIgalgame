import { describe, expect, it } from "vitest";
import type { Proposal } from "../../../packages/shared/src/contract/types.ts";
import { projectProposalsForPlayer } from "./outbound-secrets.ts";

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
