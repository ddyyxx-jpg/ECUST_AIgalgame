# MEMORY.md —— AI 协作者共享记忆

> **用途**：让新会话 / 新协作者在 5 分钟内恢复上下文——代码架构、工程规范、工程进度、各分支的关键决策与遗留。
> **维护规则**：见 `AGENTS.md` §11（读取时机、按分支写入、提交/审阅合并时的写法）。
> **定位**：活文档，只追加、不覆盖；不是契约。与 `docs/03-接口总表.md` 冲突时以 `docs/03` 为准。
> **最后更新**：2026-11-17（main @ `v0.4.0`，已 push）

---

## 0. 当前快照

| 项 | 值 |
|---|---|
| 主分支 | `main`（sha 见 `git rev-parse --short main`；PR #4 已 squash 合入 `8a26e00`，记忆子系统 3.1.0 已在 main；PR #5 已 squash 合入 `69da448`，地图交互/图鉴 registry 收口已在 main） |
| `CONTRACT_VERSION` | **3.1.0**（记忆子系统 minor；`SCHEMA_VERSION 2`，`API_VERSION 2`，`WORLD_MEM_VERSION 1`） |
| `PROMPT_VERSION` | **2026-11-17.2** |
| 测试 | **26 文件 / 185 用例全过**（记忆 14+7+10+3+5+4、审核 6、地图 21…）；`check:contract` **8 项全过**；`typecheck` 0 错；`smoke` 建房 12 实体 + 幂等重放 OK |
| 已具备 | M0 骨架、地图模块（旅行/场景/草案双审）、引擎 3.0.0（原子结算 + 持久化闭环）、内容审核层、现实锚定层、前端体验与运行时模型接入、记忆子系统 3.1.0（P0–P4：事件溯源/账号隔离/世界层 canonize/世界印象）、**地图交互打磨 + 图鉴 registry 收口（PR #5）** |
| 下一步 | M1：单房单 NPC 完整玩法、夜间 tick/密谋编排；M2 模块宿主验收（`study` 只加目录）；M4 联机前收 issue #3 余项（PR #5 已收渲染键/registry，剩 `/state` 数值过滤、`self` 口径、`scenarios.ts` 数据化） |
| 已知遗留 | 见 §3.3（均为 MINOR，不阻断当前 main） |

---

## 1. 代码架构（稳定事实）

**一句话**：Module 算数，Director 说话，Engine 记账。

### 1.1 三个不变量（任何改动不得破坏）

- **I1** 只有 `Arbiter.apply` 能改世界状态。LLM / 模块 / 导演只能产出 `Proposal`，引擎裁决后落库；不许直接写 store / 文件。
- **I2** 状态里没有硬编码字段：属性是 `attrs: Record<string, value>`，键由 `content/registry/attrs.json` 声明；代码里不出现具体属性名（`reputation` 这类值只允许出现在内容 JSON / 默认空串配置里）。
- **I3** 新玩法 = 新数据 + 新目录：加模块不改引擎；加属性只改 JSON；加对话形态只加一个导演文件。

### 1.2 目录

- `packages/shared` —— 冻结契约：类型 + zod + `version.ts`（`CONTRACT_VERSION` / `PROMPT_VERSION`）。
- `packages/engine` —— 闭盒：`arbiter.ts` / `arbiter.ops.ts`（12 op 校验与副作用）、`store.ts`（事件日志 + 投影 + 持久化）、`turn.ts`（回合流水线）、`turn.llm.ts` / `turn.prompt.ts` / `turn.parse.ts`、`modules.ts`（模块宿主）、`audit.ts` / `audit.gate.ts`（审核层）、`reality.ts`（现实锚定层）、`index.ts`。
- `packages/llm` —— 网关（OpenAiCompatClient / MockLlm / retry）。
- `packages/testkit` —— 模块作者测试工具。
- `apps/server` —— `bootstrap.ts`（装配 + 建房种子）、`routes.ts`（HTTP/SSE）、`map.ts` / `map.data.ts` / `map.drafts.ts`（地图/草案流水线）、`audit.ts`（LlmAudit 真实审核器）、`config.ts`。
- `apps/web` —— React 前端（MapPanel / DraftsPanel / 对话与面板）。
- `content/` —— `canon/`（人工锁定，AI 只读）、`registry/`（attrs/events/intents/tools/policy/reality）、`modules/`（trade、map…）、`directors/`、`world/ items/ npcs/`、`prompts/`。
- `docs/` —— `03-接口总表.md` 是唯一名字来源；`00`/`01`/`02`/`04`/`05`/`06` 为规范/方案；`schemas/v2/` 与 03 对应。

### 1.3 Turn 流水线（当前实现，事件顺序以 `docs/03` §2.4 为准）

