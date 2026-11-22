/** 引擎公共出口：外部只能用这些；内部文件不保证稳定 */
export { DefaultArbiter, DEFAULT_LIMITS } from "./arbiter.ts";
export type { ArbiterLimits, ArbiterOptions } from "./arbiter.ts";
export { EventSourcedStore, FileStore, isSafeRoomId } from "./store.ts";
export type { EventLog, StoreOptions } from "./store.ts";
export { applyEvent, createInitialState } from "./projection.ts";
export { JsonRegistry, emptyRegistry } from "./registry.ts";
export type { RegistrySource } from "./registry.ts";
export { ModuleHost } from "./modules.ts";
export { DefaultTurn } from "./turn.ts";
export { EventSourcedMemory, InMemoryMemory, estimateTokens, normalizeSalience, normalizeVisibility, worldRoomId } from "./memory.ts";
export { DEFAULT_MEMORY_GATES, applyMemoryGates, coerceMemoryDrafts, contentHashOf, memoryDraftArgs, trigramSimilarity } from "./memory.gate.ts";
export type { MemoryDrop, MemoryDropReason, MemoryGateInput, MemoryGateLimits, MemoryGateResult } from "./memory.gate.ts";
export { INJECT_BUDGET, readMemoryContext, selectOwner } from "./turn.memory.ts";
export { resolveUserId, seedDrafts, toMemoryProposals } from "./turn.memory.drafts.ts";
export type { MemoryContext } from "./turn.memory.ts";
export { DialogueHost } from "./dialogue.ts";
export { MemoryTransport } from "./transport.ts";
export { buildView } from "./view.ts";
export { AUDIT_CATEGORIES, DEFAULT_AUDIT_POLICY, NoopAudit, buildAuditMessages, formatWarning, labelOf, parseVerdict, resolveAuditPolicy } from "./audit.ts";
export type { AuditInput, AuditPolicy, AuditPort, AuditVerdict } from "./audit.ts";
export { AuditGate } from "./audit.gate.ts";
export { DEFAULT_REALITY, detectReality, filterProposals, realityFraming, resolveRealityPolicy } from "./reality.ts";
export type { RealityKind, RealityPolicy } from "./reality.ts";
export { TurnLlm } from "./turn.llm.ts";
export type { AuditGateDeps, AuditGateResult, ReviewRequest } from "./audit.gate.ts";

// ---- Turn 提交证据 / 跨重启幂等（issue #76）
export { TURN_COMMITTED_TYPE, commitMarker, evidenceKey, parseCommitEvidence } from "./turn.evidence.ts";
export type { TurnCommitEvidence } from "./turn.evidence.ts";

// ---- 世界层永久记忆（P3，docs/08 §7）
export { CanonizeJob, DEFAULT_CANONIZE_LIMITS, candidatesFromMemories } from "./canonize.ts";
export type { CanonizeJudge, CanonizeLimits, CanonizeReport, MemoryIndex, PermanentCandidate } from "./canonize.ts";
