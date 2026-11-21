/**
 * main.ts 关停钩子的真实进程 smoke（PR #125 复审 P3）：
 * 不 mock 进程与信号——真的 spawn `node --import tsx apps/server/src/main.ts`，
 * 等 /api/v1/health 200 后发 SIGTERM，断言进程以 0 退出且走了 [shutdown] 分支。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** 仓库根（本文件在 apps/server/src/） */
const ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") {
        server.close();
        reject(new Error("拿不到空闲端口"));
        return;
      }
      const { port } = addr;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(
  port: number,
  child: ChildProcessWithoutNullStreams,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`main.ts 提前退出（code=${child.exitCode}）：\n${output()}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (res.status === 200) return;
    } catch {
      // 端口还没开始监听，继续轮询
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`等待 /api/v1/health 超时：\n${output()}`);
}

describe("main.ts 关停 smoke", () => {
  it(
    "SIGTERM → 退出码 0、输出含 [shutdown]，不留孤儿进程",
    async () => {
      const dataDir = await mkdtemp(path.join(tmpdir(), "galgame-shutdown-"));
      const port = await freePort();
      const child = spawn(process.execPath, ["--import", "tsx", "apps/server/src/main.ts"], {
        cwd: ROOT,
        env: {
          ...process.env,
          GALGAME_DATA_DIR: dataDir,
          GALGAME_HOST: "127.0.0.1",
          GALGAME_PORT: String(port),
          GALGAME_ADMIN_TOKEN: "dev-admin-token-0123456789",
        },
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      try {
        await waitForHealth(port, child, () => output);
        child.kill("SIGTERM");
        const { code, signal } = await exited;
        expect(signal).toBeNull();
        expect(code).toBe(0);
        expect(output).toContain("[shutdown]");
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await exited;
        }
        await rm(dataDir, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