1. `store.load(roomId)` 取 seq → `options.expectedSeq` 不符只发 `turn.rejected`（不 accepted）。
2. 快照后检查是否 `purged`（`scene.props` 含 `purged`）→ `turn.error E_FORBIDDEN`（删档拒绝接待）。
3. `turn.accepted` → `detectReality`（现实锚定：输入侧子串匹配，数据在 `reality.json`）→ 意图分发。
4. 非 `skipLLM`：`TurnLlm.ask` 一次（JSON；解析失败抛 `E_LLM_FORMAT`）→ 现实锚定 `filterProposals` 过滤模型提案。
5. **审核在裁决之前**：`AuditGate.review`（独立审核模型）三种结果——违规 → 丢弃叙事与模型提案、`punish`（信誉/警告/留痕/可删档）后提交；审核故障 → 叙事换兜底文案、模型提案不采信、不惩罚；通过 → 模型提案入列。
6. 模块提案 + 模型提案一次 **atomic** `apply`（`expectedSeq`）；仅当模块提案为空且被拒全是模型提案时 repair 一次（修复后再审核）。
7. 成功才发 `turn.delta`(narrative) / `turn.facts` / `turn.ui` → 有 events 才 `turn.patch` → `await store.flush`（失败 `turn.error E_STORE_FAULT`，retryable）→ `turn.commit`；失败回合不发叙事；`finally` 里 `arbiter.endTurn`（释放预算）。

### 1.4 Arbiter / Store 关键语义（3.0.0 起）

- 默认提交语义 = **atomic**：任何一条被拒 → 整批不落库；`partial` 必须显式传。整批失败用 `ApplyResult.error {code,message}`（不再伪造 rejected proposal）。
- 权限看 `ctx.cause.type`（可信来源命名空间 `engine`/`tick`/`dialogue`/`plot`…），`proposal.by` 只用于报告；伪造 `by` 不能推进时间/代写记忆。
- 回合预算按 `cause.causedBy` 整回合累计（`maxDeltaPerTurn` / `xWritesPerTurn`），被拒批不耗额度；同房间 `apply` 串行（`exclusive`）。
- `FileStore` **写盘先行**：整份日志写 `*.jsonl.tmp` → `rename` 原子替换 → 成功后才改内存；失败 `E_STORE_FAULT` 且内存/seq 不变。读取前必须 `load()`；载入遇 seq 断档/重复截断到连续前缀并写回（`repaired`）。
- `Store.flush` 是必选成员（3.0.0 的 major 理由）：`Turn` 在 commit 前等待落盘，写盘失败不当作已发生。

### 1.5 审核层 / 现实锚定层

- 审核配置 `GALGAME_AUDIT_BASE_URL` / `MODEL` / `API_KEY` **三项齐全才启用**；不继承叙事模型端点/key，代码里无默认模型名；缺一 → `NoopAudit` 放行 + 启动 `[audit]` 告警。策略（分类/阈值/扣分/警告/删档）在 `content/registry/policy.json`。
- 审核器必须是独立模型/独立端点（不许同一模型或同一 key 家族自审，`AGENTS.md` §4.6）。
- 现实锚定只“修饰”不惩罚：命中诱导时提示词追加 framing，并过滤模型换数值的提案（自己的记忆、`maxSelfDelta` 内自身属性变化可留），丢弃数量如实告知（`世界观校准：N 条`）；**不扣分、不惩罚**。加一类诱导只改 `reality.json`。

### 1.6 地图模块

- 端点见 `docs/03` §5.2.1；`/api/v1/rooms/:roomId/map|map/travel|map/tick|map/dialogue`、`/api/v1/map/drafts`、`/admin/map/drafts/:id/review|publish|generate`；管理员头 `x-admin-token`。
- v0.2 底图：奉贤校区真实鸟瞰 `apps/web/public/map/ecust-campus.jpg`（6000×4500），`world_map.json` schemaVersion 2、33 个点位、`status = built|under_construction|planned`、`category`、`anchorLocId`；`MapView.image`。
- travel：先拒非 `built`（`E_FORBIDDEN`）；懒安装用户场景（`origin:"ai"`）或带 `anchorLocId` 的 canon 新场景（`origin:"seed"`，双向 `located_in`、坐标 attrs）→ `Turn.run({skipLLM:true, input:"map.travel <locId>"})` → 以权威 `located_in` 复核到达，否则 `E_NOT_ADJACENT`。规划/在建只展示，建成后改 JSON 的 `status` 即可进入。
- tick：`time.advance` 用 `cause.type="tick"` → 模块 tick 提案整批 `dryRun` → `apply`。**本轮不做 NPC 与地图点位联动**（用户另有安排）。
- 前端：`MapViewport` 视口裁剪/滚轮缩放（fit~4x）/拖拽/点击选点，三态标记 + 图例；非 built 只看详情不 travel。
- 草案流水线：`pending_review → approved → generating → generated_pending_review → published/rejected`，发布进 soft 区（不直接 `canon:true`）。

### 1.7 契约与名字

- 12 个 op 原语闭集；错误码以 `docs/03` §7 为准（当前 30 个）；新增名字先改 `docs/03` 再写代码。
- 12 op：`attr.delta` / `attr.set` / `entity.create` / `entity.update` / `entity.tombstone` / `link.create` / `link.remove` / `move.to` / `time.advance` / `scene.set` / `memory.write` / `plot.upsert`。

---

## 2. 工程规范（硬约束摘要；细则以 `AGENTS.md` + `docs/03` 为准）

