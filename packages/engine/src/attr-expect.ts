/**
 * `expectAttrs` 的生产接线辅助（issue #138）。
 *
 * 结算/回合在开始时读了一份状态快照，并用它算模块提案与 LLM 提案；从"读快照"到
 * "交 Arbiter"之间，世界可能已被同房间的另一批提交改过（后台 tick、另一个 HTTP 请求）。
 * 这里把提案**读到的那些属性**折成 `AttrExpectation`，交给 `Arbiter.apply` 在串行链内
 * 复核：值变了 → 整批 `E_PRECONDITION`，不落库、不消耗预算，避免"基于旧值算的 delta 被
 * 叠加到新值上"的静默漂移。
 *
 * 只覆盖会被属性值影响的 op（`attr.delta` / `attr.set`）；`entity.create`、`memory.write`
 * 之类不读旧属性，不产生前置条件（加了只会误拒）。键不存在时期望值为 `null`（契约语义：
 * "必须不存在"），因此对"新写入"同样成立。
 */
import type { AttrExpectation, AttrValue, Proposal, WorldState } from "../../shared/src/index.ts";

export function expectAttrsFor(state: WorldState, ops: readonly Proposal[]): AttrExpectation[] {
  const seen = new Set<string>();
  const out: AttrExpectation[] = [];
  for (const op of ops) {
    if (op.op !== "attr.delta" && op.op !== "attr.set") continue;
    const entityId = op.args.entityId;
    const key = op.args.key;
    // Proposal.args 是 Record<string, unknown>（契约层不替调用方猜形状）；这里只接形状合法的条目，
    // 非法形状留给 Arbiter 报 E_SCHEMA_INVALID，不在这里吞掉。
    if (typeof entityId !== "string" || typeof key !== "string") continue;
    const dedupeKey = `${entityId}\u0000${key}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const current = state.entities[entityId]?.attrs?.[key];
    out.push({ entityId, key, expected: (current ?? null) as AttrValue | null });
  }
  return out;
}
