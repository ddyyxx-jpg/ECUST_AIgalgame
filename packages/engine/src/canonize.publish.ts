/**
 * 世界层发布：八道闸门 + 唯一写路径（从 canonize.ts 拆出：实现文件保持 ≤300 行）。
 * 这里不持有时钟/日期状态，只吃一个可变的 `mut` 计账对象，方便单独测试与回滚。
 *
 * P2-2 写隔离口径：一次 retireRoom 开始时记下世界房 seq 作为 `basedOnSeq`，
 * 每次成功 apply 后把它推进到最新 seq；之后所有 apply 都用它做 expectedSeq。
 * E_SEQ_GAP 有界重试：重新 load 最新 seq，重算 cause.seq/expectedSeq 后再提交；
 * 重试耗尽仍失败时记入 errors，绝不静默 skip。
 */
import type { Envelope, Id, MemoryRecord, Proposal, RoomId, WorldState } from "../../shared/src/index.ts";
import { contentHashOf } from "./memory.gate.ts";
import { buildImpression } from "./impressions.ts";
import type { CanonizeDeps, CanonizeLimits, CanonizeReport } from "./canonize.types.ts";
import { SEQ_GAP_MAX_RETRIES } from "./canonize.types.ts";
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
  /**
   * 任务开始时 load 到的世界房 seq（基线）。每次成功 apply 后由本函数推进；
   * 所有 apply 都以它作为 expectedSeq —— 新世代推进 seq 后旧任务体必被 E_SEQ_GAP 拒绝。
   */
  basedOnSeq: number;
}

/**
 * 带 E_SEQ_GAP 有界重试的原子 apply。
 *
 * 关键 P2-2 取舍：`expectedSeq` 用的是任务开始时 load 的 `basedOnSeq`，每次成功后再推进，
 * 绝不在 apply 前临时 load 新 seq —— 否则僵尸任务体拿到的就是新世代的 seq，检查形同虚设。
 * E_SEQ_GAP 时，只有 signal 未 abort 的活动任务才允许重新 load 最新 seq、重算 cause.seq 与
 * expectedSeq 重试（最多 SEQ_GAP_MAX_RETRIES 次）；被 stall 接管的僵尸 signal 已 abort，
 * 遇到 E_SEQ_GAP 直接走失败分支记入 errors，不再重试、不插到新世代写入之后。
 *
 * apply 是原子整批：失败即未落库；重试不会重复写入，也不会把失败批次的事件混入成功结果。
 */
export async function applyWithSeqRetry(
  deps: CanonizeDeps,
  op: Proposal,
  buildCause: (seq: number) => Envelope,
  basedOnSeq: number,
  signal?: AbortSignal,
): Promise<{ applied: Awaited<ReturnType<CanonizeDeps["arbiter"]["apply"]>>; seq: number }> {
  let expectedSeq = basedOnSeq;
  let attempts = 0;
  for (;;) {
    // 循环顶部（含首次）先确认任务仍活动，abort 后不再发起 apply
    if (signal?.aborted) return { applied: abortedApply(expectedSeq), seq: expectedSeq };
    const cause = buildCause(expectedSeq + 1);
    const applied = await deps.arbiter.apply(deps.worldRoom, [op], cause, { expectedSeq });
    if (applied.ok) return { applied, seq: applied.seq };
    const code = applied.rejected[0]?.code ?? applied.error?.code;
    // 僵尸任务体（signal 已 abort）或重试耗尽：不再重算 seq，把最后一次失败交回调用方记入 errors
    if (code !== "E_SEQ_GAP" || signal?.aborted || attempts >= SEQ_GAP_MAX_RETRIES) {
      return { applied, seq: expectedSeq };
    }
    attempts += 1;
    // 活动任务的自旋重试：load 最新 seq 后重算 cause.seq 与 expectedSeq，候选内容不变
    expectedSeq = await deps.store.load(deps.worldRoom);
    // abort 可能发生在 await store.load(...) 内部：load 完成后必须再检查，
    // 否则下一轮循环顶部检查不到（abort 已经结束），僵尸任务仍会以新 seq 落库。
    if (signal?.aborted) return { applied: abortedApply(expectedSeq), seq: expectedSeq };
  }
}

/** 中止时返回一个"未落库"的失败结果；调用方据此把该写入记为跳过，不写世界层 */
function abortedApply(seq: number): Awaited<ReturnType<CanonizeDeps["arbiter"]["apply"]>> {
  return {
    ok: false,
    mode: "atomic",
    seq,
    applied: [],
    rejected: [],
    events: [],
    error: { code: "E_ABORTED", message: "任务已中止，跳过本次写入" },
  };
}

/** 中止报告：只标记 aborted，written 保留此前已落库的批次（不做回滚） */
function abortedReport(args: PublishArgs, written: Id[], skipped: Map<string, number>, errors: string[], candidates = 0): CanonizeReport {
  return {
    worldId: args.deps.worldId,
    // 中止时仍要报"看过多少候选"，否则 0 候选 + 已写 N 条会被读成数据不一致
    candidates,
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
  // 基线由调用方在任务开始时 load 到；每次成功 apply 后推进，失败批不推进
  let basedOnSeq = args.basedOnSeq;
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
    if (signal?.aborted) return abortedReport(args, written, skipped, errors, candidates.length);
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
    if (signal?.aborted) return abortedReport(args, written, skipped, errors, candidates.length);
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
    if (signal?.aborted) return abortedReport(args, written, skipped, errors, candidates.length);
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
    // P2-2：expectedSeq 用本任务开始时 load 的 basedOnSeq（每次成功 apply 后推进），
    // 绝不在 apply 前临时 load 新 seq —— 否则僵尸任务体拿到新世代 seq，检查形同虚设。
    // E_SEQ_GAP 时活动任务可重算 cause/expectedSeq 有界重试，僵尸（signal.aborted）不重试。
    const { applied, seq: appliedSeq } = await applyWithSeqRetry(
      deps,
      op,
      (causeSeq) => ({
        v: 1,
        id: `evt_canonize_${hash.slice(0, 12)}`,
        roomId: deps.worldRoom,
        seq: causeSeq,
        ts: deps.now ? deps.now() : Date.now(),
        actorId: "mem_world",
        type: "canonize",
        payload: { worldId: deps.worldId, sourceRefs: candidate.sourceRefs },
      }),
      basedOnSeq,
      signal,
    );
    basedOnSeq = appliedSeq;
    if (!applied.ok) {
      const code = applied.error?.code ?? applied.rejected[0]?.code ?? "E_MODULE_FAULT";
      if (code === "E_ABORTED") {
        // applyWithSeqRetry 在重试窗口内检测到 abort：本次写入记为跳过，不进 errors、不落库
        skip(skipped, "aborted");
        return abortedReport(args, written, skipped, errors, candidates.length);
      }
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