- 不发明名字（先改 03）；不硬编码属性名；只提议不写库；模块不持 LLM/不读 key；不新增 op 原语；不新增依赖（除非用户同意）。
- 版本规则：改 op 语义 / 破坏性变更 → major；只增字段/配置键可 minor，但须在 `docs/03` 补记录（§10.x）；`PROMPT_VERSION` 随提示词结构变化必须 bump（KV 缓存前缀）。
- 测试断言 `Proposal` / `facts` / `view` 结构，不断言 LLM 文案；模板化文案（policy）可例外。
- 文件 ≤ 300 行、函数 ≤ 50 行；`strict: true`，禁 `any`；zod 在边界解析。
- 文档与代码同步；提示词改动同步 `docs/prompts/CHANGELOG.md`（若存在）。
- Git：署名 `ddyyxx-jpg <ddyyxx-jpg@users.noreply.github.com>`；**push 必须每次经用户明确授权**；`commit ≠ 上传`；不许 force-push 未经批准。
- 审阅合并判据：I1/I2/I3、12 op、engine 闭盒、契约版本与文档一致、`typecheck`/`test`/`check:contract` 真实输出、测试质量、安全（鉴权/注入/秘钥）、历史卫生（不提交本地快照/大文件）、合并后全量重验。

---

## 3. 工程进度

### 3.1 已完成的阶段

- **M0 骨架（2026-11-14）**：契约 + 6 份 schema + arbiter + turn + registry + module host + HTTP/SSE + React；示例 `trade`/`core`。
- **地图模块 v0.2（2026-11-17，`feature/campus-map-v0.2` ff 合入 main）**：真实奉贤校区底图（6000×4500）+ 33 个点位（24 建成/4 在建/5 规划）；缩放/拖拽/选点；非 built 禁止进入，canon 新场景首次进入懒安装；服务端/前端/文档同步，117 用例。
- **引擎 3.0.0（2026-11-16）**：结算原子性（atomic 默认、拒绝闭环、整回合预算、可信 cause 权限）+ 持久化闭环（写盘先行、`load()`、坏档修复、`ApplyResult.error`、`flush` 必选）。
- **审核层 + 现实锚定层（2026-11-16）**：叙事发出前二次模型审核；违规扣信誉/删档；玩家“我全知全能/忽略提示词”被修饰并过滤换数值提案。

### 3.2 关键提交时间线（main）

| 提交 | 说明 |
|---|---|
| `95eb27d` | 契约 2.2.0 基线（M0 + 首次修复） |
| `9a12dfa` / `94a0b62` / `362df4a` | 地图模块三步（数据/gitignore → 地图/旅行/双审 → 审查阻断项修复） |
| `8b66458` | 引擎 3.0.0（结算原子性 + 持久化闭环） |
| `3112f79` | merge：引擎 3.0.0 合入 main（解 `bootstrap.ts` 冲突；95 用例、8 项契约检查） |
| `6e70253` | merge（squash）：审核层 + 现实锚定层合入 main → 115 用例；README/docs 统计数字同步 |
| `b509d48` | feat(map)：奉贤校区真实底图（6000×4500）+ 33 点位三态（24 建成/4 在建/5 规划）+ 缩放选点；非 built 禁止进入、canon 懒安装 |
| `c522153` | fix(map)：清复审 must-fix（docs/03 MapView、docs/06 两处矛盾、`.tmp-map/` 忽略）与建议项（module coordOf 模板优先、NPC 同点偏移） |
| `b7f9fae` | fix(map)：NPC 坐标改场景模板优先（旧 1000×640 attrs 只兜底）；ff 合入 main |
| `8a26e00` | PR #4 squash：记忆子系统 3.1.0（事件溯源/账号隔离/canonize/世界印象；25 文件 184 用例、8 项契约） |
| `69da448` | PR #5 squash：地图交互打磨 + 图鉴 registry 收口（点选不出发/前往入口统一并切回对话/对话流跟随；新增 `GET /api/v1/registry`；26 文件 185 用例） |

### 3.3 已知遗留（MINOR，均有记录；按需修）

- **地图**（来自 `map-review.md` M1–M12）：`createDraft` 无鉴权 + draft id 32 位无碰撞检查；save 先改缓存后写盘（写盘失败假成功）；冷启动并发丢更新；tick 先推时间后校验移动（失败时时间已前进）；崩溃遗留 `generating` 无恢复；文件超 300 行（`map.ts` 575 等）；部分测试断言文案/fixture 偏差；docs 版本/坐标范围历史残留；app 层硬编码 map 数据路径；admin token 存 localStorage（已文档明示）。地图 v0.2：NPC 同点偏移 34 世界像素在 fit 缩放下屏幕差约 5px（视觉余量小、无测试）；偏移只读展示，不写状态。
- **引擎**：`readLog` 在读故障时已置 `loaded`（可能导致后续写入只含新事件 → 建议成功读取后再置位）；预算淘汰按插入顺序非 LRU；`bootstrap` 种子直写 + 种子 op abort 时可能半初始化；`trade` 端到端依赖地图/数据文件。
- **审核/现实锚定**：违规回合连同模块提案一起丢弃（`docs/05` §10.2 已写明理由）；审核测试断言 policy 模板文案（轻度）；子串匹配会漏变体/误伤正常句子（`docs/05` §11.4 已承认）。
- **文档**：`docs/03` §10.9 声明本层不改 `CONTRACT_VERSION`（仍 3.0.0，新增仅配置键/内容数据）；若团队要求配置键也 minor bump，则为 3.1.0。
- **记忆子系统（3.1.0）**：`perSourceCap` 缺可构造测试场景；`publish` 函数体 ~150 行（文件已 ≤300）；`memory.impression.queued` 事件注册但未发射（留联机广播用）；canonize 定时默认关（仅 admin 端点触发）；图鉴 `defaultsFor` 临时债归 issue #3。
- **前端（PR #2 临时债，issue #3）**：`GalleryPanel.tsx` 直读 `attrs.trust/guard/mood`（33/66 分档在前端）、`scenarios.ts` 硬编码 3 个开局与 NPC 档案；违反 I2，改名 registry 键会静默显示 undefined。owner 已拍板本次接受为临时债，**下一次涉及前端/图鉴的合并前必须完成**：服务端 GalleryView（按 registry 生成通用 stats，secret 只给分档）+ scenarios 数据化到 `content/scenarios/*.json`。PR #5（`69da448`）已收渲染键（registry 驱动、删 `trust/guard/mood` 字面键），剩 `/state` 原始数值通道、`self` 口径、`scenarios.ts` 数据化。

