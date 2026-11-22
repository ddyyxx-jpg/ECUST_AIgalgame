/**
 * 存档归档导出/导入（issue #99）：把房间的权威事件日志 + 内存投影打包成可移植 JSON。
 *
 * 为什么不落盘一份"世界状态"：I1（只有 Arbiter.apply 能改世界），状态是事件折出来的，
 * 单一事实源始终是 `data/rooms/<roomId>.jsonl`；归档只是把那条日志搬个地方。
 *
 * 导入为什么走 EventLog.append 而不是写文件：append 正是 DefaultArbiter.apply 用的写接口
 * （seq 连续校验 + 写盘先行 + tmp/rename 原子替换）。归档里的事件都是当初 Arbiter 裁过的
 * 既成事实，导入经这条唯一通道重放；绝不自己拼路径写 `data/rooms/*.jsonl`（docs/05 §8.3 红线）。
 *
 * 所有校验都在写之前完成：zod → 版本 → checksum → 事件链 → replay → 投影 → 冲突。
 * 任一步失败都 fail-closed，不产生半落库。校验错误码复用 03 §7 闭集，不新增 E_*。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CONTRACT_VERSION, SCHEMA_VERSION, EnvelopeSchema,
  type Envelope, type WorldState,
} from "@galgame/shared";
import { applyEvent, createInitialState, isSafeRoomId, type EventLog } from "@galgame/engine";
import { SaveIndex, savesFileSchema, type SavesFile, type SaveEntry } from "./saves.ts";

export const ARCHIVE_FORMAT = "galgame-save-archive" as const;
/** 归档封装自身版本（与契约版本、世界 schemaVersion 都分开，互不连带） */
export const ARCHIVE_VERSION = 1 as const;

export interface SaveArchive {
  format: typeof ARCHIVE_FORMAT;
  formatVersion: number;
  schemaVersion: number;
  contractVersion: string;
  savedAt: number;
  roomId: string;
  seq: number;
  eventCount: number;
  checksum: string;
  events: Envelope[];
  projection: WorldState;
  saveIndex?: { userId: string; saves: SaveEntry[]; slots?: unknown[] };
}

const ArchiveSchema = z.object({
  format: z.literal(ARCHIVE_FORMAT),
  formatVersion: z.number().int().positive(),
  schemaVersion: z.number().int().positive(),
  contractVersion: z.string().min(1),
  savedAt: z.number().int().nonnegative(),
  roomId: z.string().min(1).max(80),
  seq: z.number().int().positive(),
  eventCount: z.number().int().nonnegative(),
  checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  // passthrough：事件里若有本版本不认识的可选字段，必须原样参与 checksum，不能被 zod strip 掉
  events: z.array(EnvelopeSchema.passthrough()).min(1),
  projection: z.unknown(),
  saveIndex: z.object({
    userId: z.string().min(1),
    saves: z.array(z.unknown()),
    slots: z.array(z.unknown()),
  }).partial({ slots: true }).optional(),
});

export type ArchiveErrorCode = "E_SCHEMA_INVALID" | "E_SEQ_GAP" | "E_PRECONDITION" | "E_STORE_FAULT";
export interface ArchiveFailure {
  ok: false;
  code: ArchiveErrorCode;
  message: string;
}
const fail = (code: ArchiveErrorCode, message: string): ArchiveFailure => ({ ok: false, code, message });
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 稳定序列化：键排序，避免两端键序差异造成假 checksum 不匹配 / 假投影不一致。 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

/** checksum 只覆盖权威事件日志；savedAt / projection / saveIndex 都是派生数据，不参与。 */
export function archiveChecksum(events: Envelope[]): string {
  return `sha256:${createHash("sha256").update(canonical(events), "utf8").digest("hex")}`;
}

/** seq 必须从 1 连续、且每条都归属本房间——这是事件日志可被回放的前提。 */
function chainError(events: Envelope[], roomId: string): ArchiveFailure | undefined {
  for (let i = 0; i < events.length; i++) {
    const env = events[i]!;
    if (env.seq !== i + 1) {
      return fail("E_SEQ_GAP", `第 ${i + 1} 条事件 seq=${env.seq}，期望 ${i + 1}`);
    }
    if (env.roomId !== roomId) {
      return fail("E_SCHEMA_INVALID", `事件 roomId=${env.roomId} 与归档 roomId=${roomId} 不符`);
    }
  }
  return undefined;
}

