import { mkdir, open, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Envelope } from "../../shared/src/contract/types.ts";

/** rename 已执行，但无法确认目录项的持久性；原操作可能已经生效。 */
export class StoreCommitUnknownError extends Error {
  readonly code = "E_STORE_FAULT";

  constructor(cause: unknown) {
    super("房间日志可能已写入，目录同步失败。请核对存档后再继续。", { cause });
  }
}

/** 其他写入已经进入待核对状态，本次调用还未写入。 */
export class RoomStorageBlockedError extends Error {
  readonly code = "E_STORE_FAULT";

  constructor(cause: StoreCommitUnknownError) {
    super("该房间有待核对的写入，请先核对存档。", { cause });
  }
}

export function isRoomSyncFault(error: unknown): error is StoreCommitUnknownError | RoomStorageBlockedError {
  return error instanceof StoreCommitUnknownError || error instanceof RoomStorageBlockedError;
}

async function syncDirectory(directory: string, newChild?: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 运维提供的既存路径可能只允许穿越父目录。本次创建的目录不能跳过同步。
    if (!newChild && (code === "EACCES" || code === "EPERM")) return;
    throw error;
  }
  try {
    if (newChild) await mkdir(newChild);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 逐级同步新目录项，即使初始化中途失败也能从已经创建的那一级继续。 */
export async function prepareDurableDirectory(dir: string): Promise<void> {
  const missing: string[] = [];
  let directory = path.resolve(dir);
  for (;;) {
    try {
      if (!(await stat(directory)).isDirectory()) {
        throw Object.assign(new Error("存档路径不是目录"), { code: "ENOTDIR" });
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(directory);
      directory = path.dirname(directory);
    }
  }
  // 已存在的最后一级也可能由刚失败的初始化或管理员脚本创建。
  await syncDirectory(path.dirname(directory));
  for (const child of missing.reverse()) {
    await syncDirectory(path.dirname(child), child);
  }
}

export class RoomLogWriter {
  private ready?: Promise<void>;

  constructor(private readonly directory: string) {}

  private ensureDirectory(): Promise<void> {
    this.ready ??= prepareDurableDirectory(this.directory).catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  async write(file: string, events: readonly Envelope[]): Promise<void> {
    await this.ensureDirectory();
    const temporary = `${file}.tmp`;
    const body = events.map((event) => JSON.stringify(event) + "\n").join("");
    // 先打开目录：权限或句柄故障应尽量在替换原日志前暴露。
    const directory = await open(this.directory, "r");
    try {
      await writeFile(temporary, body, { encoding: "utf8", flush: true });
      await rename(temporary, file);
      try {
        await directory.sync();
      } catch (cause) {
        throw new StoreCommitUnknownError(cause);
      }
    } finally {
      // 关闭报错不会改变已得到的 sync 结果，也不能盖掉上面的写入错误。
      await directory.close().catch((error: unknown) => console.error("[store] 关闭日志目录失败", error));
    }
  }
}