---

## 4. 分支记忆（按分支记录，详见 `AGENTS.md` §11）

> 格式：`- 日期 ｜ 分支 ｜ 提交 ｜ 类型 ｜ 改了什么 ｜ 决策与理由 ｜ 验证 ｜ 遗留`

### main

- 2026-11-17 ｜ main ｜ `v0.4.0`（commit 见 `git log`） ｜ release ｜ 建 `v0.4.0` tag + GitHub Release（notes 合并记忆 3.1.0 与地图/图鉴两段），Latest 指向 v0.4.0；CHANGELOG 两段「未发布」标题对齐 v0.4.0 ｜ 一次释放记忆子系统 + 地图交互/图鉴收口 ｜ 26 文件/185 用例；8 项契约（3.1.0） ｜ issue #3 余项仍待后续
- 2026-11-17 ｜ main ｜ `69da448` ｜ merge（squash PR #5） ｜ 地图交互打磨 + 图鉴 I2 收口：点选不出发/前往入口统一并切回对话/对话流跟随/标题页次要入口下沉；新增 `GET /api/v1/registry`（docs/03 §5.2.4，只给声明） ｜ 首帖针对旧 head `cd12771` 打过 request-changes（基线回退记忆接线、tsc 2 错、5 测试挂、CONFLICTING），作者 rebase 到 `b11ad5a` 后复跑全绿并 approve；squash 合并、PR MERGED ｜ tsc 0；26 文件/185 用例；8 项契约（3.1.0）；build:web 271.31 kB / gzip 86.66 kB ｜ issue #3 余项（数据通道/self/scenarios）仍需后续；tag/Release 未创建
- 2026-11-17 ｜ main ｜ `8a26e00` ｜ merge（squash PR #4） ｜ 记忆子系统 3.1.0 合入：事件溯源记忆（三层召回/1100 tok/两阶段裁决）、账号维度（userId/`/me`）、世界层 canonize 八闸门 + 独立 judge、世界印象投递、`CONTRACT_VERSION 3.1.0`；先 local merge `origin/main` 解 CHANGELOG 冲突（`b16dabd`）再 squash ｜ 三轮审阅：首轮打回（P0×5+P1×14）→ 6538123 修 P0/P1 → a544d3a 收尾 → 5c3e71a 清 P2 → 通过；squash 保留单提交、PR 标记 MERGED ｜ tsc 0；25 文件/184 用例；check:contract 8 项；`build:web` 未回归（本 PR 不动前端构建） ｜ tag/Release 未创建（如需要另办）；issue #3 仍在
- 2026-11-17 ｜ main ｜ `b16dabd` ｜ merge ｜ `origin/main` 合入 `feat/memory-module`，解 `CHANGELOG.md` 冲突（保留 PR #4 未发布段 + v0.3.0 段） ｜ GitHub 显示 pr #4 CONFLICTING，先合基再 squash ｜ tsc 0；184 用例；8 项契约 ｜ 无
- 2026-11-17 ｜ main ｜ 本提交（tag `v0.3.0`） ｜ release ｜ 建 `v0.3.0` tag + GitHub Release（notes 取 CHANGELOG 对应段），Latest 指向 v0.3.0 ｜ 让 CHANGELOG 标题、tag、Release 三者对齐 ｜ 17 文件/134 用例；8 项契约；build:web 269.06 kB ｜ 无
- 2026-11-17 ｜ main ｜ `45ea4d4` ｜ merge（squash PR #2） ｜ 前端体验与运行时模型接入（源 `feat/web-ux @ 805b50d`，含标题页/对话流/图鉴/打字机/settings 热切换/离线叙述） ｜ squash 保留单提交、PR 标记 Merged；审阅 M1–M5 已复核，旧 head e5672aa 被作者重建 ｜ tsc 0；17 文件/134 用例；check:contract 8 项；build:web 269.06 kB / gzip 86.02 kB ｜ I2 偏差作为临时债（issue #3），下次前端/图鉴合并前必须收口
- 2026-11-17 ｜ main ｜ —（PR #2 复审修订，父 e2cdfab） ｜ fix ｜ 按审阅 M1–M5 修订：MEMORY 行尾改 LF 并修正事实（父 e2cdfab、地图合入 0c70559/b7f9fae）；settings 补测试（探活失败不切换/文件往返/key 不回显/仅本机守卫）+ `clientFactory` 注入口 + 错误信息 key 脱敏 + 落盘 0600 + clear 重置 view；offline-narrator 补测试；`defaultsFor` 只播 public（secret/self 不预填）并补播种测试；map intent 对交易意图让位（「去食堂买面包」归 trade）并补路由回归 ｜ 逐条对应审阅 M1–M5；新增 17 个用例 ｜ tsc 0；vitest 133/134（唯一失败为上游既有的 Windows chmod 用例）；check:contract 8 项；build:web OK ｜ 建议项：App.tsx 已拆 ChatPanel、typewriter 回标题 stop；待 owner 拍板图鉴 I2 临时债
- 2026-11-17 ｜ main ｜ `45ea4d4` ｜ feat ｜ 前端体验与运行时模型接入合入本地树：标题页（选身份/继续/说明/关于/接入真实模型，独占步骤）、对话流开场剧情、图鉴（信任数值+戒备分档）、打字机逐字呈现（`typewriter.ts`）、Web Audio 按键音、CSS 过渡；服务端 `settings.ts`/`llm-switch.ts`（`GET/POST/DELETE /api/v1/settings/llm`，保存 `data/llm-settings.json` 重启恢复、仅本机）、离线叙述器 `offline-narrator.ts`、建房灌 public 属性默认值；map manifest 补 `keywords`（中文路由） ｜ 玩家自备 key 走面板热切换，环境变量优先；地图 v0.2（0c70559/b7f9fae 合入）全部保留，只叠加未改动文件的增量 ｜ tsc 0；17 文件/134 用例；8 项契约；build:web 269.06 kB / gzip 86.02 kB ｜ 图鉴直读 `attrs.trust/guard`（I2 偏差，docs/06 §7 已记录）；设置端点仅本机（loopback）可调用，非本机返回 E_FORBIDDEN；App.tsx 301 行（超 ≤300 上限 1 行）
- 2026-11-16 ｜ main ｜ —（本文件自身提交，sha 见 git log） ｜ docs ｜ 新增共享记忆 MEMORY.md 与 AGENTS §11 维护规范 ｜ 让跨会话协作者先读快照+分支记录，提交/审阅/合并时按分支追加条目 ｜ tsc 0；14 文件/115 用例；check:contract 8 项 ｜ 无
- 2026-11-16 ｜ main ｜ `6e70253` ｜ merge ｜ 审核层 + 现实锚定层（squash 自 `feat/reality-anchoring @ dc6be77`） ｜ 用 squash 避免 `30e7f01` 误提交的 `.ffqa/`+`defense/` 快照（7.3 MB）进入 main 历史 ｜ tsc 0；14 文件/115 用例；check:contract 8 项；build:web OK ｜ 见 §3.3
- 2026-11-16 ｜ main ｜ `3112f79` ｜ merge ｜ 引擎 3.0.0（结算原子性 + 持久化闭环） ｜ 先修引擎再合地图相关路径；解 `bootstrap.ts` 冲突时取并集 ｜ 95 用例、8 项契约检查 ｜ 见 §3.3
- 2026-11-16 ｜ main ｜ `95eb27d..362df4a` ｜ merge（ff） ｜ 地图模块 ｜ 地图不依赖引擎 3.0.0，可先 ff ｜ 76 用例、check:contract（2.2.0） ｜ 见 §3.3

