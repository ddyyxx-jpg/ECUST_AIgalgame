/** 前端只做两件事：发行动、渲染服务端 View。不存权威状态。 */
import type {
  TurnEvent,
  WorldState,
  ViewPatch,
} from "../../../packages/shared/src/contract/types.ts";
import { apiFetch, GameError, httpErrorFrom, jsonHeaders, request, unwrap } from "./http.ts";
import { parseSsePart, splitSseBuffer } from "./sse.ts";

export type { GameClock, Phase } from "../../../packages/shared/src/contract/types.ts";
export { GameError } from "./http.ts";
/** 存档索引条目（UI 侧 DTO；与 apps/server/src/saves.ts 的 SaveEntry 同形，刻意不跨端 import） */
export interface SaveEntry {
  roomId: string;
  scenarioId: string;
  createdAt: number;
  updatedAt: number;
  lastTurnId: string;
  lastCommittedSeq: number;
  /** 建房时服务端签发的角色 id；3.3 之前的老存档没有，恢复时从房间成员表兜底 */
  actorId?: string;
  formatVersion: number;
  /** issue #98：命名槽归属（缺省 = 历史默认存档） */
  slotId?: string;
}

/** issue #98：账号内命名房间槽映射（服务端 SaveSlot 同形） */
export interface SaveSlot {
  slotId: string;
  label: string;
  roomId: string;
  createdAt: number;
  updatedAt: number;
}

/** 旧房间/旧存档的角色 id：只用于兼容，不在新流程里猜身份 */
export const LEGACY_ACTOR_ID = "plr_self";

/** 已提交回合历史行（UI 侧 DTO；服务端下发前已剥离 userId/clientTurnId） */
export interface HistoryLine {
  formatVersion: number;
  roomId: string;
  turnId: string;
  committedSeq: number;
  actorId: string;
  input: string;
  narrative: string;
  speakers: string[];
  facts: string[];
  createdAt: number;
}
// 地图 / 场景草案的 HTTP 层单独成文件（AGENTS.md §6：文件 ≤ 300 行），这里保持统一入口。
export * from "./api-map.ts";

export interface TurnStreamHandlers {
  onAccepted?: (turnId: string) => void;
  onDelta?: (field: "narrative" | "dialogue", text: string) => void;
  /** 模块给出的人话提示（"你走了 1 段路，来到一食堂。"）：不落库，只在本次流里出现 */
  onFacts?: (facts: string[]) => void;
  onPatch?: (state: WorldState, ops: unknown[]) => void;
  onUi?: (view: ViewPatch) => void;
  onCommit?: (seq: number) => void;
  onError?: (code: string, message: string, retryable?: boolean) => void;
  /** 流结束但没有 commit 也没有 error：结果待核对，重试前必须先查 fetchTurnStatus */
  onUnconfirmed?: (clientTurnId: string) => void;
}

/** @param signal 进房整体 deadline / 切房作废时中止底层 fetch；不传则保持旧行为 */
export async function fetchState(roomId: string, signal?: AbortSignal): Promise<WorldState> {
  const r = await apiFetch(`/api/v1/rooms/${roomId}/state`, signal ? { signal } : undefined);
  if (!r.ok) {
    if (r.status === 404) throw new GameError("E_ROOM_NOT_FOUND", "房间不存在或事件日志不可读");
    throw await httpErrorFrom(r, "state");
  }
  return (await r.json()) as WorldState;
}

export interface RoomSession {
  roomId: string;
  actorId: string;
}

export async function createSoloRoom(scenarioId?: string): Promise<RoomSession> {
  const r = await apiFetch(`/api/v1/rooms`, {
    method: "POST",
    headers: { ...jsonHeaders },
    body: JSON.stringify({ mode: "solo", ...(scenarioId ? { scenarioId } : {}) }),
  });
  if (!r.ok) throw await httpErrorFrom(r, "create room");
  const d = (await r.json()) as { roomId: string; actorId?: string };
  // 老服务端没有 actorId 时才回退；新服务端必须下发，客户端不再自己猜
  return { roomId: d.roomId, actorId: d.actorId || LEGACY_ACTOR_ID };
}

// ---------------------------------------------------------------- 存档 / 历史（issue #7）

