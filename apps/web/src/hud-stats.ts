/** 右上角状态条：把“行动点”提到最前（优先 key，旧服务端退回中文 label），其余保持 registry 顺序。 */
export interface HudStatRow {
  key?: string;
  label: string;
  value: unknown;
  unit?: string;
}

/** 行动点行：新服务端带 key，旧服务端只有中文 label；两处出口都按同一判定隐藏/置顶。 */
export function isActionPointRow(row: HudStatRow): boolean {
  return row.key === "action_points" || row.label === "行动点";
}

export function hudStats(rows: HudStatRow[], limit = 5): HudStatRow[] {
  const action = rows.find(isActionPointRow);
  const ordered = action ? [action, ...rows.filter((r) => r !== action)] : rows;
  return ordered.slice(0, limit);
}
