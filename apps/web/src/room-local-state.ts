/**
 * 进房时「本地 UI 状态保留规则」的纯逻辑。
 *
 * 为什么单拎出来（PR #126 三轮复审必做 2）：草稿与 convMode 的保留判断原先散在
 * App.enterRoom 的 capture/restore 闭包里，测试只能看到泛型搬运——把保留分支删掉
 * 也全绿。抽成纯函数后，「同房间前台恢复才保留、换房/新开局清空」有了会红的断言。
 *
 * PR #149 P2-1：v2 的 convLines 也走同一判定——同一房间 resumed 时不能被 reset 清掉。
 */
import type { Line } from "./ui.ts";

export type ConvMode = "v1" | "v2";

/** 可测试的同房判定：同一房间的前台恢复才保留本地 UI 状态（草稿/convMode/convLines） */
export function shouldKeepRoomUi(input: Pick<RoomLocalStateInput, "resumed" | "targetRoomId" | "currentRoomId">): boolean {
  return input.resumed && input.targetRoomId === (input.currentRoomId ?? "");
}

/** reset 之前捕获、restore 时回填的本地状态 */
export interface RoomLocalState {
  draft: string;
  convMode: ConvMode;
  /** reset 前捕获的 v2 会话渲染行；只在 shouldKeepRoomUi 时非 null */
  convLines: Line[] | null;
  /** true = 沿用了旧界面状态；false 时 draft/convMode 必为默认值 */
  preserved: boolean;
}

export interface RoomLocalStateInput {
  /** 是否前台恢复触发的重进房（普通进房/换房/新开局传 false） */
  resumed: boolean;
  targetRoomId: string;
  /** 当前界面显示的房间；未进房为 null 或 "" */
  currentRoomId: string | null;
  currentDraft: string;
  currentConvMode: ConvMode;
  /** v2 会话行：reset 前从 convLines state/ref 读取，只有 preserved 时才回填 */
  currentConvLines?: Line[] | null;
}

const CLEARED: RoomLocalState = { draft: "", convMode: "v1", convLines: null, preserved: false };

/**
 * 只有「同房间的前台恢复」才保留草稿与 convMode：
 * - 草稿只属于写它的那个房间，换房/新开局不能把上一房间的字带过去；
 * - 保留 convMode 是为了不把已探测的 v2 在 reset 后、重新探测前误走 v1 回合。
 */
export function keepRoomLocalState(input: RoomLocalStateInput): RoomLocalState {
  if (!shouldKeepRoomUi(input)) return { ...CLEARED };
  return {
    draft: input.currentDraft,
    convMode: input.currentConvMode,
    convLines: input.currentConvLines ?? null,
    preserved: true,
  };
}

/** restore 阶段要做的 setState；null = 不改（resetRoomUi 已把默认值放好） */
export interface RoomLocalStateActions {
  input: string | null;
  convMode: ConvMode | null;
  /** v2 会话行；null = resetRoomUi 已清空，恢复流程不得重放开场 */
  convLines: Line[] | null;
}

export function restoreRoomLocalState(local: RoomLocalState): RoomLocalStateActions {
  if (!local.preserved) return { input: null, convMode: null, convLines: null };
  return {
    input: local.draft.length > 0 ? local.draft : null,
    convMode: local.convMode === "v2" ? "v2" : null,
    convLines: local.convLines,
  };
}

/**
 * 恢复后要不要重放开场白（PR #149 复审 P2-1）。
 *
 * v2 房间的回合不在 v1 history 里，`restoreConversation` 还原出来是空的——如果只看
 * `lines.length === 0` 就放开场白，每次切后台回来都会把「身份 → 正文」重放一遍。
 * 只要本地还留着 v2 会话行，就不是新开局。
 */
export function shouldReplayOpening(input: { restoredLineCount: number; keptConvLines: number }): boolean {
  return input.restoredLineCount === 0 && input.keptConvLines === 0;
}

/**
 * 已进行的玩家回合数（候选面板用）。
 *
 * v1 数 history 还原的玩家行；v2 数 convLines——前台恢复时 convView 会被 reset，
 * 但 convLines 被保留，数 convView 会让 playedTurns 归零、候选退回开局建议。
 */
export function playedTurnsOf(convMode: ConvMode, lines: readonly Line[], convLines: readonly Line[]): number {
  const source = convMode === "v2" ? convLines : lines;
  return source.filter((l) => l.kind === "player").length;
}
