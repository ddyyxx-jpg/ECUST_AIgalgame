/**
 * 命名槽端点（issue #98，docs/03 §5.2.7 已登记）：GET/POST/PUT/DELETE
 * /api/v1/me/saves/slots。独立文件避免 routes.ts 进一步膨胀；只操作 SaveIndex
 * 的槽映射（索引投影），绝不写 data/rooms/*.jsonl（I1）、不新增 op/事件。
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppDeps } from "./routes.ts";
import type { ResumeRouteHelpers } from "./resume.routes.ts";

const SLOT_ERROR_STATUS: Record<string, number> = {
  E_SCHEMA_INVALID: 400,
  E_REF_NOT_FOUND: 404,
  E_ID_TAKEN: 409,
  E_OVER_LIMIT: 409,
};

export function registerSlotsRoutes(app: FastifyInstance, deps: AppDeps, helpers: ResumeRouteHelpers): void {
  const { userIdOf } = helpers;
  const missingUser = (reply: FastifyReply) =>
    reply.code(400).send({ ok: false, code: "E_SCHEMA_INVALID", message: "缺少 X-User-Id（或 GALGAME_DEV_USER）" });

  app.get("/api/v1/me/saves/slots", async (req, reply) => {
    const userId = userIdOf(req, deps);
    if (!userId) return missingUser(reply);
    const slots = deps.saves ? await deps.saves.listSlots(userId) : [];
    return { ok: true, userId, slots };
  });

  app.post("/api/v1/me/saves/slots", async (req, reply) => {
    const userId = userIdOf(req, deps);
    if (!userId) return missingUser(reply);
    const body = req.body as { label?: unknown; roomId?: unknown; slotId?: unknown };
    if (typeof body?.label !== "string" || typeof body?.roomId !== "string" ||
        (body.slotId !== undefined && typeof body.slotId !== "string")) {
      return reply.code(400).send({ ok: false, code: "E_SCHEMA_INVALID", message: "label / roomId 必填" });
    }
    const result = deps.saves
      ? await deps.saves.putSlot(userId, {
          label: body.label, roomId: body.roomId, createOnly: true,
          ...(body.slotId !== undefined ? { slotId: body.slotId as string } : {}),
        })
      : { ok: false as const, code: "E_STORE_FAULT" as const };
    if (!result.ok) {
      return reply.code(SLOT_ERROR_STATUS[result.code] ?? 400)
        .send({ ok: false, code: result.code, message: "槽位操作失败" });
    }
    return reply.code(201).send({ ok: true, slot: result.value });
  });

  app.put("/api/v1/me/saves/slots/:slotId", async (req, reply) => {
    const userId = userIdOf(req, deps);
    if (!userId) return missingUser(reply);
    const { slotId } = req.params as { slotId?: string };
    const current = deps.saves ? (await deps.saves.listSlots(userId)).find((s) => s.slotId === slotId) : undefined;
    if (!current) {
      return reply.code(404).send({ ok: false, code: "E_REF_NOT_FOUND", message: "槽不存在" });
    }
    const body = req.body as { label?: unknown; roomId?: unknown };
    if ((body?.label === undefined && body?.roomId === undefined) ||
        (body.label !== undefined && typeof body.label !== "string") ||
        (body.roomId !== undefined && typeof body.roomId !== "string")) {
      return reply.code(400).send({ ok: false, code: "E_SCHEMA_INVALID", message: "label / roomId 至少一项" });
    }
    const result = deps.saves ? await deps.saves.putSlot(userId, {
      slotId: current.slotId,
      label: typeof body.label === "string" ? body.label : current.label,
      roomId: typeof body.roomId === "string" ? body.roomId : current.roomId,
    }) : { ok: false as const, code: "E_REF_NOT_FOUND" as const };
    if (!result.ok) {
      return reply.code(SLOT_ERROR_STATUS[result.code] ?? 400)
        .send({ ok: false, code: result.code, message: "槽位更新失败" });
    }
    return { ok: true, slot: result.value };
  });

  app.delete("/api/v1/me/saves/slots/:slotId", async (req, reply) => {
    const userId = userIdOf(req, deps);
    if (!userId) return missingUser(reply);
    const { slotId } = req.params as { slotId?: string };
    if (!slotId) return reply.code(400).send({ ok: false, code: "E_SCHEMA_INVALID", message: "slotId 必填" });
    const removed = deps.saves ? await deps.saves.deleteSlot(userId, slotId) : false;
    return { ok: true, slotId, removed };
  });
}
