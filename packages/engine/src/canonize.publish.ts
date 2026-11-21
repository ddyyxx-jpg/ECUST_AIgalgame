/**
 * 世界层发布：八道闸门 + 唯一写路径（从 canonize.ts 拆出：实现文件保持 ≤300 行）。
 * 这里不持有时钟/日期状态，只吃一个可变的 `mut` 计账对象，方便单独测试与回滚。
 */
import type { Envelope, Id, MemoryRecord, Proposal, RoomId, WorldState } from "../../shared/src/index.ts";
import { contentHashOf } from "./memory.gate.ts";
import { buildImpression } from "./impressions.ts";
import type { CanonizeDeps, CanonizeLimits, CanonizeReport } from "./canonize.types.ts";
import type { PermanentCandidate } from "./canonize.candidates.ts";
import { SOURCE_REF, candidatesFromMemories, privacyHit, witnessCount } from "./canonize.candidates.ts";

export interface PublishMut {
  writtenToday: number;
  writtenTotal: number;
  perSource: Map<Id, number>;
  worldVersion: number;
  judgeFailures: number;
}

export interface PublishArgs {
  deps: CanonizeDeps;
  limits: CanonizeLimits;
  judgeFailureLimit: number;
  mut: PublishMut;
  state: WorldState;
  roomRecords: MemoryRecord[];
  roomId: RoomId;
  /** 协作式中止：循环迭代之间/每次 judge 调用前检查；不传则完全保持旧行为 */
  signal?: AbortSignal;
  worldHashes: (envs: Envelope[]) => string[];
}

/** 中止报告：只标记 aborted，written 保留此前已落库的批次（不做回滚） */
function abortedReport(args: PublishArgs, written: Id[], skipped: Map<string, number>, errors: string[]): CanonizeReport {
  return {
    worldId: args.deps.worldId,
    candidates: 0,
    written,
    skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })),
    errors,
    writtenToday: args.mut.writtenToday,
    aborted: true,
  };
}

function skip(skipped: Map<string, number>, reason: string): void {
  skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
}

