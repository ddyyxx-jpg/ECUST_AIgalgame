/** 历史恢复的纯函数：历史行 → 对话流行、"加载更早"游标（不碰 React/网络，便于单测）。 */
import type { HistoryLine } from "./api.ts";
import type { Scenario } from "./scenarios.ts";
import type { TypeItem } from "./typewriter.ts";
import type { Line, LineKind } from "./ui.ts";

/** 玩家输入 / 叙事 / facts 各占一行；空白文本跳过（历史是投影，不重播序章） */
export function historyToLines(history: HistoryLine[], nextId: () => number): Line[] {
  const lines: Line[] = [];
  for (const h of history) {
    if (h.input.trim()) lines.push({ id: nextId(), kind: "player", text: h.input });
    if (h.narrative.trim()) lines.push({ id: nextId(), kind: "narrative", text: h.narrative });
    for (const f of h.facts) if (f.trim()) lines.push({ id: nextId(), kind: "fact", text: f });
  }
  return lines;
}

/** "加载更早"的 before 游标 = 已加载段第一行的 committedSeq；没有行则 null */
export function earlierCursor(history: HistoryLine[]): number | null {
  return history.length > 0 ? history[0].committedSeq : null;
}

export interface ReceivedTurnContent {
  narrative: string;
  facts: string[];
}

/**
 * 断流后核对到 committed 时，补齐该回合历史里尚未收到的叙事/facts。
 * 只补差集：断流前已经展示过的前缀不再重复刷一遍。
 */
export function missingTurnContent(
  line: Pick<HistoryLine, "narrative" | "facts">,
  received: ReceivedTurnContent,
): { narrative: string; facts: string[] } {
  const narrative =
    received.narrative === ""
      ? line.narrative
      : line.narrative.startsWith(received.narrative)
        ? line.narrative.slice(received.narrative.length)
        : ""; // 收到的内容不是历史前缀（异常/错位）时不冒险重复追加
  const remaining = [...line.facts];
  for (const fact of received.facts) {
    const index = remaining.indexOf(fact);
    if (index >= 0) remaining.splice(index, 1);
  }
  return { narrative, facts: remaining };
}

export interface RestoredConversation {
  /** 有历史时直接铺出的对话行（含"继续上次"提示） */
  lines: Line[];
  /** 无历史时走打字机的开场（序章 / 无预设开局提示） */
  opening: TypeItem[];
}

/** 进房首屏投影：有历史重放最近片段，没有则退回序章（不在前端推演世界） */
export function restoreConversation(
  history: HistoryLine[],
  sc: Scenario | null,
  resumed: boolean,
  nextId: () => number,
): RestoredConversation {
  if (history.length > 0) {
    return {
      lines: [
        {
          id: nextId(),
          kind: "system",
          text: `继续上次${sc ? ` · ${sc.name} · ${sc.role}` : ""}（已恢复最近 ${history.length} 个回合）`,
        },
        ...historyToLines(history, nextId),
      ],
      opening: [],
    };
  }
  const opening: TypeItem[] = sc
    ? [
        { kind: "system", text: `序章 · ${sc.name} · ${sc.role}` },
        ...sc.opening.map((text) => ({ kind: "narrative" as LineKind, text })),
      ]
    : [{ kind: "system", text: "无预设开局（服务端 /api/v1/scenarios 不可用），直接开始吧。" }];
  if (resumed) {
    opening.push({ kind: "system", text: "（世界状态已从事件日志恢复；本局对话历史从这次继续开始记录）" });
  }
  return { lines: [], opening };
}