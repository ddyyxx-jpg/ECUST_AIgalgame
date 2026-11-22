/**
 * 会话装载/断流超时：AbortError 与 TypeError 在浏览器里都可能长得像"网络断了"，
 * 先用这个守卫判一次，UI 才能给出"超时，请重试"而不是含糊的连接失败。
 */
export function isTimeoutError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.name === "TimeoutError" ||
      (e.name === "AbortError" && (e as { timedOut?: boolean }).timedOut === true))
  );
}