export async function publishCandidates(args: PublishArgs): Promise<CanonizeReport> {
  const { deps, limits, mut, judgeFailureLimit, state, roomRecords, roomId, signal } = args;
  const skipped = new Map<string, number>();
  const errors: string[] = [];
  const written: Id[] = [];
  // rollDay 由 CanonizeJob 调用（日期边界决定当日配额）
  if (!limits.enabled) {
    return { worldId: deps.worldId, candidates: 0, written, skipped: [{ reason: "disabled", count: 1 }], errors, writtenToday: mut.writtenToday };
  }

  const candidates = candidatesFromMemories(roomId, roomRecords, deps.worldId);
  const secrets = roomRecords.filter((r) => r.visibility === "secret").map((r) => r.content);
  // 幂等只看**世界层**已有条目；房间里的记忆当然有同样的内容，那是候选的来源，不是重复
  const existing = new Set(args.worldHashes(await deps.store.events(deps.worldRoom, 0)));

  if (mut.judgeFailures >= judgeFailureLimit) {
    return { worldId: deps.worldId, candidates: candidates.length, written, skipped: [{ reason: "circuit_open", count: candidates.length }], errors, writtenToday: mut.writtenToday };
  }

  for (const candidate of candidates) {
    // 协作式中止：迭代之间检查，abort 后立刻返回，已落库批次保持真实、不回滚
    if (signal?.aborted) return abortedReport(args, written, skipped, errors);
    // ① 来源可追溯
    if (candidate.sourceRefs.length === 0 || !candidate.sourceRefs.every((r) => SOURCE_REF.test(r))) {
      skip(skipped, "source_untraceable");
      continue;
    }
    // ② 公共性
    if (witnessCount(roomRecords, candidate) < limits.minWitness) {
      skip(skipped, "not_public_enough");
      continue;
    }
    // ③ 隐私扫描
    const hit = privacyHit(candidate.content, state, secrets);
    if (hit) {
      skip(skipped, `privacy:${hit}`);
      continue;
    }
    // ④ 幂等（同内容已在世界层）
    const hash = contentHashOf(candidate.content);
    if (existing.has(hash)) {
      skip(skipped, "duplicate");
      continue;
    }
    // ⑤ 体量：每日上限 + 单来源上限（先做便宜判断，审核调用最贵 → 放最后）
    if (mut.writtenToday >= limits.dailyCap) {
      skip(skipped, "daily_cap");
      continue;
    }
    const src = candidate.sourceRefs[0]!;
    if ((mut.perSource.get(src) ?? 0) >= limits.perSourceCap) {
      skip(skipped, "per_source_cap");
      continue;
    }
    // ⑥ 独立审核（judge 抛错 = 拒绝：fail-closed）
    // 每次 LLM 调用前再检查一次：abort 与调用排在同一个 tick 时不再发起付费请求
    if (signal?.aborted) return abortedReport(args, written, skipped, errors);
    try {
      const verdict = await deps.judge.review(candidate);
      mut.judgeFailures = 0;
      if (!verdict.allow) {
        skip(skipped, `judge:${verdict.reason ?? "deny"}`);
        continue;
      }
    } catch {
      mut.judgeFailures += 1;
      skip(skipped, "judge_unavailable");
      continue;
    }

    // ⑦⑧ 发布（不可变/回滚由 Arbiter 的世界层规则保证）+ 版本号
    // judge 是异步间隙：abort 可能在此期间发生，落库前再确认一次，避免"取消后仍写入"
    if (signal?.aborted) return abortedReport(args, written, skipped, errors);
    const op: Proposal = {
      op: "memory.write",
      reason: `canonize:${src}`,
      args: {
        ownerId: "mem_world",
        worldId: deps.worldId,
        content: candidate.content,
        tags: candidate.tags,
        about: candidate.about,
        aboutUserIds: candidate.aboutUserIds,
        sourceRefs: candidate.sourceRefs,
        contentHash: hash,
        tier: "permanent",
        visibility: "public",
        status: candidate.status,
        salience: 5,
      },
    };
    const seq = await deps.store.load(deps.worldRoom);
    const cause: Envelope = {
      v: 1,
      id: `evt_canonize_${hash.slice(0, 12)}`,
      roomId: deps.worldRoom,
      seq: seq + 1,
      ts: deps.now ? deps.now() : Date.now(),
      actorId: "mem_world",
      type: "canonize",
      payload: { worldId: deps.worldId, sourceRefs: candidate.sourceRefs },
    };
    // P2-2：带 expectedSeq——stall 接管后旧任务体若仍走到这里，seq 已变则整批拒绝，
    // 不会与新任务体的写入交错（generation 只保锁/账本，world 写隔离靠检查点 + 本防线）。
    const applied = await deps.arbiter.apply(deps.worldRoom, [op], cause, { expectedSeq: seq });
    if (!applied.ok) {
      const code = applied.rejected[0]?.code ?? applied.error?.code ?? "E_MODULE_FAULT";
      errors.push(code);
      skip(skipped, `arbiter:${code}`);
      continue;
    }
    let memoryId: Id | undefined;
    for (const ev of applied.events) deps.memory.ingest?.(ev);
    for (const ev of applied.events) {
      if (ev.type === "memory.written") {
        const id = (ev.payload as { memoryId?: Id }).memoryId;
        if (id) {
          written.push(id);
          memoryId = id;
        }
      }
    }
    // 印象：只有"关于某个玩家的公开事迹"才通知他（每条约 1 个 userId，按 userId 去重）
    if (memoryId && deps.onImpression && candidate.aboutUserIds && candidate.aboutUserIds.length > 0) {
      const npcId = candidate.about.find((id) => id.startsWith("npc_"));
      for (const userId of [...new Set(candidate.aboutUserIds)].slice(0, 4)) {
        const notice = buildImpression({
          memoryId,
          userId,
          worldId: deps.worldId,
          content: candidate.content,
          ...(npcId ? { npcId } : {}),
          now: deps.now ? deps.now() : Date.now(),
        });
        if (!notice) continue;
        try {
          await deps.onImpression(notice, roomId);
        } catch {
          // 印象是锦上添花：入队失败不能回滚已发布的世界层记忆
        }
      }
    }
    existing.add(hash);
    mut.perSource.set(src, (mut.perSource.get(src) ?? 0) + 1);
    mut.writtenToday += 1;
    mut.writtenTotal += 1;
    mut.worldVersion += 1;
    if (deps.onVersionBump) await deps.onVersionBump(deps.worldId, mut.worldVersion);
  }

  return {
    worldId: deps.worldId,
    candidates: candidates.length,
    written,
    skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })),
    errors,
    writtenToday: mut.writtenToday,
  };
}
