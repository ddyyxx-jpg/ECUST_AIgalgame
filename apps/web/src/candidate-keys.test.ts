import { describe, expect, it } from "vitest";
import { candidateKeyIndex, shouldHandleCandidateKey } from "./candidate-keys.ts";
import type { CandidateKeyEventLike, CandidateKeyGate } from "./candidate-keys.ts";

/** 正常可响应的上下文；各用例只改自己关心的那一项 */
function gate(over: Partial<CandidateKeyGate> = {}): CandidateKeyGate {
  return { overlayOpen: false, busy: false, ready: true, count: 3, ...over };
}

function keyEvent(over: Partial<CandidateKeyEventLike> = {}): CandidateKeyEventLike {
  return { key: "2", ...over };
}

describe("candidateKeyIndex（数字键 1..count → 候选下标）", () => {
  it("正常：按键映射到 1 基下标", () => {
    expect(candidateKeyIndex(keyEvent({ key: "1" }), gate())).toBe(1);
    expect(candidateKeyIndex(keyEvent({ key: "2" }), gate())).toBe(2);
    expect(candidateKeyIndex(keyEvent({ key: "3" }), gate())).toBe(3);
    expect(shouldHandleCandidateKey(keyEvent({ key: "2" }), gate())).toBe(true);
  });

  it("P1：遮罩打开时不响应（防止数字键穿透地图遮罩真发回合）", () => {
    expect(candidateKeyIndex(keyEvent({ key: "1" }), gate({ overlayOpen: true }))).toBeNull();
    expect(shouldHandleCandidateKey(keyEvent({ key: "1" }), gate({ overlayOpen: true }))).toBe(false);
  });

  it("表单元素里不响应：INPUT / TEXTAREA / SELECT", () => {
    for (const targetTag of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(candidateKeyIndex(keyEvent({ key: "1" }), gate({ targetTag }))).toBeNull();
    }
    // tagName 大小写不该影响判定（真实 DOM 是 INPUT，手写配置可能是 input）
    expect(candidateKeyIndex(keyEvent({ key: "1" }), gate({ targetTag: "input" }))).toBeNull();
  });

  it("可编辑元素（contenteditable）里不响应", () => {
    expect(
      candidateKeyIndex(keyEvent({ key: "1" }), gate({ targetTag: "DIV", targetIsContentEditable: true })),
    ).toBeNull();
  });

  it("busy（回合进行中）不响应", () => {
    expect(candidateKeyIndex(keyEvent({ key: "1" }), gate({ busy: true }))).toBeNull();
  });

  it("权威状态未就绪不响应", () => {
    expect(candidateKeyIndex(keyEvent({ key: "1" }), gate({ ready: false }))).toBeNull();
  });

  it("长按 repeat 不响应（避免按住数字连发）", () => {
    expect(candidateKeyIndex(keyEvent({ repeat: true }), gate())).toBeNull();
    // repeat=false 与不传该字段都算普通按下
    expect(candidateKeyIndex(keyEvent({ repeat: false }), gate())).toBe(2);
  });

  it("带 meta/ctrl/alt 的组合键不响应", () => {
    expect(candidateKeyIndex(keyEvent({ metaKey: true }), gate())).toBeNull();
    expect(candidateKeyIndex(keyEvent({ ctrlKey: true }), gate())).toBeNull();
    expect(candidateKeyIndex(keyEvent({ altKey: true }), gate())).toBeNull();
  });

  it("不响应的键：非数字、0、超范围、空串", () => {
    expect(candidateKeyIndex(keyEvent({ key: "a" }), gate())).toBeNull();
    expect(candidateKeyIndex(keyEvent({ key: "Enter" }), gate())).toBeNull();
    expect(candidateKeyIndex(keyEvent({ key: "" }), gate())).toBeNull();
    expect(candidateKeyIndex(keyEvent({ key: "0" }), gate())).toBeNull();
    expect(candidateKeyIndex(keyEvent({ key: "4" }), gate({ count: 3 }))).toBeNull();
  });

  it("候选为空（count=0）时不响应", () => {
    expect(candidateKeyIndex(keyEvent({ key: "1" }), gate({ count: 0 }))).toBeNull();
  });

  it("边界：1 与 count 都响应，count+1 不响应", () => {
    expect(candidateKeyIndex(keyEvent({ key: "1" }), gate({ count: 6 }))).toBe(1);
    expect(candidateKeyIndex(keyEvent({ key: "6" }), gate({ count: 6 }))).toBe(6);
    expect(candidateKeyIndex(keyEvent({ key: "7" }), gate({ count: 6 }))).toBeNull();
  });
});