- 2026-11-17 ｜ main ｜ `b7f9fae` ｜ merge（ff） ｜ 地图 v0.2 合入（源 `feature/campus-map-v0.2`，含 b509d48/c522153/b7f9fae） ｜ 分支与 main 同线、无冲突，ff 保留提交 ｜ tsc 0；14 文件/117 用例；check:contract 8 项 ｜ 待 push；遗留见分支小节
- 2026-11-17 ｜ main ｜ `CHANGELOG.md` ｜ docs ｜ 新增根目录更新日志（M0 / 引擎 3.0.0 / 审核与锚定 / 地图 v0.2，按日期分段） ｜ GitHub 上需要可读的更新日志；协议版本以 CONTRACT_VERSION 为准 ｜ tsc 0；14 文件/117 用例；8 项契约 ｜ 无
- 2026-11-17 ｜ main ｜ `CHANGELOG.md`（二次） ｜ docs ｜ 小节标题对齐 tag（v0.1.0/v0.1.1/v0.1.2/v0.2.0），拆出引擎与审核/锚定两段 ｜ 让 CHANGELOG 与 GitHub Releases 一一对应 ｜ tsc 0；14 文件/117 用例；8 项契约 ｜ 无

### feat/memory-module

- 2026-11-17 ｜ `feat/memory-module` ｜ `<P0>` ｜ docs ｜ 记忆模块 P0 契约：`CONTRACT_VERSION 3.1.0`、`PROMPT_VERSION 2026-11-17.1`、新增 `MemoryTier/MemoryStatus/MemoryProfile/ImpressionNotice`、`Memory.recall/profile`、`TurnRequest.userId`、`RoomMember.userId`、`memory.write` 只增字段、新事件 `memory.tombstoned`/`memory.impression.queued`、33 错误码、`memory.*/canonize.*/impression.*` 配置键、新建 `docs/prompts/04-memory-writer.md`、`00-world-system.md` 加 S1.5 世界记忆占位 ｜ 文档先于代码（§10.10 记录版本影响）；依据 `docs/08` §2；12 op 与 `apiVersion` 不变 → 3.1.0 为 minor（只增字段/类型/事件） ｜ tsc 0；17 文件/134 用例；check:contract 8 项（3.1.0） ｜ 下一步 P1：事件溯源 `memory.ts` + `memory.gate.ts` + 两阶段裁决
- 2026-11-17 ｜ `feat/memory-module` ｜ `<P1>` ｜ feat ｜ 记忆接通：`EventSourcedMemory`（事件投影 + `sync` 增量、`recall/profile/compact`）、`memory.gate.ts` 六道闸门（归属/形状/去重/重要度下限/秘密/配额）、`turn.memory.ts`（三层召回 + 1100 tok 硬顶 + 首轮种子 + 记忆 Proposal）、`turn.ts` 两阶段裁决（只有记忆被拒 → 去掉记忆重提并留 fact）、写后 `ingest`；模型输出新增 `memory[]`（`LlmMemoryDraftSchema`，ownerId 由引擎补） ｜ 记忆必须是"日志的索引投影"而不是第二个库，才能同时满足重启/回放/联机一致；记忆写坏不许毁掉玩家合法行动 ｜ tsc 0；19 文件/152 用例（新增 memory 11 + memory.turn 7）；check:contract 8 项（3.1.0）；`PROMPT_VERSION 2026-11-17.1 → 2026-11-17.2` ｜ 下一步 P2：用户库（userId 贯通/profile/种子/用户投影）

