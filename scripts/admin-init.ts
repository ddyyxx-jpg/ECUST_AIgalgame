/**
 * 本地初始化首个管理员（收敛稿 B1）：停服后运行（单进程单写者，勿与运行中的服务并行写）。
 * 用法：GALGAME_ADMIN_PASSWORD=xxx npx tsx scripts/admin-init.ts <username>
 * 已存在的账号 → 校验该账号当前密码后提权为 admin；不存在 → 用提供的密码创建 admin。
 */
import path from "node:path";
import { loadConfig } from "../apps/server/src/config.ts";
import { AuthStore } from "../apps/server/src/auth-store.ts";
import { normalizeUsername, validatePassword } from "../apps/server/src/users.ts";

const username = normalizeUsername(process.argv[2]);
if (!username) {
  console.error("用法：npx tsx scripts/admin-init.ts <username>（密码经 GALGAME_ADMIN_PASSWORD 传入）");
  process.exit(1);
}
const password = process.env.GALGAME_ADMIN_PASSWORD ?? "";
const cfg = loadConfig();
const store = new AuthStore(path.join(path.resolve(cfg.dataDir), "auth", "auth.json"));
await store.load();
const existing = store.findUser(username);
if (!validatePassword(password)) {
  console.error("需要 GALGAME_ADMIN_PASSWORD（8–128 位；提权现有账号时须为该账号当前密码）");
  process.exit(1);
}
const admin = await store.ensureAdmin(username, password);
console.log(`[admin-init] ${existing ? "已提权" : "已创建"}管理员：${admin.username}（${admin.userId}）`);