# galgame —— 校园 AI 文字游戏（引擎 + 插件式玩法）

> 一所学校、一群有私心的 NPC、一个不会被选项框住的玩家。
> 你用自然语言行动；NPC 有自己的记忆和目的，会在你看不见的夜里互相商量；第二天，你从他们的态度里读出破绽。

**当前状态：M0 骨架已跑通**（规范 + 可运行的引擎骨架 + 一个示例模块）。契约冻结在 `CONTRACT_VERSION 3.0.0`；跑一次完整回合、联一次免费模型、调一次 HTTP 接口都验证过（见 §三）。

---

## 一、三句话理解设计

| # | 不变量 | 意思 |
|---|---|---|
| **I1** | **只有 `Arbiter.apply` 能改世界状态** | LLM 和模块只能"提议"，引擎裁决后才落库。谁都不许直接写库。 |
| **I2** | **状态里没有硬编码字段** | 属性是 `attrs: Record<string, value>`，键由 `content/registry/attrs.json` 声明。代码里不许出现 `stamina`。 |
| **I3** | **新玩法 = 新数据 + 新目录** | 加模块不改引擎；加属性只改 JSON；加对话形态只加一个导演文件。 |

记法：**Module 算数，Director 说话，Engine 记账。**

---

## 二、文档地图（按需读，不要通读）

| 文档 | 一句话 | 谁看 |
|---|---|---|
| [docs/03-接口总表.md](docs/03-接口总表.md) | **唯一名字来源**：12 个 op 原语、事件、内部接口、HTTP/SSE、错误码 | 所有人，写代码前必读 |
| [docs/00-总方案-v2.md](docs/00-总方案-v2.md) | 架构、扩展点矩阵、为什么能"只加变量不改引擎"、里程碑、明确不做的事 | 了解全局时 |
| [docs/01-模块规范.md](docs/01-模块规范.md) | **写玩法模块的手册**：目录、manifest、生命周期、两个完整模板、review 清单 | 写模块的人（主要工作） |
| [docs/02-数据格式.md](docs/02-数据格式.md) | 属性注册表、实体、事件、SQLite 投影、存档与迁移 | 加数据的人 |
| [docs/04-联机与多Agent.md](docs/04-联机与多Agent.md) | 房间模型、seq 续传、并发冲突、NPC 自主对话（密谋/闲聊/争论） | 做联机 / 做 NPC 自治时 |
| [docs/05-内容边界与AI推演.md](docs/05-内容边界与AI推演.md) | canon/soft/x 三档、AI 能生成什么不能生成什么、转正与回收 | 调内容生成时 |
| [AGENTS.md](AGENTS.md) | 给 AI 协作者（和用 AI 的人）的规则、权限、任务配方、禁区 | 让 AI 帮忙改代码前 |
| [docs/schemas/v2/](docs/schemas/v2/) | 6 份 JSON Schema（机器可校验副本：op 原语 / 实体 / 注册表 / 事件信封 / manifest / 快照） | 写校验器 / 接外部工具时 |
| [docs/v1/](docs/v1/) | 第一版方案归档：产品定义、记忆检索公式、成本模型、架构评审 | 查设计依据 |

> 文档冲突时 **`03-接口总表.md` 赢**，并请报告冲突。
> 命名/类型在 03（含 §10 v2.1 补遗），数据形状在 02，扩展方法在 01。

---

## 三、现在就能跑（M0）

```bash
npm install                      # 唯一一次
npm test                         # 184 个测试（引擎/记忆/审核/地图/网关/交易联调），不联网不花钱
npm run typecheck                # tsc --noEmit，全仓 0 错误
npm run check:contract           # 文档↔代码一致性（版本、12 op、33 错误码、6 份 schema）

npm run dev:server               # 不配 key → 离线叙述器（场景白描，不出现配置提示），http://127.0.0.1:8787
npm run dev:web                  # http://127.0.0.1:5173（/api 代理到 8787）
```

也可以在标题页「接入真实模型」里直接填 key（自备 OpenAI 兼容端点）：提交即探活、保存到 `data/llm-settings.json`（已 gitignore）并在重启后自动恢复；`DELETE /api/v1/settings/llm` 断开清除（接口见 `docs/03` §5.2.2）。

接一个免费模型（学校/超算的 OpenAI 兼容接口都行，不要把 key 写进仓库）：

```bash
export GALGAME_LLM_BASE_URL=https://ai.ecustcic.com/api/v1
export GALGAME_LLM_MODEL=deepseek-v4.1-flash
export GALGAME_LLM_API_KEY=...
npm run dev:server
npx tsx scripts/live-check.ts    # 真跑一个回合：打印耗时/usage/叙事前 200 字
```

