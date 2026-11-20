/**
 * 数字键快选（1–6）的「该不该响应」纯判定（PR #127 评审 P1）。
 *
 * 为什么抽成纯函数：这个判定要在不给项目引 jsdom 的前提下测（vitest 环境是 node），
 * 而它恰恰是 P1 的根因所在——全屏地图遮罩打开时 ChatPanel 仍挂载、候选仍非空，
 * 旧实现只排除表单元素与 busy/无状态，于是数字键穿透遮罩真的发出了回合。
 * 现在「遮罩打开」是这里的第一道门，ChatPanel 的 keydown 只负责取字段与转发。
 *
 * 这些都是**展示层的输入路由**，不碰服务端契约，也不改变任何 View/提案语义。
 */

/** 判定只需要这几个字段：测试里直接构造对象，不用造整个 KeyboardEvent */
export interface CandidateKeyEventLike {
  /** KeyboardEvent.key：数字键是 "1"…"9"，这里只认整数 1..count */
  key: string;
  /** 长按产生的重复事件：不响应，否则按住 1 会连发 */
  repeat?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

export interface CandidateKeyGate {
  /** 全屏遮罩（地图）是否打开：遮罩里数字键属于遮罩，不能穿透去发候选行动 */
  overlayOpen: boolean;
  /** 回合进行中（由 ChatPanel 用 ref 传最新值，避免同帧闭包读到旧 busy 而连发） */
  busy: boolean;
  /** 权威状态是否就绪：没连上/没进房时按了也没意义 */
  ready: boolean;
  /** 候选条数：只响应 1..count 的数字键 */
  count: number;
  /** 事件目标的 tagName：输入框/文本域/下拉框里数字键留给玩家打字/选项跳转 */
  targetTag?: string | null;
  /** 事件目标是否 contenteditable（富文本/可编辑区域也不抢键） */
  targetIsContentEditable?: boolean;
}

/**
 * 不抢数字键的表单元素。
 *
 * 为什么 select 也在内：v2 的说话方式 `<select>` 用数字键做选项首字母跳转，
 * 候选行动是替代鼠标的快捷方式，不该反过来抢走原生控件的行为。
 */
const FORM_TAGS: ReadonlySet<string> = new Set(["input", "textarea", "select"]);

/**
 * 返回要执行第几个候选（1 基，可直接用作 candidates[index - 1]）；
 * null = 这次按键不归候选面板管，调用方不要 preventDefault、不要发行动。
 */
export function candidateKeyIndex(event: CandidateKeyEventLike, gate: CandidateKeyGate): number | null {
  // 遮罩优先：遮罩打开时键盘焦点在遮罩里，任何情况都不穿透
  if (gate.overlayOpen) return null;
  // 长按 repeat 忽略：一次按下只发一次
  if (event.repeat) return null;
  // 带修饰键的组合键多半是浏览器/系统快捷键，不是快选
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  // 正在表单/可编辑元素里操作：数字键属于输入，不属于候选
  if (gate.targetIsContentEditable) return null;
  const tag = gate.targetTag?.toLowerCase();
  if (tag && FORM_TAGS.has(tag)) return null;
  // 回合进行中 / 权威状态未就绪：候选面板本身也禁点，键盘保持一致
  if (gate.busy || !gate.ready) return null;
  const n = Number(event.key);
  if (!Number.isInteger(n) || n < 1 || n > gate.count) return null;
  return n;
}

/** 只关心「要不要拦这个键」时的便捷包装（测试与潜在调用方都更直白） */
export function shouldHandleCandidateKey(event: CandidateKeyEventLike, gate: CandidateKeyGate): boolean {
  return candidateKeyIndex(event, gate) !== null;
}