/** 本人的存档索引；401/403/5xx 抛错交给 UI 区分"请先登录/无法加载"，只有真空列表才返回 [] */
export interface SavesPayload {
  saves: SaveEntry[];
  slots: SaveSlot[];
}

export async function fetchSaves(): Promise<SavesPayload> {
  const r = await apiFetch(`/api/v1/me/saves`);
  if (!r.ok) throw await httpErrorFrom(r, "saves");
  const d = (await r.json()) as { saves?: SaveEntry[]; slots?: SaveSlot[] };
  return {
    saves: Array.isArray(d.saves) ? d.saves : [],
    // 旧服务端没有 slots 字段 → 空数组，UI 不新增槽交互
    slots: Array.isArray(d.slots) ? d.slots : [],
  };
}

/** issue #98：列出 / 建 / 改 / 删命名槽；只操作索引映射，不碰房间数据 */
export async function fetchSlots(): Promise<SaveSlot[]> {
  const r = await apiFetch(`/api/v1/me/saves/slots`);
  if (!r.ok) throw await httpErrorFrom(r, "slots");
  const d = (await r.json()) as { slots?: SaveSlot[] };
  return Array.isArray(d.slots) ? d.slots : [];
}

export async function createSlot(label: string, roomId: string, slotId?: string): Promise<SaveSlot> {
  const r = await apiFetch(`/api/v1/me/saves/slots`, {
    method: "POST",
    ...jsonHeaders,
    body: JSON.stringify({ label, roomId, ...(slotId ? { slotId } : {}) }),
  });
  if (!r.ok) throw await httpErrorFrom(r, "create slot");
  return ((await r.json()) as { slot: SaveSlot }).slot;
}

