# 试用部署（Docker + 宿主机 Nginx）

目标：单机单实例，`https://<公网IP>/`，应用内邀请注册 + Cookie 会话。

**域名隔离**：游戏 server 只匹配 `server_name <公网IP>`；443 的 `default_server` 是**404 catch-all**。已有域名（如 `huaaaji.cloud`）仍由原来的 `server_name` 命中 WordNote；任何其他 Host（包括解析到同一 IP 的域名）都不会进入游戏。本次没有修改 DNS。

## 1. 准备

```bash
sudo mkdir -p /opt/ecust-galgame
sudo chown "$USER":"$USER" /opt/ecust-galgame
git clone --branch <branch> --depth 1 <repo-url> /opt/ecust-galgame/app
mkdir -p /opt/ecust-galgame/data
sudo chown -R 1000:1000 /opt/ecust-galgame/data
```

Web 静态文件由本地构建后同步到 `/opt/ecust-galgame/web`：

```bash
npm run build:web
rsync -az --delete apps/web/dist/ <server>:/opt/ecust-galgame/web/
```

## 2. `.env`（放在 `/opt/ecust-galgame/app/.env`，权限 600）

```dotenv
GALGAME_HOST=0.0.0.0
GALGAME_PORT=8787
GALGAME_DATA_DIR=/app/data
GALGAME_AUTH_REQUIRED=1
GALGAME_INVITE_CODE=<强随机邀请码>
GALGAME_SECURE_COOKIES=1
GALGAME_SESSION_TTL_DAYS=7
GALGAME_TRUST_USER_HEADER=0
GALGAME_ADMIN_TOKEN=<强随机令牌>
# 反代在同机转发：设 1 才按 X-Forwarded-For 的真实客户端 IP 限流（直连部署保持 0）
GALGAME_TRUST_PROXY=1
# CSRF Origin 白名单，必须等于浏览器地址栏的源（IP 部署写 https://<公网IP>）；AUTH_REQUIRED=1 必填
GALGAME_PUBLIC_ORIGIN=https://<公网IP>
GALGAME_RESET_TTL_MIN=15
# 可选：模型/审核；不配则离线叙述、NoopAudit
# GALGAME_LLM_BASE_URL=...
# GALGAME_LLM_MODEL=...
# GALGAME_LLM_API_KEY=...
# GALGAME_AUDIT_BASE_URL=...
# GALGAME_AUDIT_MODEL=...
# GALGAME_AUDIT_API_KEY=...
```

## 3. 应用容器

```bash
cd /opt/ecust-galgame/app
sudo docker compose up -d --build
sudo docker compose ps
curl -fsS http://127.0.0.1:8787/api/v1/health
```

### 初始化管理员

在 `/opt/ecust-galgame/app` 执行下列命令。先停服，避免两个进程同时写账号库。一次性容器沿用 `app` 服务的 `.env` 和数据卷，将账号写入容器内的 `/app/data/auth/auth.json`，对应宿主机的 `/opt/ecust-galgame/data/auth/auth.json`。

```bash
cd /opt/ecust-galgame/app
sudo docker compose stop app &&
(
  read -rs -p '管理员密码: ' GALGAME_ADMIN_PASSWORD || exit 1
  printf '\n'
  export GALGAME_ADMIN_PASSWORD
  sudo --preserve-env=GALGAME_ADMIN_PASSWORD docker compose run --rm --no-deps \
    -e GALGAME_ADMIN_PASSWORD app ./node_modules/.bin/tsx scripts/admin-init.ts campus_admin
) &&
sudo docker compose up -d app
```

用户名已存在时，输入该账号当前的密码，校验通过后才会授予管理员角色。

## 4. Nginx + 自签证书（无域名，仅 IP 访问）

```bash
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/ecust-galgame.key \
  -out /etc/nginx/ssl/ecust-galgame.crt \
  -subj "/CN=<公网IP>" \
  -addext "subjectAltName=IP:<公网IP>"
sudo chmod 600 /etc/nginx/ssl/ecust-galgame.key

sudo cp deploy/nginx-ecust-galgame.conf /etc/nginx/sites-available/ecust-galgame
sudo ln -sfn /etc/nginx/sites-available/ecust-galgame /etc/nginx/sites-enabled/ecust-galgame
sudo nginx -t && sudo systemctl reload nginx
```

## 5. 冒烟

```bash
curl -kI https://<公网IP>/
# 域名必须仍落到原站点，而不是游戏
curl -k -sS --resolve huaaaji.cloud:443:<公网IP> https://huaaaji.cloud/ | grep -o "<title>[^<]*"
curl -k https://<公网IP>/api/v1/health

# 注册（邀请码来自 .env）；记下 set-cookie
# auth 写路由同样过 CSRF：必须带与 GALGAME_PUBLIC_ORIGIN 完全一致的 Origin
curl -k -i -X POST https://<公网IP>/api/v1/auth/register \
  -H 'content-type: application/json' -H 'origin: https://<公网IP>' \
  -d '{"username":"alice","password":"password123","inviteCode":"<邀请码>"}'

# 带 Cookie 建一个房间
curl -k -X POST https://<公网IP>/api/v1/rooms \
  -H 'content-type: application/json' -H 'origin: https://<公网IP>' -b '<cookie>' -d '{"mode":"solo"}'
```

