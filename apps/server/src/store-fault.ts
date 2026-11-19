/**
 * 存储故障的统一判定：把 fs errno / 显式 `E_STORE_FAULT` 映射为 503，且不回显路径。
 * 只用于未预期异常兜底；业务拒绝仍走各自的 `{ok:false, code}`。
 */
const FS_FAULT_CODES = new Set([
  "EACCES",
  "EPERM",
  "ENOSPC",
  "EDQUOT",
  "EIO",
  "EROFS",
  "EMFILE",
  "ENFILE",
  "ENOTDIR",
  "EISDIR",
]);

export function isStoreFault(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "E_STORE_FAULT" || (typeof code === "string" && FS_FAULT_CODES.has(code));
}