- 2026-11-17 ｜ `feat/memory-module` ｜ `<P2>` ｜ feat ｜ 账号维度贯通：`room.member.joined/left` 进投影（建房即写成员与 `userId`，solo = 1 个成员）；`POST /rooms`、`POST /rooms/:id/turns` 接受 `X-User-Id`/`userId`（缺省取 `GALGAME_DEV_USER`）；新增 `GET /api/v1/me` 返回 `Memory.profile`（只读派生，不写状态）；`createApp` 额外导出 `arbiter` 供测试/运维 ｜ 私忆隔离必须有账号键，否则"跨用户隔离"无从谈起；账号只决定看哪份档案，不是权限凭据 ｜ tsc 0；20 文件/155 用例（新增 user 3）；8 项契约（3.1.0） ｜ 下一步 P3：世界层永久记忆 + canonize 八道闸门

- 2026-11-17 ｜ `feat/memory-module` ｜ `<P3>` ｜ feat ｜ 世界层永久记忆：`packages/engine/src/canonize.ts`（`CanonizeJob`：候选=同内容 ≥2 个 owner 的 public+long 记忆；八道闸门 来源/公共性/隐私/独立审核/幂等/体量/不可变/回滚；发布走 `memory.write tier=permanent`，撤回走 tombstone）；`apps/server/src/canonize.ts`（`LlmCanonizeJudge` / `DenyAllJudge`，未配 = fail-closed）；`GALGAME_CANONIZE_*` 配置；`worlds/<id>/mem.version` 落盘；`POST /api/v1/admin/canonize/{run,tombstone}` ｜ 世界层写错一次所有玩家都受影响，因此闸门在代码里、审核模型必须独立、没配就全拒；世界层 = 同一事件日志的另一个房间，不新增存储 | tsc 0；21 文件/162 用例（新增 canonize 7）；8 项契约（3.1.0） ｜ 下一步 P4：印象投递 + `/me` 计数 + 抽样/熔断

- 2026-11-17 ｜ `feat/memory-module` ｜ `<P4>` ｜ feat ｜ 世界印象与观测：`impressions.ts`（`subjectTextOf`/`buildImpression`/`impressionFact`/`pendingNotices` + `Impressions` 端口）；canonize 成功后按 `aboutUserIds`（≤4）入队、`onImpression` 写 `data/users/<safeId>/impressions.json`（用户投影，非世界状态）；Turn 在 facts 追加 `【世界印象】…记住了你：…`（≤2 条、TTL 30 天、提交后才 `markDelivered`）；`GET /api/v1/admin/stats`（`CanonizeStats` + 按房统计 + 人工抽样）；judge 连续失败 `judgeFailureLimit=3` 熔断（`circuit_open`） ｜ 同一世界事件对不同玩家的投递结果不同，进世界状态会让回放依赖“谁在线”，所以印象是**用户投影**、坏了当空；投递失败宁可下次重复一次，也不要“说过又没说过” ｜ tsc 0；23 文件/171 用例（新增 impressions 5 + server impressions 3 + canonize 熔断 1）；8 项契约（3.1.0）；smoke 12 实体/幂等 OK ｜ 遗留：`memory.impression.queued` 事件保留未发射（联机广播时再用）；canonize 定时器未接（当前只有 admin 端点触发）