export async function updateSlot(slotId: string, patch: { label?: string; roomId?: string }): Promise<SaveSlot> {
  const r = await apiFetch(`/api/v1/me/saves/slots/${slotId}`, {
    method: "PUT",
    ...jsonHeaders,
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw await httpErrorFrom(r, "update slot");
  return ((await r.json()) as { slot: SaveSlot }).slot;
}

export async function deleteSlot(slotId: string): Promise<boolean> {
  const r = await apiFetch(`/api/v1/me/saves/slots/${slotId}`, { method: "DELETE" });
  if (!r.ok) throw await httpErrorFrom(r, "delete slot");
  return ((await r.json()) as { removed?: boolean }).removed === true;
}

/** 只删索引（房间与历史保留）；返回服务端是否真的删掉了一条 */
export async function deleteSave(roomId: string): Promise<boolean> {
  const r = await apiFetch(`/api/v1/me/saves/${roomId}`, { method: "DELETE" });
  if (!r.ok) throw await httpErrorFrom(r, "delete save");
  const d = (await r.json()) as { removed?: boolean };
  return d.removed === true;
}

export interface HistoryCursor {
  match?: Pick<HistoryLine, "turnId" | "actorId">;
  /** turnId 或 committedSeq：向前翻页 */
  fromTurn?: string;
  /** 服务端记录游标或旧版 committedSeq：加载更早的一段 */
  before?: string | number;
  limit?: number;
}

export interface HistoryPage {
  history: HistoryLine[];
  lastCommittedSeq: number;
  hasEarlier: boolean;
  earlierCursor?: string;
}

/** 游标 → query string（纯函数）：无游标 = 服务端返回最近 limit 条（tail） */
export function buildHistoryQuery(cursor: HistoryCursor = {}): string {
  const q = new URLSearchParams({ limit: String(cursor.limit ?? 200) });
  if (cursor.match) {
    q.set("turnId", cursor.match.turnId);
    q.set("actorId", cursor.match.actorId);
    return q.toString();
  }
  if (cursor.fromTurn) q.set("fromTurn", cursor.fromTurn);
  if (cursor.before !== undefined) q.set("before", String(cursor.before));
  return q.toString();
}

/** 已提交回合历史：默认恢复最新片段；`before` 向更早翻页（docs/03 §5.2.9）
 *  @param signal 与 fetchState 共享进房 deadline，避免历史请求半开挂住 busy */
export async function fetchHistory(roomId: string, cursor: HistoryCursor = {}, signal?: AbortSignal): Promise<HistoryPage> {
  const r = await apiFetch(`/api/v1/rooms/${roomId}/history?${buildHistoryQuery(cursor)}`, signal ? { signal } : undefined);
  if (r.status === 404) throw new GameError("E_ROOM_NOT_FOUND", "房间不存在或没有可恢复的历史");
  if (!r.ok) throw await httpErrorFrom(r, "history");
  const d = (await r.json()) as Partial<HistoryPage> & { history?: HistoryLine[] };
  return {
    history: Array.isArray(d.history) ? d.history : [],
    lastCommittedSeq: typeof d.lastCommittedSeq === "number" ? d.lastCommittedSeq : 0,
    hasEarlier: d.hasEarlier === true,
    earlierCursor: typeof d.earlierCursor === "string" ? d.earlierCursor : undefined,
  };
}

// ---------------------------------------------------------------- 回合（SSE + 核对）

export type TurnConfirmState = "reserved" | "running" | "committed" | "failed" | "unconfirmed";

export interface TurnStatus {
  state: TurnConfirmState;
  turnId?: string;
  committedSeq?: number;
}

/** 行动核对（docs/03 §5.2.10）：未确认回合重试前先查结果；未知 id 抛 E_REF_NOT_FOUND */
export async function fetchTurnStatus(roomId: string, clientTurnId: string): Promise<TurnStatus> {
  const res = await request<TurnStatus>(
    "turn status",
    `/api/v1/rooms/${roomId}/turns/${encodeURIComponent(clientTurnId)}`,
  );
  return unwrap(res);
}

/** POST + 读 SSE：一个回合一条流；EOF 无 commit/error → onUnconfirmed（不盲目重发） */
export async function runTurn(
  roomId: string,
  actorId: string,
  input: string,
  clientTurnId: string,
  h: TurnStreamHandlers,
  signal?: AbortSignal,
  /** 这次行动在跟哪个 NPC 说话（可选）：服务端据此在提示词里换成真名，并决定"问名字后解锁谁" */
  targetNpcId?: string,
): Promise<void> {
  const r = await apiFetch(`/api/v1/rooms/${roomId}/turns`, {
    method: "POST",
    headers: { ...jsonHeaders, accept: "text/event-stream" },
    body: JSON.stringify({ actorId, input, clientTurnId, ...(targetNpcId ? { targetNpcId } : {}) }),
    ...(signal ? { signal } : {}),
  });
  if (!r.ok || !r.body) {
    // 429/409 等拒绝是普通 HTTP 响应：带上服务端错误码（E_RATE_LIMITED/E_PRECONDITION…）
    const err = await httpErrorFrom(r, "turn");
    h.onError?.(err.code ?? `HTTP_${err.status}`, err.message);
    return;
  }
  let settled = false;
  const tracked: TurnStreamHandlers = {
    ...h,
    onCommit: (seq) => { settled = true; h.onCommit?.(seq); },
    onError: (code, message, retryable) => { settled = true; h.onError?.(code, message, retryable); },
  };
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const { parts, rest } = splitSseBuffer(buf);
      buf = rest;
      for (const part of parts) {
        const parsed = parseSsePart(part);
        if (!parsed) continue;
        dispatch(JSON.parse(parsed.data) as TurnEvent, parsed.event, tracked);
      }
    }
  } catch {
    // 中途断流：已有结论就忽略；主动中止 = 调用方已切房间；否则结果待核对
    if (settled || signal?.aborted) return;
    h.onUnconfirmed?.(clientTurnId);
    return;
  }
  if (!settled) h.onUnconfirmed?.(clientTurnId);
}

function dispatch(ev: TurnEvent, _event: string, h: TurnStreamHandlers): void {
  switch (ev.type) {
    case "turn.accepted": h.onAccepted?.(ev.turnId); break;
    case "turn.delta": h.onDelta?.(ev.field, ev.text); break;
    case "turn.facts": h.onFacts?.(ev.facts); break;
    case "turn.patch": h.onPatch?.(ev.state, ev.ops); break;
    case "turn.ui": h.onUi?.(ev.view); break;
    case "turn.commit": h.onCommit?.(ev.seq); break;
    case "turn.error":
    case "turn.rejected": h.onError?.(ev.code, ev.message, ev.retryable); break;
    default: break;
  }
}
