/**
 * 会话快照持久化（dev/v2，issue #90）：ConversationSessionV2 落独立文件，不进 EventLog。
 *
 * 为什么独立文件而不是 EventLog 事件：
 * - EventLog 是唯一世界真源，事件名/op 是闭集（I1 + docs/03）；新增事件类型要 bump 契约版本。
 * - 会话状态（phase/turn/queue/sceneMemory…）只是会话宿主的瞬时投影，重启能恢复即可；
 *   把它塞进事件日志既污染真源，又迫使所有消费者跟着 bump。
 * 约定：data/rooms/<roomId>/conversation-sessions.json（与 <roomId>.jsonl 事件日志并列，不冲突）。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const utteranceSchema = z.object({
  id: z.string(),
  speaker: z.string(),
  target: z.union([z.string(), z.array(z.string())]).optional(),
  mode: z.string(),
  content: z.string().optional(),
  action: z.string().optional(),
  coverAction: z.string().optional(),
  notice: z.string().optional(),
});

const sceneBeatSchema = z.object({
  id: z.string(),
  kind: z.enum(["opening", "summary"]),
  roomId: z.string(),
  locId: z.string().optional(),
  text: z.string(),
  createdAt: z.number(),
  order: z.enum(["before", "after"]),
});

const sceneMemorySchema = z.object({
  id: z.string(),
  roomId: z.string(),
  worldId: z.string().optional(),
  origin: z.literal("scene"),
  text: z.string(),
  createdAt: z.number(),
});

/** 完整会话形状；zod 在文件边界解析一次，之后是强类型（AGENTS.md §6） */
const sessionSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  participants: z.array(z.string()),
  phase: z.enum(["speaking", "listening"]),
  turn: z.number().int().nonnegative(),
  maxTurns: z.number().int().positive(),
  status: z.enum(["open", "closed"]),
  speaking: z.string().optional(),
  queue: z.array(utteranceSchema),
  injected: z.array(utteranceSchema),
  sceneBeats: z.array(sceneBeatSchema),
  sceneMemory: sceneMemorySchema.optional(),
  npcSpeechStreak: z.number().int().nonnegative(),
  listenSince: z.number().optional(),
  lastLocId: z.string().optional(),
  visibility: z.enum(["private", "scene", "public"]),
});

export const conversationSnapshotSchema = z.object({
  version: z.literal(1),
  savedAt: z.number().optional(),
  sessions: z.array(sessionSchema),
  // #123 P1-1：会话宿主的幂等缓存也要跨重启；否则同一 clientTurnId 重试会被当新回合重新结算。
  // 键与事件都由引擎自身写出，读回时按 ConversationEvent 使用（内部投影，不做逐事件 zod 展开）。
  idempotency: z.array(z.object({ key: z.string(), events: z.array(z.unknown()) })).optional(),
});

export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;

export interface RestoreResult {
  restored: number;
  /** true = 快照缺失/坏档/版本不符，已降级：旧会话 closed，改由调用方 open() 新会话 */
  degraded: boolean;
  sessions: string[];
}

export type LoadSnapshotResult =
  | { ok: true; snapshot: ConversationSnapshot }
  | { ok: false; reason: "missing" | "unreadable" | "invalid" | "bad-version" };

const SAFE_ROOM = /^[A-Za-z0-9_-]{1,80}$/;

/** 快照落点：data/rooms/<roomId>/conversation-sessions.json；roomId 做白名单防目录穿越 */
export function sessionSnapshotPath(dataDir: string, roomId: string): string {
  if (!SAFE_ROOM.test(roomId)) throw Object.assign(new Error("illegal roomId"), { code: "E_SCHEMA_INVALID" });
  return path.join(dataDir, "rooms", roomId, "conversation-sessions.json");
}

/** 读文件 + zod 校验；任何失败都返回降级原因，不抛给调用方（fail-soft，不拖垮启动） */
export async function loadSnapshot(filePath: string): Promise<LoadSnapshotResult> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ENOENT" ? "missing" : "unreadable" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const parsed = conversationSnapshotSchema.safeParse(raw);
  if (parsed.success) return { ok: true, snapshot: parsed.data };
  const version = typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).version : undefined;
  return { ok: false, reason: version !== undefined && version !== 1 ? "bad-version" : "invalid" };
}

/**
 * 原子落盘（tmp + rename）：写一半崩了也不会留下半份快照。
 * #106：tmp 名带 pid + 随机后缀，避免同一房间并发保存（或崩溃残留的 .tmp）互相覆盖。
 */
export async function saveSnapshot(filePath: string, snapshot: ConversationSnapshot): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  await writeFile(tmp, JSON.stringify(snapshot), "utf8");
  await rename(tmp, filePath);
}
