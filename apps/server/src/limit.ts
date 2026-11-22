/**
 * 单次响应的 limit 统一边界（PR #123 P2）：Number.isFinite + 向下取整 + 夹到 [1,max]。
 * /history 与 /events 共用，避免一处 clamp 了另一处没有、NaN/负数/小数各自为政。
 */
export function clampLimit(raw: unknown, max: number, fallback = max): number {
  const upper = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 200;
  const safeFallback = Math.min(upper, Math.max(1, Math.floor(Number.isFinite(fallback) ? fallback : upper)));
  if (raw === undefined || raw === null) return safeFallback;
  // 纯空白串视为空值（Number("   ") 会静默变成 0，不该被夹成 1）
  const value = typeof raw === "string" && raw.trim() === ""
    ? Number.NaN
    : (typeof raw === "number" ? raw : Number(raw));
  if (!Number.isFinite(value)) return safeFallback;
  return Math.min(upper, Math.max(1, Math.floor(value)));
}
