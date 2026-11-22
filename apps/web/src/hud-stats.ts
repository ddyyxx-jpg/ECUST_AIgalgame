/** 右上角状态条：按显示名把“行动点”提到最前，其余保持 registry 顺序。 */
export interface HudStatRow {
  key?: string;
  label: string;
  value: unknown;
  unit?: string;
}

export function hudStats(rows: HudStatRow[], limit = 5): HudStatRow[] {
  const action = rows.find((r) => r.key === "action_points") ?? rows.find((r) => r.label === "行动点");
  const ordered = action ? [action, ...rows.filter((r) => r !== action)] : rows;
  return ordered.slice(0, limit);
}