export interface ExportInput {
  roomId: string;
  events: Envelope[];
  /** 内存投影；缺省时用与引擎相同的 applyEvent 折出，保证与播放结果一致 */
  projection?: WorldState;
  savedAt?: number;
  saveIndex?: { userId: string; saves: SaveEntry[]; slots?: unknown[] };
}

/** 纯函数：读到的事件日志 + 投影 → 归档对象（调用方负责把对象写盘）。 */
export function buildArchive(input: ExportInput): SaveArchive {
  if (!isSafeRoomId(input.roomId)) {
    throw Object.assign(new Error(`非法 roomId: ${input.roomId}`), { code: "E_SCHEMA_INVALID" });
  }
  if (input.events.length === 0) {
    throw Object.assign(new Error("空房间无可导出事件"), { code: "E_PRECONDITION" });
  }
  const chain = chainError(input.events, input.roomId);
  if (chain) throw Object.assign(new Error(chain.message), { code: chain.code });

  let projection = input.projection;
  if (!projection) {
    projection = createInitialState(input.roomId);
    for (const env of input.events) projection = applyEvent(projection, env);
  }
  return {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    savedAt: input.savedAt ?? Date.now(),
    roomId: input.roomId,
    seq: input.events.length,
    eventCount: input.events.length,
    checksum: archiveChecksum(input.events),
    events: input.events,
    projection,
    ...(input.saveIndex ? { saveIndex: input.saveIndex } : {}),
  };
}

export interface InspectedArchive {
  ok: true;
  archive: SaveArchive;
  events: Envelope[];
  projection: WorldState;
  saveIndexData?: SavesFile;
}
export type InspectResult = InspectedArchive | ArchiveFailure;

/**
 * fail-closed 校验：任何不认识的版本 / 坏 checksum / 断链 / 投影对不上都不猜、不迁移、不落库。
 * 返回重放出的投影，供调用方与 GET /state 比对（round-trip 证据）。
 */
export function inspectArchive(raw: unknown): InspectResult {
  const parsed = ArchiveSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("E_SCHEMA_INVALID", `归档结构无效：${parsed.error.issues[0]?.message ?? "未知"}`);
  }
  const archive = parsed.data as unknown as SaveArchive;
  if (archive.formatVersion !== ARCHIVE_VERSION) {
    return fail("E_SCHEMA_INVALID", `不支持的归档版本 ${archive.formatVersion}（只认 ${ARCHIVE_VERSION}，不猜不迁移）`);
  }
  if (archive.schemaVersion !== SCHEMA_VERSION) {
    return fail("E_SCHEMA_INVALID", `不支持的世界 schemaVersion ${archive.schemaVersion}（当前 ${SCHEMA_VERSION}）`);
  }
  if (archive.contractVersion !== CONTRACT_VERSION) {
    return fail("E_SCHEMA_INVALID", `契约版本不匹配：归档 ${archive.contractVersion}，当前 ${CONTRACT_VERSION}`);
  }
  const events = archive.events;
  if (archiveChecksum(events) !== archive.checksum) {
    return fail("E_SCHEMA_INVALID", "checksum 不符：事件日志已被改动");
  }
  const chain = chainError(events, archive.roomId);
  if (chain) return chain;
  if (archive.eventCount !== events.length || archive.seq !== events[events.length - 1]!.seq) {
    return fail("E_SEQ_GAP", `eventCount/seq 与实际 ${events.length} 条事件不符`);
  }

  let state = createInitialState(archive.roomId);
  for (const env of events) state = applyEvent(state, env);
  // 投影是导出时附带的冗余副本；不一致说明事件被换过或归档被拼凑过，拒绝导入
  if (archive.projection !== undefined && canonical(archive.projection) !== canonical(state)) {
    return fail("E_PRECONDITION", "自带投影与事件回放结果不一致");
  }

  let saveIndexData: SavesFile | undefined;
  if (archive.saveIndex) {
    const si = savesFileSchema.safeParse({
      version: 1, userId: archive.saveIndex.userId,
      saves: archive.saveIndex.saves, slots: archive.saveIndex.slots,
    });
    if (!si.success) {
      return fail("E_SCHEMA_INVALID", `存档索引快照无效：${si.error.issues[0]?.message ?? "未知"}`);
    }
    saveIndexData = si.data;
  }
  return { ok: true, archive, events, projection: state, ...(saveIndexData ? { saveIndexData } : {}) };
}