- 2026-11-17 ｜ `feat/memory-module` ｜ `PR#4 复审修复` ｜ fix ｜ 按 PR #4 审阅修 P0×5 + P1 核心：`store.events` 默认 Infinity（原 200 条导致 ~30 回合后记忆冻结）；`Memory.rebuild` + 启动重建房间/世界层索引；世界层版本从 `mem.version` 读回（重启不回退）、发布后 `ingest` 世界事件（S1.5 不再恒空）；`retireRoom` 不再丢事件；私忆 id 丢弃 contentHash（同内容不同 owner 各一条）；`memory.write` 四方字段对齐（+`userId,worldId`）；`events.json` 注册 3 个 memory 事件；提示词按 S1→S1.5→S4→S5→S6→S7→S8→S9 重排并加 `WORLD_MEM_VERSION` 标记、`buildPrompt` 透传 `mem`；`recall` 的 forced 不占预算、world scope 不按 userId 过滤；种子不再因世界层 permanent 跳过；`X-User-Id` 可关、`room_world_` 房间禁止 state/events/turns；`FileImpressions` 目录名 `sha256` 单射 + 投递前校验归属；canonize `enabled` 默认 true、`scanMinutes` 定时补扫（原 `sampleRate` 死键删除）；`canonize.ts` 455→208 行（拆 `canonize.candidates.ts` / `canonize.types.ts` / `canonize.publish.ts`） ｜ 世界层链路原本是断的（写进去没人读）；事件日志是唯一真源，所以重启必须重建索引；同一内容必须能属于多个 owner，因此 id 不能由内容派生 ｜ tsc 0；**24 文件 / 180 用例**（新增 e2e 4、memory +3、canonize +2）；check:contract 8 项（3.1.0） ｜ 遗留：`perSourceCap` 缺少可构造的测试场景；`publish` 函数仍 ~150 行（文件已 ≤300）；`GalleryPanel` 直读 attrs 的临时债按 issue #3 处理

- 2026-11-17 ｜ `feat/memory-module` ｜ `PR#4 二轮复审` ｜ fix ｜ 有条件通过后的收尾：① 接通 `attachAboutUserIds`（`turn.ts` 在 `applyMemoryGates` 前调用）+ 闸门重建草稿时保留 `aboutUserIds`（两处都断会导致世界印象恒不触发），新增 `apps/server/src/impressions.e2e.test.ts`（回合写记忆 → canonize → `data/users/*/impressions.json` → 下回合 facts 出现【世界印象】且投递后 pending 清零）；② 私忆 id 的 `turnSeq` 改用回合信封 `cause.seq`（时钟不推进的两个回合原本会撞 id）；③ G6 超限定版为**不建次日队列**（候选是房间记忆的纯函数，跨日重新聚合），docs/08 §7.3⑥ 改正文 + §13 记一行；④ P2 顺手项：`GALGAME_DEV_USER` 真正接线、`/health` 暴露 `canonize.{enabled,judge}`、tombstone 存在性改用记忆索引（不再 `sample(200)` 误判）、`WORLD_MEM_VERSION` 明确为格式版本；⑤ 补测试：`dailyCap` 跨日重聚合、`room_world_*` 404、`trustUserHeader=false` 忽略 `X-User-Id` ｜ 「世界记住你」是 P4 的卖点，链路只要有任一处没接就等于没做；候选不落队列是因为它与记忆是同源的纯函数，重复存储只会制造不一致 ｜ tsc 0；**25 文件 / 184 用例**；check:contract 8 项（3.1.0） ｜ 遗留：图鉴 `defaultsFor` 临时债归 issue #3；`publish` 函数体仍约 150 行（文件 ≤300）

- 2026-11-17 ｜ `feat/memory-module` ｜ `8a26e00` ｜ merge ｜ PR #4 squash 合入 main（源分支 `feat/memory-module @ 5c3e71a`；先 local merge origin/main 解 CHANGELOG 冲突 `b16dabd`） ｜ 三轮审阅通过后 owner 明确“合并并 push”；squash 保持单提交、PR MERGED ｜ 合并树 tsc 0；25 文件/184 用例；8 项契约（3.1.0） ｜ tag 未创建；issue #3 继续
- 2026-11-17 ｜ `feat/memory-module` ｜ `PR#4 三轮复审` ｜ docs ｜ 三轮复审「通过，可合并」后清 P2 文档欠账：`WORLD_MEM_VERSION` 语义统一为**记忆格式版本**（内容版本走 `worlds/<worldId>/mem.version`），同步 `docs/prompts/00:24`、`docs/08:254/315/347/377`、`docs/02:397`；`docs/07:232` 写清 `2026-11-16.1 → .1 → .2` 两跳；`canonize.test.ts` 的 duplicate 用例恢复 `expect(first.written).toHaveLength(1)`（否则"第二次被挡"可以在第一次也没写的情况下成立） ｜ 同一术语如果在正文里残留两种含义，后续协作者一定会按错的那份实现 ｜ tsc 0；25 文件 / 184 用例；8 项契约（3.1.0） ｜ 待 owner 决定合并方式

### feature/campus-map-v0.2

- 2026-11-17 ｜ `feature/campus-map-v0.2` ｜ `b509d48` ｜ feat ｜ 真实底图 + 33 点位三态与缩放选点；服务端 status/category/image、travel 拦非 built、canon 懒安装；docs/02/06、README、MEMORY 同步 ｜ 地图要“看得见找得到”，未建成点位只能看不能进；数据驱动（status 在 world_map.json），不改引擎 ｜ tsc 0；14 文件/117 用例；8 项契约 ｜ 首轮打回：docs/03 MapView 未同步、docs/06:56/:154 与实现矛盾、`.tmp-map/` 未忽略
- 2026-11-17 ｜ `feature/campus-map-v0.2` ｜ `c522153` ｜ fix ｜ 清首轮 must-fix 与多数建议 ｜ 文档与实现对齐；旧存档坐标用模板兜底 ｜ tsc 0；117 用例；8 项契约 ｜ 残留：NPC attrs 优先与文档冲突、34px 偏移视觉余量小、偏移无测试
- 2026-11-17 ｜ `feature/campus-map-v0.2` ｜ `b7f9fae` ｜ fix ｜ NPC 坐标改模板优先 ｜ 与 loc 同策略，避免旧房间 NPC 被旧坐标甩偏 ｜ tsc 0；117 用例；8 项契约 ｜ 复审通过，已 ff 合入 main

