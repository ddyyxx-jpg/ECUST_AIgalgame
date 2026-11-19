/**
 * 管理操作日志（收敛稿 B1，docs/03 §5.2.9）：append-only JSONL。
 * 只记操作者/目标/时间/原因/结果，**不记密码、token、聊天内容**。
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface AdminAction {
  at: number;
  operator: string;
  target: string;
  action: string;
  reason: string;
  result: string;
}

function isAction(v: unknown): v is AdminAction {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.at === "number" && typeof a.operator === "string" && typeof a.target === "string" &&
    typeof a.action === "string" && typeof a.reason === "string" && typeof a.result === "string"
  );
}

export class AdminLog {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  record(action: Omit<AdminAction, "at">): Promise<void> {
    const entry: AdminAction = { at: Date.now(), ...action, reason: action.reason.slice(0, 200) };
    const run = this.chain.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `\n${JSON.stringify(entry)}\n`, { encoding: "utf8", flush: true });
    });
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async list(limit = 50): Promise<AdminAction[]> {
    // 先等串行写盘落定，保证读到刚记录的动作（read-after-write 一致）
    await this.chain;
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw Object.assign(new Error("读取管理操作日志失败", { cause: error }), { code: "E_STORE_FAULT" });
    }
    const actions: AdminAction[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isAction(parsed)) actions.push(parsed);
      } catch {
        // 半截行跳过
      }
    }
    const count = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 500) : 50;
    return actions.slice(-count).reverse();
  }
}