export type ImportPlan =
  | { action: "create" | "extend"; toAppend: Envelope[] }
  | { action: "noop" }
  | { action: "conflict"; message: string };

/**
 * 冲突处理：已有日志必须是归档日志的连续前缀才允许续写（断点续导）。
 * 不一致一律拒绝覆盖——不猜哪边更新，避免把玩家正在玩的房间打回去。
 */
export function planImport(events: Envelope[], existingSeq: number, existing: Envelope[]): ImportPlan {
  if (existingSeq === 0) return { action: "create", toAppend: events };
  if (existingSeq > events.length) {
    return { action: "conflict", message: `目标房间 seq=${existingSeq} 已超过归档 seq=${events.length}` };
  }
  if (canonical(existing) !== canonical(events.slice(0, existingSeq))) {
    return { action: "conflict", message: `目标房间已有 ${existingSeq} 条事件且与归档前缀不一致，拒绝覆盖` };
  }
  if (existingSeq === events.length) return { action: "noop" };
  return { action: "extend", toAppend: events.slice(existingSeq) };
}

export interface ImportOptions {
  archive: SaveArchive;
  events: Envelope[];
  /** Arbiter 独占的写入接口：导入唯一的合法落库通道 */
  store: EventLog;
  /** 可选：恢复 saves.json 投影（它是投影，坏了可由 #122 从房间日志重建） */
  saveIndexStore?: SaveIndex;
  saveIndexData?: SavesFile;
}
export interface ImportSummary {
  ok: true;
  roomId: string;
  action: "create" | "extend" | "noop";
  appended: number;
  seq: number;
  checksum: string;
  saveIndexRestored: boolean;
  warning?: string;
}
export type ImportResult = ImportSummary | ArchiveFailure;

async function restoreIndex(store: SaveIndex, doc: SavesFile): Promise<void> {
  for (const entry of doc.saves) await store.upsert(doc.userId, entry);
  for (const slot of doc.slots ?? []) await store.putSlot(doc.userId, slot);
}

/** 经 EventLog.append 落库（Arbiter 的同一写入通道），写前已全部校验，失败不半落库。 */
export async function importArchive(opts: ImportOptions): Promise<ImportResult> {
  const roomId = opts.archive.roomId;
  let existingSeq: number;
  try {
    existingSeq = await opts.store.load(roomId);
  } catch (e) {
    return fail("E_STORE_FAULT", `读取目标房间失败：${errText(e)}`);
  }
  const existing = existingSeq > 0 ? await opts.store.events(roomId, 1, existingSeq) : [];
  const plan = planImport(opts.events, existingSeq, existing);
  if (plan.action === "conflict") return fail("E_PRECONDITION", plan.message);
  if (plan.action === "noop") {
    return {
      ok: true, roomId, action: "noop", appended: 0, seq: existingSeq,
      checksum: opts.archive.checksum, saveIndexRestored: false,
    };
  }

  try {
    await opts.store.append(roomId, plan.toAppend);
  } catch (e) {
    return fail("E_STORE_FAULT", `落盘失败：${errText(e)}`);
  }
  let saveIndexRestored = false;
  let warning: string | undefined;
  if (opts.saveIndexStore && opts.saveIndexData) {
    try {
      await restoreIndex(opts.saveIndexStore, opts.saveIndexData);
      saveIndexRestored = true;
    } catch (e) {
      // 权威事件日志已落库；索引是投影，失败只上报，可跑 rebuild-saves 补回
      warning = `存档索引恢复失败（可用 rebuild-saves 重建）：${errText(e)}`;
    }
  }
  return {
    ok: true, roomId, action: plan.action, appended: plan.toAppend.length,
    seq: existingSeq + plan.toAppend.length,
    checksum: archiveChecksum(opts.events), saveIndexRestored,
    ...(warning ? { warning } : {}),
  };
}
