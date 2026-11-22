/**
 * 三个存档 CLI（export/import/rebuild）共用参数解析。
 *
 * 曾经的坑：`--dry-run=true` 被当成字面量键 "dry-run=true"，`args.has("dry-run")` 为假，
 * 演练命令真的写盘；未知参数也被静默忽略，打错参数照样改数据。这里统一成
 * `--key value` / `--flag` / `--flag=true|false`，未知参数一律报错交给调用方 exit 2。
 */
import path from "node:path";

export class CliArgsError extends Error {}

export function parseCliArgs(argv: readonly string[], known: readonly string[]): Map<string, string> {
  const args = new Map<string, string>();
  const knownSet = new Set(known);
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) throw new CliArgsError(`未知参数：${token}`);
    const eq = token.indexOf("=");
    const name = eq >= 0 ? token.slice(2, eq) : token.slice(2);
    if (!name || !knownSet.has(name)) throw new CliArgsError(`未知参数：--${name}`);
    let value = "";
    if (eq >= 0) {
      value = token.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i += 1;
      }
    }
    args.set(name, value);
  }
  return args;
}

/** 布尔开关：省略值或 true 为真，false 为假，其它值报错（fail-closed） */
export function boolFlag(args: Map<string, string>, name: string): boolean {
  if (!args.has(name)) return false;
  const value = args.get(name)!;
  if (value === "" || value === "true") return true;
  if (value === "false") return false;
  throw new CliArgsError(`--${name} 只接受 true / false 或省略值`);
}

export function requireArg(args: Map<string, string>, name: string): string {
  const value = args.get(name);
  if (!value) throw new CliArgsError(`缺少 --${name}`);
  return value;
}

/**
 * 导出目标绝不能落在权威事件日志目录（dataDir/rooms）内：
 * export-save 用 mkdir + rename 写 out，指到 rooms 就会把房间 JSONL 整份覆盖。
 * 用 path.relative 判定，天然处理 .. / 符号前缀同名的兄弟目录（rooms2）。
 */
export function assertSafeArchiveOut(dataDir: string, out: string): void {
  const roomsDir = path.resolve(dataDir, "rooms");
  const rel = path.relative(roomsDir, path.resolve(out));
  const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  if (inside) throw new CliArgsError(`--out 不能落在权威事件日志目录内：${roomsDir}`);
}