管理员冒烟：用初始化的账号在站点登录，然后在同一浏览器会话访问 `https://<公网IP>/api/v1/admin/users`。确认返回 HTTP 200，且列表中 `campus_admin` 的 `role` 为 `admin`。如需验证一次性邀请，用该会话调用 `POST /api/v1/admin/invites`，再用返回的邀请码注册测试账号。

## 6. 注意 / 部署约束

- 单实例；`FileStore` 没有多进程锁，不要扩副本。
- **会话是进程内存态（部署约束）**：重启/重新部署后所有人需要重新登录；不要把它当持久登录。会话过期项靠访问时清理，长期运行也只在一台进程内。
- **单进程单写者（部署约束）**：`data/` 同一时刻只能有一个 server 进程写（额度账本、账号库、事件日志都没有跨进程锁）。扩容/滚动发布要停旧起新，不能双跑。
- **额度 `defaultDailyTurns=null` = 不限（部署约束）**：默认不设日限额；要控成本请在 `PUT /api/v1/admin/settings` 显式给数值。
- **管理员令牌不自动轮换（部署约束）**：`GALGAME_ADMIN_TOKEN` 只要环境变量不改就一直有效；建议定期换值并重启。显式配置必须 ≥16 字符且高熵，否则**拒绝启动**；未配置时每进程随机生成并打印到控制台（重启即失效，适合临时运维）。
- **CSRF / Origin（部署约束）**：`GALGAME_PUBLIC_ORIGIN` 必须与浏览器地址栏的源逐字一致（含 scheme 与端口）；auth 写路由与所有 Cookie 写请求都校验它。反代需原样透传 `Origin`（Nginx 默认透传），不要改写。
- **`GALGAME_TRUST_PROXY=1` 仅在反代后开启**：直连部署开启会让客户端伪造 `X-Forwarded-For` 绕过按 IP 的登录/令牌限流。
- `data/` 是唯一持久卷，备份它。
- **额度账本坏行**：启动日志出现 `[quota] ... 行无法解析`，或 `GET /api/v1/admin/quota` 的 `skippedLines>0`，说明上次进程非正常退出（半截尾行）。被跳过的记录不参与幂等/对账，请人工核对对应 `clientTurnId` 后再开放行动。
- 自签证书浏览器会警告；HTTPS 是 Cookie `Secure` 和密码传输的前提。若只想组内使用，可再加 UFW 源 IP 白名单或 VPN。
- `GALGAME_AUTH_REQUIRED=1` 后，旧 `X-User-Id` 不再生效；每人一个账号，清 localStorage 不影响账号。
- 若宿主机 8788 跑着 `LLM_context_checker`，可以把游戏 LLM 流量接进去：
  ```dotenv
  GALGAME_LLM_BASE_URL=http://host.docker.internal:8788/openai/v1
  ```
  compose 已带 `extra_hosts: host.docker.internal:host-gateway`；checker 的 `/openai` 上游需指向 DeepSeek，并在 `projects.json` 里把游戏 key 映射到项目名。
- `/api/v1/settings/` 已在 Nginx 层封掉；模型 key 统一走服务端 `.env`。管理端点 `/api/v1/admin/*` 走 `x-admin-token`，不受此封禁影响。
- **旧 localStorage 不自动迁移（建议12）**：3.4 之前前端把管理员令牌存在 `localStorage["galgame.adminToken"]`、把身份存在本地 userId。新版已移除玩家侧的管理/模型入口与本地令牌，登录态只在 HttpOnly Cookie 里。旧浏览器里残留的 `galgame.adminToken`/userId **不会被自动清理或迁移**——它们已不再被读取，用户清一次 localStorage（或换浏览器）即可；账号数据在服务端 `data/auth/`，与本地存储无关。
- **公开 health 已脱敏（建议11）**：`GET /api/v1/health` 只回 `{ok, contract}`；canonize 的启用/judge 等运维细节移到鉴权后的 `GET /api/v1/admin/stats`（`canonizeEnabled`/`canonizeJudge`），fail-closed 状态仍对运维可见。

## 7. 本地开发 / 邀请注册（P1-2）

- **访客进入**：`GALGAME_AUTH_REQUIRED=0` 时，前端标题页提供「以访客身份进入（本地开发）」，无需登录/邀请码；旧 `X-User-Id` 兜底仍可用。`GET /api/v1/auth/status` 公开返回 `{required, registrationOpen}`，前端据此决定是否显示登录/注册。
- **完整注册流程**：本地强制登录时设置 `GALGAME_AUTH_REQUIRED=1`、`GALGAME_INVITE_CODE=<邀请码>` 和 `GALGAME_PUBLIC_ORIGIN=http://127.0.0.1:5173`。Origin 须与地址栏一致；环境变量邀请码可重复使用。
- **一次性邀请 / 管理员**：Docker 部署走 [初始化管理员](#初始化管理员)。本地直接运行 Node 服务时，停服后用与服务端相同的 `GALGAME_DATA_DIR` 和工作目录执行 `GALGAME_ADMIN_PASSWORD=<密码> npx tsx scripts/admin-init.ts <用户名>`。管理员登录后用 `POST /api/v1/admin/invites` 签发一次性邀请（默认 1 次 / 7 天），用 `POST /api/v1/admin/users/:userId/reset-credential` 签发重置凭证。可通过 `PUT /api/v1/admin/settings` 关闭 `registrationOpen`。
