/** SSE 字节缓冲 → 事件块：纯函数，与 fetch/React 解耦，便于单测。 */

/** 按空行切出完整事件块；最后一段可能不完整，留回缓冲 */
export function splitSseBuffer(buf: string): { parts: string[]; rest: string } {
  const parts = buf.split("\n\n");
  const rest = parts.pop() ?? "";
  return { parts, rest };
}

/** 解析一个事件块的 event/data 行；没有 data 的块（注释/心跳）返回 null */
export function parseSsePart(part: string): { event: string; data: string } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of part.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}