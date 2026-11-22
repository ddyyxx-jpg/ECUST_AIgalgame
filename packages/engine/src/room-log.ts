import { z } from "zod";
import type { Envelope, WorldState } from "../../shared/src/contract/types.ts";
import {
  AttrValueSchema, EntityKindSchema, EntityStatusSchema, GameClockSchema, LinkKindSchema, OriginSchema,
} from "../../shared/src/zod/entity.ts";
import { applyEvent } from "./projection.ts";

// 存档包含引擎生成的复合 ID 及已经裁决的结果。传输层的长度和数量上限
// 不能用于重读历史，否则写入端能成功提交读回端无法打开的日志。
const id = z.string().min(1);
const ids = z.array(id);
const strings = z.array(z.string());
const time = z.number().finite();
const envelopeSchema = z.object({
  v: z.literal(1),
  id,
  roomId: id,
  seq: z.number().int().positive().safe(),
  ts: time,
  actorId: id,
  type: z.string().min(1),
  payload: z.unknown(),
  causedBy: id.optional(),
  audience: strings.optional(),
});
const entity = z.object({
  id, kind: EntityKindSchema, name: z.string(), attrs: z.record(AttrValueSchema),
  tags: strings, origin: OriginSchema, canon: z.boolean(), status: EntityStatusSchema,
  createdAt: time, updatedAt: time, createdBy: id.optional(), tombstonedAt: time.optional(),
});
const link = z.object({
  id, kind: LinkKindSchema, from: id, to: id, audience: strings.optional(),
  weight: z.number().finite().optional(), createdAt: time, updatedAt: time.optional(),
});
const plot = z.object({
  id, goal: z.string(), actors: ids, status: z.enum(["active", "dormant", "resolved", "leaked"]),
  leverage: z.string().optional(), risk: z.number().finite().optional(), tone: z.string().optional(),
  leakPoints: strings.optional(), forbidReveal: z.string().optional(),
  guard: z.record(z.number().finite()).optional(), createdDay: time.optional(),
});
const member = z.object({
  actorId: id, role: z.enum(["player", "npc", "spectator"]),
  joinedSeq: time, online: z.boolean().optional(), userId: id.optional(),
});

const messagePayloadSchema = z.object({
  message: z.object({
    id, roomId: id, from: id, to: id,
    kind: z.string(), content: z.string(),
    rootId: id.optional(), replyTo: id.optional(),
    hop: z.number().finite(), confidence: z.number().finite(), createdAt: time, seq: time,
  }),
});

const payloadSchemas = new Map<string, z.ZodTypeAny>([
  ["attr.changed", z.object({ entityId: id, key: z.string(), to: AttrValueSchema })],
  ["entity.created", z.object({ entity })],
  ["entity.updated", z.object({ entity })],
  ["entity.tombstoned", z.object({ entityId: id, at: time })],
  ["link.created", z.object({ link })],
  ["link.removed", z.object({ linkId: id })],
  ["actor.moved", z.object({ actorId: id, to: id })],
  ["clock.advanced", z.object({ clock: GameClockSchema })],
  ["scene.changed", z.object({ locId: id, presentIds: ids, props: strings.optional() })],
  ["plot.upserted", z.object({ plot })],
  ["room.member.joined", z.object({ member })],
  ["room.member.left", z.object({ actorId: id })],
]);

export class RoomLogError extends Error {
  readonly code = "E_STORE_FAULT";
}

function validatePayload(envelope: Envelope, location: string): void {
  if (envelope.type === "msg.sent") {
    const parsed = messagePayloadSchema.safeParse(envelope.payload);
    if (!parsed.success || parsed.data.message.roomId !== envelope.roomId) {
      throw new RoomLogError(`${location}：私信负载或房间归属无效`);
    }
    return;
  }
  const payload = payloadSchemas.get(envelope.type);
  if (payload && !payload.safeParse(envelope.payload).success) {
    throw new RoomLogError(`${location}：${envelope.type} 负载无效`);
  }
}

export function decodeRoomLog(text: string, roomId?: string): Envelope[] {
  const events: Envelope[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    const location = `房间 ${roomId ?? "未知"} 第 ${index + 1} 行`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new RoomLogError(`${location}：无效 JSON`);
    }
    const parsed = envelopeSchema.safeParse(value);
    if (!parsed.success || !Object.hasOwn(parsed.data, "payload")) {
      throw new RoomLogError(`${location}：事件结构无效`);
    }
    const envelope = value as Envelope;
    roomId ??= envelope.roomId;
    if (envelope.roomId !== roomId) throw new RoomLogError(`${location}：事件房间不匹配`);
    const expected = events.length + 1;
    if (envelope.seq !== expected) {
      throw new RoomLogError(`${location}：期望 seq=${expected}，实际 seq=${envelope.seq}`);
    }
    validatePayload(envelope, location);
    events.push(envelope);
  }
  return events;
}

export function projectRoomEvents(
  state: WorldState, events: readonly Envelope[], through = Number.POSITIVE_INFINITY,
): WorldState {
  for (const event of events) {
    if (event.seq > through) break;
    try {
      state = applyEvent(state, event);
    } catch (cause) {
      throw new RoomLogError(`房间 ${event.roomId} seq=${event.seq}：${event.type} 无法投影`, { cause });
    }
  }
  return state;
}