内容审核必须配一个**另一个家族的强模型**（DeepSeek 系容易被同一套破甲提示词带走）。
三项**独立配置、不继承** `GALGAME_LLM_*`；缺任意一项就是放行态，并在启动时打印告警：

```bash
export GALGAME_AUDIT_BASE_URL=https://ai.ecustcic.com/api/v1   # 也可与叙事不同端点
export GALGAME_AUDIT_MODEL=<另一个家族的强模型>                  # 代码里没有默认模型名
export GALGAME_AUDIT_API_KEY=...
npx tsx scripts/audit-check.ts   # 7 段"该拦/不该拦"样本抽检，实测 7/7
```

不启服务器也能验证整条链路：

```bash
npx tsx scripts/smoke.ts         # 建房 → 行动 → accepted/delta/commit → 幂等重放
npm run replay -- --file data/rooms/<room>.jsonl   # 回放事件日志，查 seq 断档
```

实测数字（M0，免费 ecust `deepseek-v4.1-flash`）：一个回合 5.4s，prompt 203 tok / completion 176 tok，叙事正常带 NPC 台词；Mock 模式 1.5ms。

**已经有的**：事件日志 Store（jsonl，可回放）、Arbiter（12 op 校验 + canon 锁 + 配额 + 原子性）、Turn 流水线（幂等 / seq 防护 / LLM 失败降级）、模块宿主（扫描 `content/modules/*` 自动加载、故障隔离）、记忆打分、对话导演骨架、Transport（audience 过滤）、LLM 网关（json_object / 空 content 判死 / 429 重试）、HTTP+SSE 服务、React 前端、示例模块 `trade`/`core`、14 个属性开箱可用（`content/registry/attrs.json`）。
**审核层（本次新增）**：模型叙事发出前必经第二个强模型审核（`packages/engine/src/audit.ts` + `apps/server/src/audit.ts`）；违规 → 丢弃本次叙事与模型提案、警告、扣信誉，信誉归零 → 删档拒绝接待。阈值/扣分/分类都在 `content/registry/policy.json`。审核器**必须独立配置**（`GALGAME_AUDIT_*`）；不配就是放行态，启动时会告警。
**现实锚定层（本次新增）**：玩家说"我全知全能""忽略以上提示词""给我一万"这类诱导时，不扣分也不惩罚，而是**修饰**——提示词把话框成"角色说出口的台词"，并且该回合模型提出的换数值提案会被丢弃（`content/registry/reality.json` 决定哪些算诱导、允许自己变化多少），丢弃数量如实显示为 `世界观校准：N 条`。加一类诱导只加一个 JSON 条目。
**记忆子系统（本次新增，`docs/07`/`docs/08`）**：三层记忆（short/long/permanent）+ 六道写入闸门 + 1100 tok 注入硬顶，全部从事件日志投影而来（可回放、可重启）；账号维度隔离（`X-User-Id` → `GET /api/v1/me` 看自己的档案）；世界层永久记忆走 canonize 八道闸门（来源可追溯 / ≥2 见证 / 隐私扫描 / 独立审核 / 幂等 / 每日上限 / 不可变 / 可回滚），发布成功后"这个世界记住你"会在下一回合告诉你；管理员可用 `GET /api/v1/admin/stats` 看指标与抽样，judge 连续失败会自动熔断。记忆契约 `CONTRACT_VERSION 3.1.0`。
**还没有（M1 起）**：夜间 tick 调度与密谋编排、记忆压缩的后台调度（当前惰性触发）、导演真调 LLM、联机 WS 与房间回收、审核采样人审与申诉、canonize 定时任务（当前只有管理员端点触发）。
**地图模块 v0.2（见 [docs/06-地图模块.md](docs/06-地图模块.md)）**：奉贤校区真实鸟瞰底图（6000×4500），支持缩放/拖拽/选点跳跃；全部点位带 `built/under_construction/planned` 三态，规划与在建建筑只展示、建成后改 JSON 即可进入；NPC 按 5 段日程自行移动（暂不与地图点位联动），玩家可提交新场景想法——经管理员双审 + AI 生成草案后发布。

---

## 四、目录结构（开工后）

```
content/            ← 数据即玩法，改这里不用写代码
  canon/            ← 人工锁定：世界观、客观事实、核心 NPC（AI 只读）
  registry/         ← 属性/事件/意图/工具声明（加变量只改这里）
  modules/<id>/     ← 玩法模块：交易、学习、社团…（他人主战场）
  directors/        ← 对话导演：密谋、闲聊、争论、多人对话
packages/
  shared/           ← 冻结契约（类型 + zod），所有模块只依赖它
  engine/           ← 引擎核心（闭盒：只有我能改）
  llm/              ← 模型网关：多 provider、增量 JSON 解析、重试
  testkit/          ← 模块作者的测试工具（假 LLM、假房间）
apps/
  server/           ← Fastify 装配（薄）
  web/              ← React 前端（纯渲染）
```