### feat/web-ux（PR #2，已 squash 合并）

- 2026-11-17 ｜ `feat/web-ux` ｜ `e5672aa` → `805b50d` ｜ feat+fix ｜ 标题页/对话流/图鉴/打字机/运行时模型接入 + 审阅修订 ｜ 首轮 review 打回 M1–M5（MEMORY CRLF、零测试、settings 无鉴权、默认值泄 secret、关键词抢 trade），修订后复审通过；GitHub squash 为 `45ea4d4` ｜ tsc 0；17 文件/134 用例；8 项契约；build:web OK ｜ 图鉴 I2 偏差 = issue #3 临时债；PR 标题已清“123456”前缀

### feat/map-ux

- 2026-11-17 ｜ `feat/map-ux` ｜ `cd12771` → `b11ad5a` → squash `69da448` ｜ feat+fix ｜ 地图交互打磨 + 图鉴 I2 收口（点选不出发/前往入口统一并切回对话/对话流跟随/标题页下沉；`GET /api/v1/registry` 只给声明；图鉴 registry 驱动、删 `trust/guard/mood` 字面键） ｜ 首版基线错误被请求修改（回退记忆接线），rebase 后复审通过；squash 合入 main ｜ tsc 0；26 文件/185 用例；8 项契约（3.1.0）；build:web 271.31 kB / gzip 86.66 kB ｜ issue #3 余项：`/state` 数值过滤、`self` 口径、`scenarios.ts` 数据化；分支在 fork，无法自动删

### feat/gallery-view-scenarios

- 2026-11-17 ｜ `feat/gallery-view-scenarios` ｜ `a0d58ac` ｜ feat ｜ issue #3 收口：新增 `GET /api/v1/rooms/:roomId/gallery`（服务端按 registry 生成 `GalleryView`：public 精确值 / secret 只给低中高三分档且响应不含精确数 / self 对他人只给分档、文本降级「—」 / hidden 不出现 / 未遇见不给档案与读数 / world+未知房间 404）与 `GET /api/v1/scenarios`（`content/scenarios/{openings,npcs}.json` 数据化，坏文件降级空表）；web `GalleryPanel` 改为只渲染 `GalleryView`、删 `api-registry.ts` 与前端 33/66 阈值，`scenarios.ts` 改 fetch 且失败显示「无预设开局」；docs/03 §5.2.5/§5.2.6、docs/06 §7/§8 同步 ｜ 可见性与分档口径放服务端才能保证"响应不含精确数字"；文案进 JSON 才符合 I2/I3；新端点独立成 `view.routes.ts` 并在 routes.ts 末尾独立区块挂载，减少与并行分支的冲突 ｜ tsc 0；**28 文件 / 191 用例**（新增 gallery 3 + scenarios 3）；check:contract 8 项（3.1.0）；build:web 268.65 kB / gzip 84.89 kB；`grep -rnE "attrs\.(trust\|guard\|mood)" apps/web` 空；审阅后修：未知房间改由 `listRooms()` 判 404（补真实 FileStore 路径测试）、self/secret 缺 min/max 降级 masked、文档 `GalleryStat.value` 收窄为 number ｜ 未做：`/state` 原始数值通道过滤、`self` 的"看自己"图鉴视图（本版本不提供）

### 历史分支（已合并 / 已删除，保留记录）

- 2026-11-16 ｜ `feature/map-module @ 362df4a` ｜ 已合并（`95eb27d..362df4a` ff，后随 main 进入 `3112f79`）；远端分支已删
- 2026-11-16 ｜ `fix/issue-1-atomicity @ 8b66458` ｜ 已合并（`3112f79`）；远端分支已删
- 2026-11-16 ｜ `feat/audit-layer @ 9f70c70` + `feat/reality-anchoring @ dc6be77` ｜ 已 squash 合并为 `6e70253`；远端分支已删。审核层第一轮被打回（audit 默认继承叙事模型 key 且写死模型名 → 静默开启），修复后复审通过；合并验证/报告见 `.review/reports/audit-reality-review*.md`
- 2026-11-16 ｜ `fix/arbiter-atomicity @ 400cb2c` ｜ 旧方案（2.3.0 未闭环），已被 3.0.0 取代；远端分支已删
- 2026-11-17 ｜ `feat/memory-module @ b16dabd` ｜ 已 squash 合并为 `8a26e00`；远端分支已删（仓库已开 `delete_branch_on_merge`，以后合入自动删）

---

## 5. 写入位置速查

- 本文件顶部「最后更新」与 §0 快照 → 合入 main 时刷新。
- 新分支 → §4 新增 `### <branch>` 小节；分支删除后保留并标注。
- 提交记录 / 审阅结论 / 合并记录 → 对应分支小节内追加一行。
- 新的架构事实 / 规范变化 → §1 / §2（先确认 `docs/03` 或 `AGENTS.md` 已同步）。
