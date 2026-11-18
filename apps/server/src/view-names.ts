/**
 * 视图层的"认识"判定（一级口径：**知道名字才算认识**，见 docs/06 §7）。
 *
 * 状态只有一个布尔属性 `knows_name`（content/registry/attrs.json 声明，npc 作用域）：
 * - 未被认识时，地图/对话/图鉴一律显示占位名，不得下发真名；
 * - 占位名按实体 id 排序给序号（一位/另一位/第三位…），避免同场多个陌生人全叫
 *   「一位陌生的同学」导致分不清谁在说话；
 * - 玩家在对话里问名字/对方自报姓名后，服务端把他的 `knows_name` 置 true 并写记忆。
 */
import type { Entity, Store, WorldState } from "../../../packages/shared/src/contract/types.ts";

/** 第一个未认识的人 */
export const UNKNOWN_NPC_NAME = "一位陌生的同学";
const ORDINALS = ["一位", "另一位", "第三位", "第四位", "第五位", "第六位", "第七位", "第八位"] as const;

/**
 * 认识标记的属性键。视图层直接按 key 读注册表属性属于已知耦合（与地图坐标键同类），
 * 已在 docs/06 §7 记录；若以后把知识状态升格为 link/registry 视图，这里一并替换。
 */
const KNOWS_NAME_ATTR = "knows_name";

export function knowsNameOf(entity: Entity): boolean {
  return entity.attrs[KNOWS_NAME_ATTR] === true;
}

/** 未认识 NPC 的真名 → 占位名（外貌描述优先，缺省按实体 id 排序给序号） */
export function unknownPlaceholders(state: WorldState, appearance?: Map<string, string>): Map<string, string> {
  const unknown = Object.values(state.entities)
    .filter((e) => e.kind === "npc" && !knowsNameOf(e) && e.name.trim() !== "")
    .sort((a, b) => a.id.localeCompare(b.id));
  const map = new Map<string, string>();
  unknown.forEach((npc, i) => {
    const look = appearance?.get(npc.id)?.trim();
    if (look) {
      map.set(npc.name, look);
      return;
    }
    const ordinal = ORDINALS[i] ?? `第${i + 1}位`;
    map.set(npc.name, `${ordinal}陌生的同学`);
  });
  return map;
}

/** 对外展示名：知道名字给真名，否则给占位名（有 state 时用带序号的占位名） */
export function displayNameOf(entity: Entity, placeholders?: Map<string, string>): string {
  if (knowsNameOf(entity)) return entity.name;
  return placeholders?.get(entity.name) ?? UNKNOWN_NPC_NAME;
}

/** 把一句文本里出现的未认识 NPC 真名替换成占位名（模型会把名字写进台词/叙事） */
export function maskNamesInText(text: string, placeholders: Map<string, string>): string {
  let out = text;
  // 按名字长度降序替换：否则"白晓"与"白晓通"这类前缀相同的名字会互相污染
  const entries = [...placeholders.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [name, placeholder] of entries) out = out.split(name).join(placeholder);
  return out;
}

/**
 * 递归脱敏一个事件 payload：turn.patch / turn.delta / turn.facts 里任何字符串都可能带真名
 * （"严守一：嗯？…"、"【世界印象】严守一记住了你"）。只替换字符串，结构不动。
 */
export function maskNamesDeep<T>(value: T, placeholders: Map<string, string>): T {
  if (placeholders.size === 0) return value;
  if (typeof value === "string") return maskNamesInText(value, placeholders) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => maskNamesDeep(v, placeholders)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskNamesDeep(v, placeholders);
    return out as unknown as T;
  }
  return value;
}

/**
 * 出站视图负载的统一脱敏出口（issue #53）：snapshot → unknownPlaceholders → maskNamesDeep。
 *
 * /turns(SSE)、/events、/state、/history 各自内联了这三步；地图 travel/tick 原先直接回传
 * turn.run / arbiter.apply 的 events，绕过这层就会泄露未认识 NPC 真名。统一走这里，避免
 * 掩码规则在调用点重复实现而与一级认识口径漂移。
 *
 * 泛型 T 允许传单条事件、事件数组，或 travel/tick 的整个结果对象（把 moved 摘要、scene
 * 台词里的真名一并遮掉）；state 可选，调用方已取过快照时传入可省一次事件日志回放。
 */
export async function maskTurnEvents<T>(
  roomId: string,
  payload: T,
  store: Pick<Store, "snapshot">,
  appearance?: Map<string, string>,
  state?: WorldState,
): Promise<T> {
  const base = state ?? (await store.snapshot(roomId));
  return maskNamesDeep(payload, unknownPlaceholders(base, appearance));
}