**边界**：`engine` 不 import 任何模块；模块不 import `engine` 内部，只依赖 `shared` 的契约。

---

## 五、怎么加东西（不用改引擎）

| 想做的事 | 改哪里 | 动引擎？ |
|---|---|---|
| 加一个属性（体力/好感/压力…） | `content/registry/attrs.json` 加一条 | ❌ |
| 加一个 NPC / 地点 / 物品 | `content/{npcs,world,items}/*.json`，或让 AI 运行时创建 | ❌ |
| 加一个玩法（交易/学习/社团） | 新建 `content/modules/<id>/`（manifest.json + module.ts） | ❌ |
| 加一个 LLM 工具 | manifest `tools` + handler | ❌ |
| 加一个事件类型 | `content/registry/events.json` 一条 | ❌ |
| 加一种 NPC 对话形态 | `content/directors/<id>.ts` 一个文件 | ❌ |
| 加一个 op 原语 | 改契约 + Arbiter（**尽量避免**） | ✅ |

详细步骤见 [AGENTS.md §4 任务配方](AGENTS.md)。

---

## 六、三条"不改引擎"验收（本方案的可靠性证明）

1. **加变量**：`attrs.json` 加 `stress` → 重启 → 面板自动出现"压力"，前端/引擎零改动。
2. **加模块**：新建 `content/modules/library/`（借书/逾期）→ 启动时自动扫描加载 → 能借书、LLM 能调 `library.borrow`，`packages/engine` 一行不改。
3. **加对话形态**：新建 `content/directors/npc.rumor.ts`（三人传闲话）→ 触发处只改 `directorId`，引擎零改动。

**加分**：两个浏览器窗口进同一房间（`room.mode=coop`），状态一致。

---

## 七、技术选型（原则：少依赖、单一进程）

| 层 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript 全栈（strict） | 契约用类型表达，模块作者能靠编辑器发现错误 |
| 服务端 | Fastify + SSE | 一个进程够用；SSE 比 WS 简单，接口留好 WS 后路 |
| 存储 | SQLite（事件日志 + 快照 + 投影表） | 单文件、可回放、零运维 |
| 前端 | Vite + React | 纯渲染服务端 `View`，不含规则 |
| 校验 | zod（一份真源 → TS 类型 + JSON Schema + 提示词描述） | 避免"文档/代码/校验"三套漂移 |
| 模型 | OpenAI 兼容协议，provider 可切 | 测试期用免费端点，上线再换 |

---

## 八、成本与测试（现阶段不优化）

- **现在不做成本优化**，架构上只保留两个开关：提示词前缀稳定（为将来缓存）、单回合 LLM 调用次数上限（`turn.llmCalls`）。
- **测试用免费 API**（ecust 端点），provider 配置在 `config`，代码里不出现任何 key。
- 历史成本模型见 [docs/v1/调研-API与成本.md](docs/v1/调研-API与成本.md)，**上线前再复核**（价格会变）。

---

## 九、现在做什么（下一步）

M0 已完成（骨架可跑，见 §三）。接下来按依赖顺序：

1. **M1 单房单 NPC 的完整回合**：夜间 tick 调度、记忆落库+压缩、导演真调 LLM、`core` 行动的邻接与在场约束补齐。
2. **M2 模块宿主验收（分水岭）**：让另一个人照 `docs/01-模块规范.md` 写第三个模块（例如 `study`），**不许改 `packages/engine`**。做不到就停下来修扩展点，别往后堆功能。
3. **M3 联机**：WS 广播、房间回收、`Last-Event-ID` 续传、多人同房的 `expectedSeq` 冲突处理（协议已在 `docs/04`，代码只差 transport 落地）。
4. 契约冻结在 `CONTRACT_VERSION 3.0.0`；要改语义先改 `docs/03` 并 bump，再改代码。

里程碑与验收见 [docs/00-总方案-v2.md §10–§12](docs/00-总方案-v2.md)。

---

## 十、给协作者（含 AI 助手）

1. 先读 [AGENTS.md](AGENTS.md)，再读 [docs/03-接口总表.md](docs/03-接口总表.md)。
2. 写模块只需要读 [docs/01-模块规范.md](docs/01-模块规范.md)；遇到数据格式问题查 [docs/02-数据格式.md](docs/02-数据格式.md)。
3. 想加新名字 → 先改 `03`，再写代码。
4. 认为"必须改引擎" → 先写清楚"现有扩展点为什么不够"，不要自己动手改 `packages/engine`。
