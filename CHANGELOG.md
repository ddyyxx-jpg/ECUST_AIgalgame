# 更新日志

按合并到 `main` 的日期记录。提交 sha 可在 `git log` 中查；跨系统协议版本以 `CONTRACT_VERSION` 为准（产品版本见 `package.json`，当前 0.0.1）。

版本与 tag 对应：`v0.1.0` M0 骨架 → `v0.1.1` 引擎 3.0.0 → `v0.1.2` 审核/锚定 → `v0.2.0` 地图 v0.2 → `v0.3.0` 前端体验与运行时模型接入（PR #2）→ `v0.4.0` 记忆子系统 3.1.0 + 地图交互/图鉴 registry 收口（PR #4/#5）→ `v0.5.0` issue #1/#3/#7/#8 批量落地（PR #9–#13）→ `v0.5.1` 三条 issue 修复（PR #22–#24）→ `v0.5.2` 记忆可信边界 / 404 守卫 / tick 原子 / 部署边界（PR #43–#45，CONTRACT 3.3.0）→ `v0.5.3` Turn 幂等（PR #50）→ `v0.5.4` NPC 认识与名字解锁 + 地图出站脱敏/档案收窄（PR #52/#55/#56，CONTRACT 3.4.1）→ `v0.5.5`（候选版本号，尚未打 tag；发版时决定）简易用户系统 + 房间授权/行动额度（PR #72，merge 840e9c5，CONTRACT 3.5.0）→ `dev/v2` 群聊/微信八卦（PR #51，merge 02a3318）已合入 main（CONTRACT 3.6.0，13 op）→ `v0.5.6`（候选版本号，尚未打 tag；发版时决定）PR #123 打回修复批（14 commits，CONTRACT 3.6.0 不变）→ `v0.6.0` dev/v2 群聊 + 开放 issue 收口 + 像素 UI（PR #144 / #149 / #148，CONTRACT 3.6.2 → 3.8.0）。


## 未发布 — sim-v2 第一步：行动点 + NPC 动作租约 + 自动时钟

> 时间骨架，不改 op/契约（CONTRACT 3.8.0 不变）；所有状态变更仍走 Proposal → Arbiter。

### 新增
- **行动点**：`content/registry/attrs.json` 新增 `action_points`（plr，0..6，默认 6）。`TurnDeps.actionPolicy` 可按内容配置启用；不足时 `E_PRECONDITION` 且不调模型，扣点 `attr.delta{mustKeep:true}` 与回合提案同批 atomic，失败不扣。参数在 `content/sim/policy.json`。
- **NPC 动作租约**：`sim_lease`（npc，JSON 字符串，visibility self）。map 模块 tick 按“移动占 1 tick / 原地停留 2 tick / 租约未到期不接新动作 / phase 变化重排”维护，自动 tick 不会让 NPC 每拍重新决策。
- **自动时钟**：`apps/server/src/sim-clock.ts`，默认关闭；只推 `time.advance{ticks}`，到 `maxTick` 停下等玩家 `advance`，不替玩家切 phase。
- **推进时段回满**：`advance:true` 时在同一批里把玩家行动点回满。
- **对话打断 NPC 动作（D22）**：`/conversation` 的 target/interject 或 v1 `/turns` 的 `targetNpcId` 命中正在行动的 NPC 时，服务端把 `sim_lease` 冻结为 `{action:"talk",resume:原租约}`（空闲 NPC 也写 talk，防止对话途中被自动 tick 起新动作）；map tick 跳过 talk，回合结束（含异常）恢复原租约并继续剩余占用；talk 跨 phase 视为过期清空，并带 `expiresAt` 超时兜底（默认 12 tick），避免崩溃后永久冻结。

### 验证
- `npm run typecheck` 0 错；`npx vitest run` 128 文件/1051 例全过；`npm run check:contract` 8/8。
- 新增 `turn.action-points.test.ts`（含 FileStore 重启探针）、`sim-clock.test.ts`、`sim.policy.test.ts`，map 模块补租约/停留/跨 phase/超时用例，对话路由补数组 target、v1 `/turns` 与恢复失败不冒充已恢复的用例。

### 已知边界
- `travel` 不可达：map 模块按既有语义返回 `ok:true + 空 proposals`，回合仍会提交并扣 1 点；请求层随后复核位置才返回 `E_NOT_ADJACENT`（不额外扣点）。下一版在扣点前做邻接预检或退款。
- 旧存档没有 `action_points` 时不强制扣点；自动时钟默认关闭，需在 `content/sim/policy.json` 显式开启。
- 自动时钟与玩家回合的并发门禁尚未接（`isBusy` 只屏蔽后台任务，不屏蔽 `/turns` 与 `/conversation` 的回合）；回合进行中仍可能推一次 tick，放在下一版用房间活动锁收口。
- 单房间 tick 超过 30s 时只停止等待、不取消底层执行；在该 Promise settle 前，同房间的后续拍会跳过，避免重复排队。

## 未发布 — #151 复审两条 P1（`busy` 时自动进出室内）

> 仅前端表现层：不改契约、不新增 op、不动服务端；`CONTRACT_VERSION` 3.8.0 不变。

### 修复
- **P1-1 回合 streaming 中走到点位会发 travel**：`CampusMap` 的 160ms probe 原来只看距离，不看 `busy`（`busy` 只用于按钮 disabled），且 `busy` 是 props、interval 闭包读不到最新值。现在 probe 同步 `busyRef`，自动进入 / 自动 travel 都过新的纯函数 `stepEntryDwell` / `decideTravel`（`travelIntent` 只做纯谓词）：`busy` 期间不累计入口 dwell、不发 `travel`；回合结束后仍站在入口会重新数满 1.5 秒再进一次。
- **P1-2 室内站出口时回合没结束就切回大地图**：`InteriorMap` 的出口 dwell 同样加 `busy` 门禁（`stepExitDwell`）：`busy` 时清零计时、不触发 `onExit`；回合结束后重新数满 1.5 秒才退出一次。

### 复审补充（PR #152 复审 P3-2）
- 场景级自动 travel 原先只在「刚进入点位范围」那一拍评估：回合 streaming 中蹭进范围、回合结束后原地不动，就再也不会自动到达（入口 dwell 却会重新计时，两条路行为不一致）。现在被 busy 挡下的点位记入 `pendingTravelRef`，回合结束后仍站在旁边补发一次；判定抽成 `decideTravel`（`skip` / `defer` / `go`），`travelIntent` 退化成纯谓词参与判定。
- 传送失败仍是「离开再靠近才重试」——不会原地每 160ms 重发。

### 复审补充之二（PR #152 定向复审）
- `decideTravel` 返回 `skip` 时清掉同点位的 `pendingTravelRef`：否则「busy 时 defer 了 A → 手动 travel 到 A → 又走到 B 但仍站在 A 点位旁」会补发一次回 A。
- 删除被 `decideTravel` 取代的 `shouldAutoTravel`（生产已无调用），`travelIntent` 保留为纯谓词。
- `skip` 清待补点位也抽成纯函数 `nextPending(prev, sceneId, decision)`（`defer` 记下 / `go` 清空 / `skip` 只在同点位时清）：组件不再自己写分支，「手动到达待补点位后走到别处不回弹」有单测覆盖。
- 复审暴露的共性问题（闭包读 props、副作用逻辑不可测、多出口只修一个、非阻断项不落单、PR 描述落后）已写进 `AGENTS.md` §13。

### 测试
- 新增 `apps/web/src/map-autoenter.test.ts`（18 例）：busy 时站满不触发、busy 结束后重新计时并只触发一次、离开范围重新武装、同场景/已 travel 不重复发；`decideTravel` 的 `defer → go` 补发、pending 命中别的点位不发；`nextPending` 的四条落账分支（含 skip 清 pending）。
- 这两段逻辑原先埋在 rAF/interval 闭包里只能靠真人走查，抽成纯函数后可在 node 断言。
- #151 的其余非阻断项（`ENTER_DIST` 手感、`CandidatePanel` waiting 态、`pathfind`/`interior` 零单测、字体授权、资产体积、CSS 作用域）与本节新增的人工走查清单已落进 #150。

### 验证
- `npm run typecheck` 0；`npx vitest run` **125 文件 / 1018 例**全过；`npm run check:contract` 8/8（3.8.0）；`npm run build:web` 通过（`index-emAcvymE.js` 408.19 kB，gzip 127.75 kB）。


## v0.6.0 — 2026-11-22 像素风 UI + 开放 issue 收口 + dev/v2 群聊（PR #144 / #148 / #149；合入 main `657d6c5`；CONTRACT 3.6.2 → 3.8.0）

> 本版把三段工作一起发版：**像素风 UI / 室内二级地图 / NPC 寻路**（#148）、**开放 issue 收口批**（#149，含夜间密谋秘密出口的 P0 修复与 19 个 issue 收口）、**dev/v2 群聊运行质量批**（#144，CONTRACT 3.7.0，细节见下方 3.7.0 段——它是本版第一个纳入 tag 的契约版本）。
> `apiVersion` 3 / `SCHEMA_VERSION` 2 不变；13 个 op 闭集不变；`PROMPT_VERSION` 不变。
> 发布前最终验证（main `657d6c5`）：`typecheck` 0 错 / `vitest` 124 文件 1000 例 / `check:contract` 8/8（CONTRACT 3.8.0）/ `build:web` 通过。

### 像素风 UI / 室内二级地图 / NPC 寻路（PR #148，分支 `feat/campus-2d`）

> 以表现层为主：不改契约、不新增 op 原语；`CONTRACT_VERSION` / `PROMPT_VERSION` / `apiVersion` 均不变。
> 例外是信息馆一处**数据语义变更**（见下），已在 PR 描述中单独标注。

#### 新增
- **像素风 UI**：`pixel-ui.css` / `pixel-game.css`，HUD 与对话区改为像素风；配套 `zpix.ttf`（授权见 `apps/web/public/fonts/ZPIX-NOTICE.txt`）。
- **室内二级地图**：`InteriorMap.tsx` + `interior.ts`，图书馆/宿舍/食堂/实验楼等室内场景；进入只切渲染，不改世界状态里的 `locId`。
- **NPC 寻路与作息**：`pathfind.ts`（A*，600×450 网格、10 世界单位/格）+ 场景内 NPC 按作息换位置。
- **新校园底图**：`/map/campus-wide.jpg`（6000×4500）替换原 `/map/ecust-campus.jpg`。

#### 变更（数据 / 服务端语义，非纯美术）
- **`loc_info_hall`（信息馆）：`status: planned → built`**。`apps/server/src/map.ts` 对 `status !== "built"` 的点位返回 `E_FORBIDDEN`，改为 `built` 后该点位**可 travel、可进入室内**。
  同一批已把该点位的 `desc` / `tags` 从「图纸上的工地」改写为「已建成」，避免走进一个描述为工地的场所。

#### 修复
- **Windows 测试路径**：7 个 v2 测试文件把 `new URL(...).pathname` 换成 `fileURLToPath(...)`，修掉 Windows 下 `/D:/…` 被拼成 `D:\D:\…` 的 ENOENT。每文件 2+/1−，断言语义零变化。

#### 已知限制
- **前端不自动推进时间**：权威时间只由服务端推进（MapPanel「推进时段」或后续服务端定时），避免多 tab 叠加推进、以及挂机时白烧剧情成本（PR #148 审阅 P1-c）。
- `zpix.ttf` 个人免费、商用需授权；商用前须取得授权或替换为可商用像素字体。

### 开放 issue 收口批（PR #149，分支 `fix/pr147-review`；CONTRACT 3.7.0 → 3.8.0）

> 把四个开放 PR（#124 引擎 / #125 后端 / #126 前端 / #127 UI）按分类合入本分支，并把各 issue 的遗留缺口补齐到「真实链路可用」。覆盖 #76 #90 #94 #95 #96 #97 #98 #99 #100 #104 #105 #106 #122 #128 #130 #138 #139 #140 #146；#84（真实部署冒烟）需目标机实测，保持开放。`apiVersion` / `SCHEMA_VERSION` 不变；`PROMPT_VERSION` 不变。

#### 引擎（packages/、content/、契约文档）
- **结算前置条件 `expectAttrs`（#138，PR #124）**：`ApplyOptions.expectAttrs`（`AttrExpectation[]`，可选）在 `apply` 前逐条比对当前快照 `{entityId, key, expected: AttrValue|null}`（`null` = 该属性必须不存在）；任一失配整批拒绝 `E_PRECONDITION`，不试算、不落库、不消耗回合预算；顺序为先 `expectedSeq` 后本项；只承诺标量精确相等，不做深比较。空数组/未传时行为与 3.7.0 完全一致。**本批已接生产调用方**：`packages/engine/src/attr-expect.ts` 的 `expectAttrsFor(state, ops)` 只对 `attr.delta`/`attr.set` 产条件并按 `entityId+key` 去重，`Turn.applyBatch` 主批与记忆被拒重提批、v2 `commitStep` 都显式传入；`packages/engine/src/turn.expect-wiring.test.ts` 与 `conversation.test.ts` 断言真实 apply 入口带条件，`arbiter.expect.test.ts` 覆盖失配不耗预算 / 首失配整批拒 / 同房间并发串行 / 重启后按持久化值校验四问。`CONTRACT_VERSION` → 3.8.0（docs/03 §2.3、§10.28）。
- **后台任务协作式中止（#140）**：`canonize.retireRoom(roomId, {signal})`、`GossipHost.step(roomId, {signal})` 在候选循环、judge 前、落库前设检查点；`CanonizeReport.aborted` 标记中止，gossip 用既有 `gossip.dropped{reason:"aborted"}`，不新增事件类型/op。已落库批次不回滚。
- **密谋导演（#96/#128）**：`discoveryProposals(ctx, plot, kind, {attitudeAttr?})` 改为显式传键（引擎无 `moduleState` 写入口，旧写法永远读不到值），未传键不产 `attr.delta`；新增 `content/modules/investigate/`（`investigate.probe`，态度键来自 `data/config.json`），是 `activePlots`/`discoveryProposals` 的首个生产调用方。
- **存档导出/导入 fixture 修正（#99）**：`save-archive.test.ts` 的样例事件从 `turn.commit`（SSE 事件，从不落盘）改为真实的 `turn.committed` marker，并新增「导入 → 新 `FileStore` 实例读回 → `parseCommitEvidence`」探针；docs/02 §7.0 记录该约束。
- **#146 小项**：`llm.traceId` 优先 `x-ds-trace-id`；`fitMemoryContent` 导出后 `ownSpeechLines` 与落库同一截断口径去重；docs/03 的 `routes.ts` 行号锚点改为函数名锚点。

#### 后端（apps/server）
- **夜间密谋编排（#128）**：`map.tick()` 仅在真正进入夜间那一拍跑 `runNightPlot`：用进入夜间前的在场存活 NPC（≥2），`DialogueHost.open("npc.plot") → step → close`，提案单独第二批 `arbiter.apply(..., cause.type="dialogue")`，fail-soft；不碰 #38 的 `time.advance` 原子批；同夜重复 tick 不重复落账。`plot-night.route.test.ts` 用 `app.inject` 验证真实 `plot.upserted`/`memory.written`(private)/`attr.changed` 与 LLM 抛错时 tick 仍 ok。
- **后台任务账本与接管（#140，PR #125）**：`JobLedger` + `BackgroundCycle`（同房间单飞、generation 令牌、stall 看门狗强制接管、`takeovers`/`watchdogFires`/`terminalPersistFailures` 遥测、启动 `reconcileBackgroundJobs` 对账）；`bootstrap.ts` 两个扫描定时器仍走 `scanRoomJobs` 逐房隔离，并把 `{signal}` 传进任务体。`save-durability.test.ts` 的后台扫描用例改为串行触发（单飞锁下两种扫描不再并发），验收目标不变。
- **#146-1 结算断言**：`conversation.route.test.ts` 新增审核 blocked → `unconfirmed`、`maxAutoRounds:0` 的 auto 回合 → `failed` 两例。
- 复核已落地项：#90 会话快照被 `openOrReuse` 真正复用、#104 `/conversation` 共用 `TurnLedger` 且淘汰先 `host.close`、#105 地图草案共用 admin gate、#122 索引重建 merge 单调 + `.bak`、#100 历史上限可配（`GALGAME_HISTORY_LIMIT_MAX`）、#98 多槽存档、#95/#94/#97 验收。

#### 前端（apps/web，PR #126）
- 客户端前台恢复与三态探测：`conversation-api.ts` 的 `detectConversation`/`convModeAfterProbe`/`runConversationAuto`/`runConversationUtterance`，`App.tsx` 恢复时 `loadRoomThenReset` + `holdResumedBusy`；docs/09 §10。#106 MINOR 项复核已落地（URL `encodeURIComponent`、快照 tmp 名带 pid、SSE 15s 心跳）。

#### UI（apps/web 候选面板，PR #127 + #139）
- 候选行动面板 + 数字键 1–6 快选（输入框内不抢键）。**#139**：建议改为 `{text, kind}` 由来源侧给出（出口→`move`、在场 NPC→`talk`、`openings.json` 作者标注），删除中文前缀启发式；旧字符串仍可读，回退 `action`；`kind` 只影响分组/配色。docs/03 §5.2.6 登记形状与兼容策略。

#### 验证（本分支实跑）
- `npm run typecheck` → 0 错；`npx vitest run` → **120 文件 / 945 例**全过；`npm run check:contract` → **8/8**（CONTRACT 3.8.0，13 op，37 错误码）；`npm run build:web` 通过。
- 未做：#84 的 compose/Nginx TLS/证书/备份恢复目标机冒烟（`deploy:smoke` 只覆盖应用层局部链路）。

#### 审阅修复（PR #147 全量审阅的 P2/P3）
- **P2-1 delta 假接线**：`discoveryProposals` opts 增加 `delta?: number`，investigate 模块传 `config.delta`；测试断言 `delta === configJson.delta`。`kindFrom` 的中文关键词同步挪进 `config.json` 的 `kindPatterns`（数据驱动，参照 §4.7）。
- **P2-2 接管后写隔离**：`canonize.publish.ts` 与 `canonize.tombstone` 的 `arbiter.apply` 补 `expectedSeq`（load 到的 seq）；新增竞态用例（load 与 apply 之间世界房被推进 → 整批 `E_SEQ_GAP`，无交错写入）；docs/09 §9 写明「generation 只保锁/账本，world 写隔离靠检查点 + expectedSeq」。
- **P3**：docs/03 `AttrExpectation` 注释 3.7.0→3.8.0；v2 `StoreRetry` 带上 `expectAttrs`（重试批与首批同口径）；`conversation-api.ts` 三态注释修正；`npc.plot.ts` 拆出 `npc.plot.discovery.ts`（262+92 行）、`background-cycle.ts` 拆出 `background-cycle.types.ts`（279+76 行），均 ≤300 行且重导出保持调用路径。

#### 审阅修复第二轮（PR #147 被 revert 后重提：huaaaji 全量审阅 P0/P1/P2/P3）

> 背景：PR #147 合并后被发现 1 个 P0（夜间密谋秘密从玩家出口泄露）与 3 个 P1，已 revert；本批在 `fix/pr147-review` 逐条修复后重提。审阅原文要点：测试全绿≠功能正确，夜间链路只读 EventLog、不断言 HTTP 响应体。

- **P0 出口裁秘密**：新增 `apps/server/src/outbound-secrets.ts`，`/state`、`/events`、`POST /map/tick` 响应与 v1 `turn.patch` 的 SSE 全部过同一投影——`plot.upserted` 走引擎 `stripPlotSecrets`（`SECRET_PLOT_KEYS` 扩到含 `goal`，并与 dev/v2 共用同一份字段清单）；`memory.written` 只留 `public` 或 `ownerId===viewer`（viewer 由登录账号绑定解析，不信 query）；`/events` 的 `lastSeq` 取裁剪后最后一条。`plot-night.route.test.ts` 直接断言三处**响应体字符串**不含 `forbidReveal`/`leakPoints`/秘密原文，并反向断言 plot 的 `id/actors/status` 仍在（不是整条删掉蒙测试）。docs/04 §3.2 补出口口径。
- **P1-1 私忆 id 跨夜碰撞**：夜间 `cause.seq` 不再是常量 0，`memoryId` 因此跨夜唯一；用真实 5 次 tick 走完一天再进第二夜，断言两夜 4 条 `memoryId` 互不相同。
- **P1-2 夜间私忆没进索引**：`runNightPlot` 落库后逐条 `memory.ingest`，tick 后立刻可从 `MemoryIndex.all(roomId)` 召回（不再等下一回合或重启）。
- **P1-3 第 7 夜起永久失效**：`MapService.closablePlots` 在 active 配额将满时把**往夜**剧情 `plot.upsert(status:"resolved")` 与本次提案同批提交；没有可结案的往夜剧情时跳过本夜密谋并 `console.warn`（不再白调 LLM、也不静默失败）。investigate 侧补 `status:"leaked"` 收口（见 P2-4）。
- **P2-1 并发 `/map/tick`**：房间级串行队列（同一房间的 tick 排队、不同房间并行），入夜判定与 `expectedSeq` 都在锁内取值；`Promise.all([tick(),tick()])` 只产生 1 条 `plot.upserted`、只推进一天。
- **P2-2 canonize 的 `expectedSeq` 是虚假保证**：`basedOnSeq` 在任务开始 `load` 时捕获、每次成功 apply 后推进；`E_SEQ_GAP` 有界重试（≤2）只对未 abort 的活动任务生效，被 stall 接管的僵尸任务体遇到 `E_SEQ_GAP` 直接记错跳过，绝不重新 load 新 seq 插到新世代之后；tombstone 走同一 helper。竞态用例改为在 apply 入口注入 + abort signal，并新增僵尸任务体用例（apply 只 1 次、无交错写入）。
- **P2-3 后台对账逐房隔离**：`JobLedger` 按文件名校验 `roomId`（缺/错按坏行跳过并 warn），`reconcileBackgroundJobs` 逐房 try/catch，单房抛错只计入新字段 `JobReconcileSummary.skipped`，其余房间照常对账；测试覆盖缺 `roomId`、错放 `roomId` 不跨房写、整房抛错。
- **P2-4 investigate 无幂等**：probe 先用 fact 实体的 `tags` 记已查 leak 下标（同批 atomic 提交，`{plot}_{actor}` 隔离多人），重复调查不再写证据、不再 `attr.delta`，仍 `ok:true` 并给「已查过」fact；全部查完时产出 `plot.upsert(status:"leaked")`。选 fact 标记而非 `x.*` 属性：不占 `xWritesPerTurn`、不额外产生 `attr.changed`、随存档落盘可跨重启判重。
- **P2-5 前台恢复挂死**：新增 `timeout.ts`（`TimeoutError`/`ROOM_LOAD_DEADLINE_MS=8s`/`createDeadline`），`fetchState`/`fetchHistory`/`resume` 全链路透传 `signal`，超时给可重试提示并归还 `busyHold`；`room-enter` 加 `isLoading` 守卫避免迟到数据 reset 新房间；`dispose` 中止在途请求。
- **P2-6 auto 超限 notice 被当未确认**：`conversation.notice` 增加可选机器字段 `reason:"autoLimit"`（3.8.0，docs/03 §5.3 登记），客户端优先按 `reason` 判定已结算，文本匹配只作老服务端兜底——notice 文案来自 `content/v2/conversation-policy.json`（可改语言），不能作为协议。
- **P2-7 v2 下没有动态候选**：`playedTurns` 同时数 v1 `lines` 与 v2 `convLines`；v2 有 `view.position` 用服务端位置，否则从 `state.room.scene.presentIds` 推导在场 NPC 生成候选（`exits` 不编造）。
- **P3 收口**：`types.ts`/docs/03 的「与 3.6.0 一致」改回基线 3.7.0；docs/09 的 `#124 合入后为 3.7.0` 改为以 `version.ts` 为准，stallMs 口径统一为「配置下限 1000ms、构造参数下限 1ms（测试用）」；`CanonizeReport.aborted` 登记进 docs/03 且中止报告的 `candidates` 不再恒 0；`manifest.limits` 由宿主强制执行（`limitProposals`：`proposalsPerTurn` 截断 + warn 含 `E_OVER_LIMIT`，`maxArrayItems` 截数组 args；map 的声明上限按「每 NPC 一条 move」调到 64）；`isConversationAvailable` 接回探测路径；`ViewPatch.lists` 补进 docs/03 并注明前端未消费。

#### 验证（第二轮审阅修复后实跑）
- `npx tsc --noEmit` → 0 错；`npx vitest run` → **123 文件 / 978 例**全过；`npm run check:contract` → **8/8**（CONTRACT 3.8.0，13 op，37 错误码）；`npm run build:web` 通过（`index-A8yziaL-.js` 387.81 kB）。

#### 审阅修复第三轮（PR #149 审阅：3×P0 / 1×P1 / 7×P2 / P3）

> 背景：第二轮重提后 huaaaji 打回，指出「秘密出口还漏了三处，tick 的 `expectedSeq` 取值时机仍会让旧快照覆盖并发写」。本轮把**所有**玩家可达出口收进同一投影，并用「把修复还原后测试必须失败」的反向验证确认回归测试不是空转。

- **P0-1 `/map/travel` 的 Turn 事件**：`TravelResult.events` 里的 `turn.patch` 带着整份 `WorldState`（含 `plots`），旧代码只 `maskTurnEvents` 遮人名。现在 `MapService.outbound()` 对 `events` 逐条过 `projectTurnEventForPlayer`（travel 与 tick 共用）。
- **P0-2 `turn.patch.ops`**：v1 `/turns` 的 SSE 只裁了 `state`，`ops` 原样下发——含 NPC 私有 `memory.write`、`status:"tombstoned"` 的旧工作记忆正文、investigate 查完时的 `plot.upsert`（args 带 `forbidReveal`/`leakPoints`）。现在 `projectTurnEventForPlayer` 同时重建 `state` 与 `ops`（复用 dev/v2 的 `projectProposals`：非 public 的 `memory.write` 整条丢弃、`plot.upsert` 剥 GM args）。
- **P0-3 `memory.tombstoned.payload.reason`**：撤回事件的 `reason` 就是被撤回记忆的正文（`arbiter.ops.ts` 写入），玩家侧只留 `memoryId`/`supersedes`。
- **P1 tick 与并发写**：`expectedSeq` 改为在**取快照之前**捕获（原先在 `modules.tick`/`dryRun` 之后取值），tick 期间 `turns` 提交的 `scene.set` 不再被旧快照覆盖；并发场景由 `modules.tick` 内真实 `arbiter.apply` 模拟，断言 tick 返回 `E_SEQ_GAP` 且最终位置是并发那次写入。
- **P2-1 v2 前台恢复清空会话行**：`room-local-state` 新增 `convLines` 捕获/回填（同房 resumed 保留，换房/新开局清空），`room-enter` 的 capture→reset→restore 顺序有集成用例。
- **P2-2 v2 候选不完整**：`positionFromState` 不再硬写 `exits:[]`——从 `state.links` 推导双向 `located_in`（两端都是活跃 loc），在场者只认 `kind==="npc" && status==="active"`；新增 `candidatePosition` 在服务端 `pos` 为空时回落到 state 投影（travel 后的旧 pos 不再让候选整块消失）。
- **P2-3 canonize 重试窗口**：`applyWithSeqRetry` 在循环顶部与 `await store.load(...)` 之后都检查 `signal.aborted`（abort 可能发生在 load 内部），中止时返回内部哨兵 `E_ABORTED`，`publishCandidates` 记为 `skipped:aborted` 并出 `aborted` 报告——不再以新 seq 插到新世代之后。测试用受控 promise 把 abort 精确投在重试窗口内。
- **P2-4 tombstone 错误语义**：撤回改用 `tombstoneWithReason`；并发冲突 `E_SEQ_GAP` → `503 retryable`（此前一律报 409 `E_MEMORY_IMMUTABLE`，运维看到 409 不会重试），真不可变仍 409。取码顺序统一为批次级 `error` 优先。
- **P2-5 `manifest.limits.maxArrayItems` 在 intent/tool 路径失效**：`limitOutcome` 曾用「长度没变就返回原 out」判断，数组被裁剪时长度不变 → 裁剪被丢弃；现在一律以 `limitProposals` 结果为返回来源，intent/tool/tick 三条路径都有用例。
- **P2-6 auto 超限 notice**：客户端只认服务端机器字段 `reason:"autoLimit"`，删除英文文案兜底死代码（服务端文案来自 `content/v2/conversation-policy.json`，可改语言）。
- **P2-7 blocked auto 回合重试**：`retrySubmission(last)` 保留 `auto` 标记，重试走真正的自主轮，不再被空输入守卫吃掉。
- **P3**：`/map/tick` 的 viewer 改按登录账号解析（联机房不再用「1 号玩家」替别人过滤私忆）；v2 `playedTurns` 只数已提交的自身 utterance；候选位置按 `kind` 过滤（不再生成「和地点说话」）；`http.ts` 的 `TimeoutError` import 移到文件顶部；新增 `/turns`、`/map/travel`、`/events` 的响应体回归断言与 tombstone 503/409 路由用例。

#### 验证（第三轮审阅修复后实跑）
- `npx tsc --noEmit` → 0 错；`npx vitest run` → **124 文件 / 994 例**全过；`npm run check:contract` → **8/8**（CONTRACT 3.8.0，13 op，37 错误码）；`npm run build:web` 通过（`index-CMLyLKtQ.js` 388.62 kB）。
- 反向验证：把 `expectedSeq` 取值挪回旧位置 → 并发用例失败；把 outbound 投影还原 → 三处 P0 用例失败（证明断言真的盯着出口，而不是只读 EventLog）。

#### 审阅修复第四轮（PR #149 复审剩余 2×P2 + P3）

- **P2-1 v2 前台恢复重放开场 / `playedTurns` 归零**：新增 `shouldReplayOpening({restoredLineCount, keptConvLines})` 与 `playedTurnsOf(convMode, lines, convLines)` 两个纯函数——v2 房间没有 v1 history，但本地保留了 `convLines` 时不再重放「身份 → 正文」；回合数改数 `convLines` 的玩家行（`convView` 会被 reset，数它必归零）。三条用例覆盖「保留会话行 / v1 有 history / 真新开局」。
- **P2-2 v2 travel 后候选停在旧地点**：`candidatePosition` 先比 `pos.locId` 与 `state.room.scene.locId`——不在同一场景就以 state 投影为准（`enterScene` 只改 `locId`，旧 `actors/exits` 是上个地点的）；同场景且非空仍用服务端 `pos`。
- **P3 重启后首拍 tick 假 `E_SEQ_GAP`**：`seqOf` 改为 `await store.load(roomId)`（`seq()` 在未载入时只会给 0）；夜间第二批同样走它。新增「新 store 实例只持有磁盘事件 → 直接 tick」探针，反向验证：改回 `seq()` 即失败（seq 停在 0）。

#### 验证（第四轮复审修复后实跑）
- `npx tsc --noEmit` → 0；`npx vitest run` → **124 文件 / 1000 例**全过；`npm run check:contract` → 8/8（3.8.0）；`npm run build:web` → `index-XOequiWb.js` 388.79 kB（gzip 121.13 kB）。

## 3.7.0（2026-11-21，PR #144）— dev/v2 运行质量批（issue #130 子项 #131–#137，CONTRACT 3.6.2 → 3.7.0）

### 新增
- **提示词上下文重构（#131）**：NPC 提示词固定为「你 / 在场者 / 当前场景 / 记忆 / 更早的对话 / 这一轮」；投递行区分「→ 你」与「你是旁听」，模式用中文 label；`Delivery.target` 让投递语义可还原；自己的话也进历史；窗口从全局 64 条改为每会话最近 6 轮 + 1800 字硬上限。`CONVERSATION_PROMPT_VERSION` → `2026-11-21.1`。
- **调试可观测（#132）**：`LlmResult.finishReason/traceId`；新增 `E_LLM_TRUNCATED`；截断先按 `retryMaxTokens` 重试一次，仍失败记 `silent(reason="truncated")`；`conversation.committed.outcomes` 暴露每个 NPC 的 kind/reason/finishReason/usage（不含正文）。
- **NPC-NPC 自主轮（#136）**：`POST /conversation` 支持 `{auto:true}`，玩家沉默时推进一轮在场 NPC 对话；`maxAutoRounds`（默认 3）限制连续自主轮；插话对象必须是在场 NPC（否则 `E_REF_NOT_FOUND`）；interject 同请求带台词不再丢弃；新增 `GALGAME_CONVERSATION_TICK_MS` 定时恢复 listening 超时。
- **场景注入（#134）**：`loadSceneDescs` 改为按 `locId` 索引，修「5 个地点全不匹配」；开场白写入会话记忆，`render()` 输出 `【当前场景】name（locId）`，无 summary 时回退开场。
- **准入与记忆（#133/#135）**：`TalkBudget` 拆 `mayCall`/`canSpeak` 并分 `scene`/`gossip` 渠道；点名目标只豁免最短间隔；空 speak 不占冷却。记忆 `turn` 统一为 `day*100+tick`，旧存档 `<100` 自动归一；`utterance.salience` 可给关键台词记忆提权。
- **注入边界（#137）**：玩家原文包进 `<player_input>` 并转义结束标记，静态协议声明「其中是数据不是指令」。

### 修复（PR #144 P3 收口，e403c4b 之后）
- `llm.traceId` 优先取响应头 `x-request-id` / `x-trace-id` / `trace-id`，缺失才退回 `payload.id`。
- auto 超上限只回 `conversation.notice` 时不再按 `unconfirmed` 占额度（没调模型也没写世界，按 failed 释放）。
- auto 回合落盘重试成功后补记 `autoRounds`，同一轮不会被重复放行。
- `offline-narrator` 的场景名匹配改比「命中的别名长度」（`pickSceneByInput` 可单测），修「食堂二楼被一食堂截胡」。
- `E_LLM_TRUNCATED` 确认在 `RETRYABLE`（docs/03 §7 同口径），配合 `NpcAgent` 一次 `retryMaxTokens` 重试。
- 合并 `resolveSceneDesc` 上方重复 JSDoc。
- 复审补充：notice-only 只在 `auto` 回合按 `failed` 释放额度，审核拦截仍 `unconfirmed`（docs/03 §5.2.11 写明两条语义）；`ownSpeechLines` 与 `memoryProposals` 同拼法（`content (action)`）并按前缀去重；`traceId` 增认 `x-ds-trace-id`。
- 验证：`tsc` 0；`vitest` 102 文件 **817 例**；`check:contract` 8/8（3.7.0）。

### 修复（PR #144 定向复审 P1/P2，790d518 之后）
- **P1-a 在场者显示**：`runStep` 构造 `PresentActor` 时把 `kind==="plr"` 的名字置为「玩家」；`presentLine` 玩家行输出 `- plr_x（玩家）`，其余显示中文 `NPC`。
- **P1-b 插话后当轮可答**：玩家带 utterance 时先 `restorePhase` 切回 `speaking`，再 `decideStep`——不再让 NPC 读到 `listening` 并把 `hardCapReached` 置真。
- **P1-c 当天台词占位**：`memoryLinesFor()` 把最近一轮的 1–2 条固定置顶，5 条高分旧记忆不再挤掉当天台词；行内带 `[第N天·地点] 你说过：` 来源标签。
- **P2**：`utterance.salience` 补进 `ConversationBodySchema`（docs/03 已登记却 `.strict()` 拒收）；`conversation-policy.json` 的 `llm.maxTokens` 600 → 1600；审核拒绝/不可用分别记 `audit_blocked`/`audit_unavailable`；台词记忆写地点 tag（不再零重叠）；secret forced 注入上限 3 条；docs/v2 开场广播口径改为「写进 SceneMemory、首轮起半常驻注入」。

### 修复（PR #144 遗留项）
- **#134 名字回退**：新增 `resolveSceneDesc(descs, canonIdByName, {locId, locName})`——只拿到 canon 名（如「图书馆」）时先经 canon 名→id 解析再取地图描述，不再 5 个地点全 miss；`describe` 改用该函数。
- **#136 前端自主轮**：`runConversationAuto()` + ChatPanel「让他们继续聊」按钮（v2 时可见），玩家不说话也能推进一轮 NPC 对话，受服务端 `maxAutoRounds` 限制。

### 修复（PR #144 复核）
- **投递行玩家标注**：`nameFor` 把 `kind === "plr"` 的实体显示为「玩家」（不再露出实体名「你」）；自己的台词显示「你说 → X」/「你公开说」，不再误标「你是旁听」；定向通知里的 `nameOf` 同步走该映射，`{target}` 替换为「玩家」。

### 变更
- 验证：`tsc` 0 错；`vitest` 101 文件 **810 例**全过；`build:web` 通过；`check:contract` 8/8（3.7.0）。
- `CONTRACT_VERSION` 3.6.2 → 3.7.0（只增可选字段 `Delivery.target`、`Utterance.salience`、`LlmResult.finishReason/traceId`、`committed.outcomes`、请求体 `auto`，新增错误码 `E_LLM_TRUNCATED`；见 docs/03 §10.27）。

## 3.6.1 → 3.6.2（2026-11-21，PR #120 / #121，CONTRACT 3.6.0 → 3.6.2；未新增发版号）

> 合并顺序 #120（merge `b41c7e7`）→ #121（merge `48dbfd1`）。两笔都是数据层安全性修复，不新增 op、错误码、HTTP 端点；`apiVersion` / `SCHEMA_VERSION` / `PROMPT_VERSION` 不变。**本次只按契约版本记账，不新增产品发版号、不打 tag。**

### 3.6.1（PR #120，#115）：坏档隔离校验

- 房间日志载入改为**整份严格校验**：Envelope 结构、房间归属、seq 连续、私信负载与房间归属、以及逐条投影；任一失败 → 保留原日志文件不动、该房间端点返回 `503 E_STORE_FAULT`，健康房间照常启动。
- 前置 #114（PR #118，已随 3.6.0 合入）把读取 / 列目录收敛为**仅 `ENOENT` 按缺失**、其余故障上抛且不置 `loaded`；本版在其上把"半截行 / 结构不符 / 投影失败"也纳入同一口径：整份校验失败 → 503 且保留原件，启动期重建遇到非 `ENOENT` 直接失败（fail-fast，不再静默当空表）。
- `scripts/replay.ts` 复用同一套投影校验，坏档不再"回放通过"。
- 契约：`CONTRACT_VERSION 3.6.0 → 3.6.1`；文档见 docs/03 §2 纪律 #3、§10.25 与 docs/10 的坏档恢复步骤。

### 3.6.2（PR #121，#117）：提交持久性与结果待核对

- 新增 `RoomLogWriter`：临时文件写入（flush）→ 原子 `rename` → 同步所在目录；替换前失败可安全重试。
- 替换后目录同步失败 → `StoreCommitUnknownError`（`E_STORE_FAULT`）：房间进入待核对状态（`RoomStorageBlockedError`），**已提交的回合仍按本批 seq 与投影确认**，不被后续故障抹掉；当次额度记 `unconfirmed`，`turn.error.retryable=false`。
- `apply` 新增 `captureState` / `stateAfter`：返回本批投影的独立快照，避免落盘后读 store 与另一批交错。
- 后台扫描按房隔离（`apps/server/src/room-jobs.ts`）：单个坏房间不再中断整轮 canonize / gossip。
- 契约：`CONTRACT_VERSION 3.6.1 → 3.6.2`；文档见 docs/03 §2 纪律 #1、§7、§10.26 与 docs/10 §7.1。

### 验证（2026-11-21 在 main `48dbfd1` 复跑）

- `npm run typecheck` → 0 错。
- `npx vitest run` → **100 files / 775 tests** 全过。
- `npm run check:contract` → **8/8**（CONTRACT 3.6.2）。
- `npm run build:web` → 成功（`379.91 kB`，gzip `117.78 kB`）。

### 已知边界

- 单进程单写者；不提供跨进程锁 / 租约（沿用 docs/10）。
- 目录同步失败后的"待核对"标记只在进程内：重启不会消解可疑结果，须先人工核对存档。
- 3.7.0 批（PR #144，issue #130 子项）已在 main，并记录在本文件下方 `## 3.7.0` 段（随 v0.6.0 一起发版）；本段只覆盖 3.6.1 / 3.6.2，不重复记账。
- `turn.committed` 登记已在 v0.5.6 完成（`content/registry/events.json` 共 11 条；payload `{clientTurnId,turnId,actorId,committedSeq,narrative?,facts?,usage?}` 与 `packages/engine/src/turn.evidence.ts` 对齐），本 PR 只复核、未改动。

## v0.5.6（候选 tag，尚未打；发版时决定）— 2026-11-20 PR #123 打回修复批（14 commits，CONTRACT 3.6.0 不变）

> 合并前登记。基线 `6524420` → PR #123 head `2183828`；14 commit 覆盖 #76/#84/#90/#94/#95/#96/#97/#98/#99/#100/#104/#105/#106/#122。按「只增登记、不改契约」执行：13 op、`apiVersion`、`CONTRACT_VERSION`、`PROMPT_VERSION`、§7 错误码集合均未变（逐条见 docs/03 §10.24）。

### 新增

- **槽位存档（#98）**：`GET/POST/PUT/DELETE /api/v1/me/saves/slots`、`SaveSlot`、`SaveEntry.slotId` 与 `/me/saves` 的 `slots[]`；只删槽映射，不删房间事件日志/历史。拒绝路径复用已有错误码（400 `E_SCHEMA_INVALID` / 404 `E_REF_NOT_FOUND` / 409 `E_ID_TAKEN` / `E_OVER_LIMIT`）。
- **存档导出/导入归档（#99）+ 只读重建（#122）**：`scripts/export-save.ts`、`scripts/import-save.ts`、`scripts/rebuild-saves.ts`；归档格式见 docs/02 §7.0，重复导入按 id 跳过。
- **历史行上限可配（#100）**：`history.limitMax` / `GALGAME_HISTORY_LIMIT_MAX`（默认 200），限制单次响应行数，更早历史用 `earlierCursor` / `before` 翻页。
- **玩法/导演补口（#96/#97）**：npc.plot 密谋导演、study 最小模块；只加内容，不改引擎。
- **部署冒烟入口（#84）**：`npm run deploy:smoke`（`scripts/deploy-smoke.ts`），覆盖鉴权/CSRF/限流/邀请码/数据卷持久化。

### 修复 / 变更

- **跨重启幂等（#76）**：引擎在成功批次末尾写 `turn.committed` marker（payload `{clientTurnId,turnId,actorId,committedSeq,narrative?,facts?,usage?}`），重启从 EventLog 重建 `seen` 并补齐历史；本批把该事件补登记到 `content/registry/events.json` 并同步 docs/03 §4、docs/04 §3.2、docs/11（此前文档称「从未发射」已过时）。只增登记，不 bump 版本。
- **会话快照端到端恢复（#90）**：恢复的会话由路由 `openOrReuse` 复用，不再是孤儿；坏档只降级该房为新会话。
- **群聊额度统一（#104）**：`/conversation` 与 v1 `/turns` 共用 `TurnLedger`，预留/结算同房间串行；超额度 429 `E_RATE_LIMITED`、冲突 409 `E_PRECONDITION`/`E_TURN_BUSY`。
- **interject 口径对齐（#106）**：无绑定角色 → 400 `E_SCHEMA_INVALID`；有绑定角色的 interject-only 预留额度并落 `unconfirmed`（文档不再写「不计入额度」），长流每 15s 发 SSE 注释心跳。
- **管理端点鉴权统一（#105）**、验收测试补口（#94/#95）：不改契约。

### 验证（lead 在 PR #123 修复分支实跑）

- `npm test` → **93 files / 725 tests** 全过；`npm run check:contract` → **8/8**（CONTRACT 3.6.0）；`npm run deploy:smoke` → **12/12**。
- 本批为纯文档/契约登记改动；文档 worktree 的 `npm run typecheck`、`npm test`、`npm run check:contract` 复跑输出见交付报告。

### 已知边界

- `turn.committed` 只补登记（事件已在代码发射），**不 bump `CONTRACT_VERSION`**；registry 中 `broadcast:false`，只进 EventLog，不向客户端广播。
- 每回合因 `attr.changed` + marker 共多 1 条 seq；`commit.seq == marker.seq == committedSeq`，历史 `earlierCursor`/分页按此口径。
- 有绑定 `actorId` 的 interject-only 落 `unconfirmed`，额度仍占占用态，需后续对账结案（不是免费）。
- `deploy:smoke` 12/12 只证明应用层局部链路，**不覆盖** Docker compose、Nginx TLS/域名隔离、自签证书与备份恢复，后者仍须目标机实测。
- 单进程单写者、`actionsEnabled` 全局暂停、`unconfirmed` 需人工对账等沿用 v0.5.5 已知边界。

## 3.7.0（未合并，PR #124 / `pr/engine`；CONTRACT 3.6.0 → 3.7.0）

> 3.7.0 是 **minor**：只新增可选参数，不改已有语义；**不新增 op 原语**（仍 13 个）、**不新增错误码**（仍 36 个），不改 `apiVersion` / `PROMPT_VERSION`。本 PR **无生产调用方**（仅提供守卫能力，生产接入未做，跟踪 [#138](https://github.com/ddyyxx-jpg/ECUST_AIgalgame/issues/138)），`expectAttrs` 保持纯可选能力。

- 新增 `ApplyOptions.expectAttrs`（`AttrExpectation[]`，可选）：`apply` 前逐条比对当前快照 `{ entityId, key, expected: AttrValue | null }`（`null` = 该属性必须不存在）；任一条失配 → 整批拒绝 `E_PRECONDITION`，不进入试算（simulate）、不落库、不消耗回合预算；校验顺序为先 `expectedSeq`、后本项；空数组/未传时行为与 3.6.0 完全一致。校验只承诺**标量精确相等**（`AttrValue` 只有 number/string/boolean），**不承诺深比较/数组语义**（docs/03 §2.3）。
- 失配返回在预算记账与事件追加之前，预算账本与 `seq` 均不变；`E_PRECONDITION` 为既有错误码，仅补触发场景说明（docs/03 §7、§10.24）。
- 测试：新增 `packages/engine/src/arbiter.expect.test.ts` 补 §12.2 四问闭环——①失配不消耗预算（同一预算随后提交成功，证明额度未被白吃）②多条 `expectAttrs` 逐条校验、首个失配即整批拒绝且无部分写入 ③同房间并发两次 `apply` 仍串行（`exclusive` 链；两条都带 `expectAttrs`，后一个按前一个提交后的值失配）④真实 `FileStore` 写入后重开、`load`/`snapshot` 再 `apply`，`expectAttrs` 在重启后仍按持久化值正确校验。
- 验证（本 worktree 实跑）：`npx vitest run packages/engine/src/arbiter.test.ts packages/engine/src/arbiter.expect.test.ts` → 2 文件 / 22 用例全过；`npm run typecheck` → 0 错；`npm run check:contract` → 8/8（CONTRACT_VERSION=3.7.0，13/13 op，36/36 错误码）。
- 遗留：Turn/结算路径尚未接入 `expectAttrs`（本 PR 仅提供守卫能力，生产接入未做，跟踪 [#138](https://github.com/ddyyxx-jpg/ECUST_AIgalgame/issues/138)）；实际接入与全量测试留待后续 PR。

## 3.6.0（dev/v2，2026-11-19）

- 第 13 个 op `msg.send`：NPC 之间/玩家给 NPC 的模拟私信（只有目标+内容），`Envelope.audience` 在 Transport 前过滤；模块 `apiVersion 2→3`。
- 新增 `MessageIndex`、`TalkBudget`、`GossipHost/GossipAgent`、dm 模式、gossip 私忆可信通道；微信内容入库前审核。
- 群聊引擎（v2）与群聊对话模型、前端影响清单、模块适配度检查随 dev/v2 一并交付。

## v0.5.5（候选 tag，尚未打；发版时决定）— 2026-11-19 简易用户系统 + 房间授权/行动额度（PR #72，合入 main `840e9c5`；CONTRACT 3.4.1 → 3.5.0）

> 3.5.0 是 **minor**：新增 HTTP 端点、`E_UNAUTHORIZED`（错误码 34 → 35）与会话配置键；不新增 op 原语，不改 `apiVersion` / `PROMPT_VERSION`，模块与导演接口不变（详见 docs/03 §5.2.8/§5.2.9/§5.2.10/§10.20）。本 PR 是已回滚的 PR #19（回滚 PR #71 / merge `35e0c57`）的重提版，基线为回滚后的 main 并合入地图脱敏/气泡刷新修复（#57/#58）。

### 新增

- **简易用户系统**：邀请注册 + 用户名密码 + HttpOnly Cookie 会话；`userId` 由服务端签发；`/api/v1/auth/{register,login,logout,me,status,reset-password,password}` 与 `me.role/state/nickname?`；`authRequired=1` 时除公开端点外一律 401 `E_UNAUTHORIZED`。前端新增 `AuthScreen` / `use-auth` / `api-auth`，移除 localStorage 身份。
- **房间授权 gate（#33）**：state/events/turns/map 系列/gallery/history 等房间端点先过存在性守卫（§10.15，#37）再校验成员资格，写操作绑定 `actorId` 与会话用户；有归属房间非成员 403，旧档在 `authRequired=1` 下默认不开放，admin-token 为运维例外。
- **额度与行动核对（§5.2.10）**：额度状态机与行动核对、邀请码/角色/状态/重置凭证/会话撤销/总开关；额度账本追加 `fsync` + 坏行跳过计数（`skippedLines`）；管理员结案仅限 `unconfirmed` 且并发结案串行化；`defaultDailyTurns=null` = 不限。
- **管理端点与审计日志（§5.2.9）**：`apps/server/src/admin-log.ts` 操作日志；`/api/v1/admin/*` 管理员令牌统一 sha256 + `timingSafeEqual`，显式令牌 <16 字符或熵 <96 bit 拒绝启动，带令牌失败按 IP 10 次/60s → 429 `E_RATE_LIMITED` + `Retry-After`；CSRF Origin 覆盖全部 auth 写路由；公开 `/health` 脱敏为 `{ok, contract}`，canonize 运维细节移入鉴权后的 `/admin/stats`。
- **部署资产**：`Dockerfile`、`docker-compose.yml`、`.dockerignore`、`.env.example`、`deploy/README.md`、`deploy/nginx-ecust-galgame.conf`（IP 直连 + 自签证书 + 404 catch-all 域名隔离）、`scripts/admin-init.ts`；账号库损坏 fail-fast（#35），旧 `users.json` 自动迁移为 `auth.json` v2（写盘前整体校验）。

### 修复 / 变更

- 已提交回合不被旁路异常改写：收到 `turn.commit` 后姓名解锁/脱敏快照异常只记日志，账本保持 `committed`，事件照常下发，兜底错误不再标记 `retryable`。
- 地图写入口遵守全局暂停：`actionsEnabled=false` 时 `map/travel`、`map/tick`、`map/dialogue` 返回 429，暂停期间不推进时段、不写回合历史。
- 存储故障统一 503 `E_STORE_FAULT`：房间已确认存在后 `snapshot` 失败不再折叠成 404；历史追加前先写换行，避免半截尾行吞掉下一条记录。
- 历史分页：默认最近 `limit` 条 + `before` 向后游标 + `hasEarlier`；`TurnHistoryLine.clientTurnId?` 仅落盘。
- 身份来源改为 HttpOnly Cookie；`X-User-Id` / body `userId` 仅在 `authRequired=false` 时兜底；旧 localStorage 身份不迁移。

### 验证（PR #72 / commit `840e9c5` 复跑输出）

- `npm run typecheck` → 0 错；`npm test` → 64 文件 / 478 用例全过；`npm run check:contract` → 8/8（CONTRACT 3.5.0，35/35 错误码）；`npm run build:web` → 295.53 kB / gzip 94.57 kB。（在 `840e9c5` 独立 worktree 实跑确认；旧稿「63 文件 / 467 用例、295.03/94.37」来自 PR #72 未复跑声明，已按复跑结果更正。）

### 已知边界（沿用 PR #72 描述与 deploy/README.md §6）

- 会话是进程内存态：重启/重新部署后所有人需重新登录；会话过期项靠访问时清理，只在一台进程内。
- 单进程单写者：`data/` 同一时刻只能有一个 server 进程写（额度账本、账号库、事件日志均无跨进程锁）；扩容/滚动发布须停旧起新，不能双跑。
- 额度 `defaultDailyTurns=null` = 不限；要控成本须在 `PUT /api/v1/admin/settings` 显式给数值。
- 跨重启 Turn 幂等未做：PR #50（v0.5.3 / CONTRACT 3.3.0）只提供进程内幂等，重启后同一 `clientTurnId` 仍会重新结算；跨重启恢复需 EventLog 持久化回合标记 + 契约变更（未做）。
- 旧 localStorage 身份不迁移：残留的 `galgame.adminToken` / 本地 `userId` 已不再被读取、不自动清理；用户清一次 localStorage（或换浏览器）即可，账号数据在服务端 `data/auth/`。
- `unconfirmed` 额度仍需人工对账（等上游 #34 类持久提交事实）；admin token 不自动轮换；`GALGAME_PUBLIC_ORIGIN` 须与浏览器地址栏的源逐字一致；`GALGAME_TRUST_PROXY=1` 仅在反代后开启。

## v0.5.4 — 2026-11-18 NPC 认识与名字解锁 + 地图脱敏/档案收窄（PR #52/#55/#56，合入 main `2547d73`；CONTRACT 3.3.0 → 3.4.1）

### 新增

- **陌生人与认识机制**：新增 `knows_name` 属性（一级口径 = 知道名字才算认识）；未认识 NPC 在 `/map`、`/map/dialogue`、图鉴、`/state`、`/history`、`/turns`/`/events` 中统一下发外貌占位名（`appearance` 优先，缺失用序号）。
- 新增 `content/modules/introduce`：自述姓名写“首次见面”私忆；问名字（`你叫什么/怎么称呼/贵姓…`）只写“谁问过我的名字”记忆，不置位。
- 新增 `apps/server/src/name-unlock.ts` / `view-names.ts`：`speechIntroducesName`（姓名共现才算 NPC 自报姓名）、`unknownPlaceholders` / `maskNamesInText` / `maskNamesDeep`。

### 修复

- **P0 真名泄露**：`/state` 与 `/history` 在未认识时脱敏（`maskNamesDeep`），不再下发真实 `entity.name` 与历史叙事中的真名。
- **P1 解锁规则**：只在 `turn.commit` 之后解锁；目标必须在场（`targetPresent`）；失败回合不再解锁；`我是/我叫/我姓` 不再误判为自报姓名；`introduce` 不再产出“你问到了对方的名字”假 fact。
- **脱敏稳定性**：`maskNamesInText` 按名字长度降序替换（避免短名前缀污染长名占位）；`/turns` 按“回合结束态”而非开始态判定未认识名单。
- **地图出站泄露（#53，PR #55）**：`/map/travel`、`/map/tick` 响应整包经 `maskTurnEvents`，`events`、`moved` 摘要与 `scene.dialogues` 中未认识 NPC 真名统一遮罩。
- **全局端点下发档案（#54，PR #56）**：`/api/v1/scenarios` 的 `npcs[]` 收窄为 `id`/`appearance`，不再下发 role/traits/line/mutter；`mutter` 改随 `/gallery` 且 `met=true` 下发，地图气泡改从房间图鉴取。

### 变更

- **`/turns` SSE 取舍**：事件先收齐、统一脱敏后写出（不再逐 token 流式）；延迟略增，两段式流式改进记录在 docs/03。
- **契约**：`CONTRACT_VERSION 3.3.0 → 3.4.1`（3.4.0 minor：`TurnRequest.targetNpcId?` 可选字段 + 视图行为变更；3.4.1 patch：#53 地图出站脱敏 + #54 档案下发收窄，服务端派生视图不进 schema；12 op / apiVersion / PROMPT_VERSION 不变）。
- **文档**：docs/03 §5.1/§5.2.6/§10.18、docs/02 `knows_name`、docs/06 §7、docs/07（建房种子记忆开销、旧房间不迁移）。

### 验证

- `tsc --noEmit` 0 错；vitest **47 文件 / 320 用例全过**（认识机制/脱敏/反例 10 例 + 地图出站脱敏 3 例 + 档案口径 5 例）；`check:contract` **8/8**（3.4.1）；`build:web` 287.14 kB / gzip 91.02 kB。

### 已知边界

- 旧房间没有 `knows_name` 属性，需重新认识一次；不做批量迁移（文档已注明）。
- SSE 暂为非流式（见上）。
- 建房时给每个 canon NPC 写一条私有种子记忆（一次性开销，见 docs/07）。

## v0.5.3 — 2026-11-18 Turn 幂等收口（PR #50，合入 main `2c51028`；CONTRACT 3.3.0 不变）

### 修复

- **Turn 幂等键含房间与 actor（#34）**：`clientTurnId` 幂等键改为 `JSON.stringify([roomId, actorId, clientTurnId])`，跨房间/actor 不再串台。
- **同 key 并发只结算一次**：新增进程内 `inFlight`，后来者等待首个结算完成并重放同一事件序列，不重复调模型、不重复扣钱。
- **提交记账移到 `yield turn.commit` 之前**：`seen` / `maybeCompact` / 印象 `markDelivered` 全部在 commit 事件交给消费者前完成；`apps/server` 的 `for await ... break` 不再导致“重放重复结算/印象重复投递”。外层 `try/finally` 即使上游 break 也释放等待者。

### 验证

- `tsc --noEmit` 0 错；vitest **39 文件 / 283 用例全过**（新增 `turn.idempotency.test.ts` 4 例：串行重放、同 key 并发、跨房间/actor 隔离、HTTP break-on-commit 记账）；`check:contract` **8/8**（CONTRACT_VERSION=3.3.0）。

### 已知边界

- 幂等缓存为进程内：重启后同一 `clientTurnId` 会重新结算；跨重启恢复需 EventLog 持久化回合标记 + 契约变更（未做）。
- leader 失败后 waiter 重排队与第三个同 key 请求之间存在小竞态窗口；同 key waiters 无超时（leader 挂起会一直等待）——已记录为 follow-up。

## v0.5.2 — 2026-11-18 记忆可信边界 / 房间 404 守卫 / tick 原子 / 部署边界（PR #43–#45，合入 main `259cb5e`；CONTRACT 3.3.0）

### 新增

- **房间入口存在性守卫（#37）**：未知房间或 `room_world_*` 在 `/state`、`/events`、`/turns`、`/history`、`/map`、`/map/travel`、`/map/tick`、`/map/dialogue` 一律 HTTP 404 `E_ROOM_NOT_FOUND`，不再返回空状态、不再隐式写日志建房（`apps/server/src/room-exists.ts`）。
- **`E_ROOM_NOT_FOUND` 契约登记**：`ERROR_CODES` 33→34，docs/03 §7 与 §10.17；`Store` 补充契约外可选能力 `listRooms()` 文档。
- **部署与一致性边界（#40，docs-only）**：新增 `docs/10-部署与一致性边界.md`（单实例边界、禁止多实例共写同一 `data/`、`tmp→rename` ≠ 跨实例事务、备份/升级停写窗口、运维清单、未来 DB/分布式锁规划中）；README/docs/00/docs/02 导航同步。

### 修复

- **tick 单批原子提交（#38）**：`map/tick` 的 `time.advance` 与模块提案合成同一批 `Arbiter.apply`（atomic），失败整批不落库、时段不再单独前进；重试不重复推进。
- **记忆工作记忆可信边界（#36）**：G3/G4/G6 豁免从模型可写 `tags` 改为引擎内部 `workingDrafts` 通道；伪造「最近对话」标签的模型草稿被清洗且仍受 3/30 配额。
- **repair 成功补写记忆（#39）**：repair 成功用修复版叙事/台词/记忆重建整份记忆计划并随最终批提交；首版被拒产物不写记忆。
- **compact 接线（#42）**：每 5 个提交成功回合异步 compact、`COMPACT_AFTER=20`、archived 不占 `ownedCount`/不进 prompt、工作记忆永不归档、重启首次同步确定性重算 archived。
- **x 区口径澄清（#41）**：`xWritesPerTurn` 只统计 `attr.delta`/`attr.set` 的 `x.` 键，`memory.write` 不计入；补 8 条 x 写 + 双 NPC 记忆同回合回归（issue #41 以“前提不成立”关闭）。

### 验证

- `tsc --noEmit` 0 错；vitest **38 文件 / 279 用例全过**；`check:contract` **8/8**（CONTRACT_VERSION=3.3.0，错误码 34/34）；`build:web` 287.05 kB / gzip 90.90 kB。

### 已知限制

- `roomGate` 每次请求扫 `data/rooms/` 目录（O(n)），房间多时可加缓存（follow-up）。
- compact 不落事件：重启按事件日志确定性重算，归档集合可能与运行期有极小差异；进程内计数重启归零（最多晚 5 回合）。
- 并发两个 `map/tick` 的时段推进竞态属基线既有，不在 #38 范围。

## v0.5.1 — 2026-11-18 三条 issue 修复（PR #22/#23/#24，合入 main `42690c9`）

### 新增

- **多 NPC 记忆（#20 / #21-2）**：`MemoryContext.npcs[]` 按在场 NPC 各自召回 long/short（S1.5 之外 1100 tok 均分，超预算先裁 short 再 long）；S7/S8 多 NPC 按人分段标名；写侧每 NPC 首见种子与每回合「最近对话」工作记忆（滚动 tombstone，只留最新 1 条，不占情节配额）；S1 增「只有在场者能说话/行动，不得替不在场者回答」。`PROMPT_VERSION 2026-11-17.3 → 2026-11-18.1`，新建 `docs/prompts/CHANGELOG.md`。
- **点不在场 NPC 隔离（#21-1）**：web `npc-presence.ts` 判定 present/elsewhere/unlocatable；异地给「TA 不在这里（在「XX」）」+「前往 TA 所在地」（复用 `/map/travel`，到达后选中）；场景不可定位时禁用。
- **可重试错误重试按钮（#21-3）**：`turn-error.ts` 优先读服务端 `retryable`；对话区错误条给「重试」（新 `clientTurnId`、不重复玩家行），换场景自动失效。

### 修复

- **LLM 非法 JSON（#18）**：`turn.parse.ts` 先按原文取首个平衡 `{...}`（字符串/转义感知），失败才剥首尾围栏；容忍尾随逗号与前后文本；解析失败带摘要自动重问**一次**，第二次仍坏才 `E_LLM_FORMAT`；重问超时/限流保留真实错误码。
- **`retryable` 语义**：`E_LLM_FORMAT`/`E_LLM_TIMEOUT`/`E_RATE_LIMITED`/`E_STORE_FAULT` 为 true，硬失败 false。
- **多 NPC 记忆注入 bug（#20）**：原 `selectOwner` 在多 NPC 场景退回玩家，在场 NPC 私忆整段不进提示词；修后每 NPC 独立注入，单 NPC / 0 NPC 行为不变。
- **工作记忆配额**：每回合「最近对话」不再耗尽 `sessionCap=30`，也不挤占模型记忆的 `writePerTurn=3`；叙事/台词分别截断，不再丢关键台词。

### 文档

- docs/03 §10.14（3.2.0 → 3.2.1 patch）；docs/07 §4.1/§4.2、docs/06 §7/§8、docs/prompts/CHANGELOG.md；分支记录见对应 PR。

### 验证

- `tsc --noEmit` 0 错；`vitest run` **37 文件 / 267 用例全过**；`check:contract` **8 项全过**（CONTRACT_VERSION=3.2.1）；`build:web` 287.05 kB / gzip 90.90 kB。

## v0.5.0 — 2026-11-17 四条 issue 批量落地（PR #9–#13，合入 `95185b2`）

### 新增

- **图鉴 I2 收口（#3）**：`GET /api/v1/rooms/:roomId/gallery` 返回服务端按 registry 生成的 `GalleryView`（public 给精确值、secret 只给低/中/高、self 对他人只给分档、hidden 不出现、未遇见不给档案与读数）；`GET /api/v1/scenarios` 返回 `content/scenarios/{openings,npcs}.json` 数据化的开局与 NPC 公开档案；web 图鉴删除 `trust/guard/mood` 字面键与前端阈值，改为只渲染 GalleryView。
- **存档与会话恢复 MVP（#7）**：`GET /rooms/:roomId/history`（已提交回合投影）、`GET /me/saves`、`DELETE /me/saves/:roomId`；`data/history/<roomId>.jsonl` 只记 `turn.commit` 后回合（turnId 去重），`data/users/<uid>/saves.json` 索引（tmp+rename 原子写）；web 标题页「我的存档」、进房历史重放（不重播序章）、本地身份 `ecust.playerId`。
- **整回合预算显式化（#1）**：`Turn` 创建 `TurnBudget` 并跨三次 `apply` 显式传递；`xWritesPerTurn` / `maxDeltaPerTurn` 明确为整回合限额（语义与 3.1.0 一致）；docs/03 §2.4 补提案阶段顺序表。

### 修复

- **store 读取失败污染 loaded（#7）**：`loaded` 置位移到读取+解析+回放成功之后；断档修复先写盘再改内存；`appendMemory` 失败清理半载入状态，避免 seq 假 0 时覆盖真实日志。
- **图鉴口径**：未知房间经 `listRooms()` 判 404（不再 200 空图鉴）；secret/self 数值缺 `min/max` 降级「—」，不猜 0~100。
- **历史目录隔离**：历史改 `data/history/`，避免被 `FileStore.listRooms()` 当房间、避免覆盖历史文件。

### 文档

- README 改为入口文档，版本号/测试数改为单一来源引用（docs/03 §0.4 / `version.ts` / 命令输出）；AGENTS §1 必读清单补齐 06/07/08。
- docs/03 新增 §5.2.4（registry）、§5.2.5（gallery）、§5.2.6（scenarios）、§5.2.7（history/saves）与 §10.12；新增 `docs/09-存档与会话恢复方案.md`；`CONTRACT_VERSION 3.1.0 → 3.2.0`（minor：只增端点/类型/配置，旧调用方式不变）。

### 验证

- `tsc --noEmit` 0 错；`vitest` **31 文件 / 212 用例全过**；`check:contract` **8/8**（`CONTRACT_VERSION 3.2.0`）；`build:web` 272.61 kB / gzip 86.19 kB。
- 已知遗留：`/state` 仍下发 secret 原始数值（issue #3 后续）；`self` 的“看自己”图鉴视图未提供；存档 MVP 无多槽/导出，历史一次最多 200 行。

## v0.4.0 — 2026-11-17 地图交互打磨 + 图鉴 I2 收口（PR #5，合入 `69da448`）

### 新增

- **地图交互**：点标记只选中不出发；场景详情/场景链接/对话统一「前往此处」，前往成功自动切回对话页；对话流贴底跟随最新剧情（距底 120px 判定）；标题页「玩法说明/关于本作」下沉底部小字。
- **注册表端点** `GET /api/v1/registry`（docs/03 §5.2.4）：只返回属性声明（label / visibility / min-max / unit / hidden），不含任何实体数值。
- **图鉴按 registry 渲染**：删除 `trust`/`guard`/`mood` 字面键，secret 只展示低/中/高，public/self 显示数值与进度条。

### 变更 / 已知偏差

- PR 首版（`cd12771`）基线错误、回退了记忆接线，已按要求 rebase 到 `b11ad5a` 后合并。
- `secret` 精确值仍随 `GET /rooms/:id/state` 原始 snapshot 下发；`self` 展示口径与 `scenarios.ts` 硬编码待 issue #3 后续收口。

### 验证

- `tsc --noEmit` 0 错；`vitest` 26 文件 / 185 用例全过；`check:contract` 8/8（`CONTRACT_VERSION 3.1.0`）；`build:web` 271.31 kB / gzip 86.66 kB。

## v0.4.0 — 2026-11-17 记忆子系统 3.1.0（P0–P4，合入 `8a26e00`）

### 新增

- 记忆三层（short/long/permanent）接通：`EventSourcedMemory` 从事件日志投影、六道写入闸门、1100 tok 注入硬顶、两阶段裁决（记忆坏了不拖垮回合）、首轮"第一次见到"种子。
- 账号维度：`RoomMember.userId`、`TurnRequest.userId`、`GET /api/v1/me`（档案只读视图）；solo = 1 个成员。
- 世界层永久记忆：canonize 八道闸门 + 独立 judge（未配 = 全拒）、`room_world_<worldId>` 房间、`admin/canonize/{run,tombstone}`、`worlds/<id>/mem.version`。
- 世界印象：canonize 成功后给相关玩家投递 `【世界印象】…记住了你：…`（用户投影，TTL 30 天）。

### 修复（PR #4 二轮复审收尾）

- **世界印象链路接通**：`turn.ts` 调 `attachAboutUserIds`，闸门重建草稿保留 `aboutUserIds`；新增 `apps/server/src/impressions.e2e.test.ts`（回合 → canonize → impressions.json → 下回合 facts）。
- 私忆 id 的回合序号改用 `cause.seq`（时钟不推进也不撞 id）。
- G6 超限定版：不建次日队列（候选为记忆的纯函数，跨日重新聚合），docs/08 §7.3⑥ + §13 同步。
- `/health` 暴露 `canonize.{enabled,judge}`；`GALGAME_DEV_USER` 接线；tombstone 存在性改查记忆索引。

### 修复（PR #4 复审打回项）

- `store.events` 默认 `limit=Infinity`（原 200 会让记忆在 ~30 回合后静默冻结）。
- 启动重建记忆索引（房间 + 世界层）；世界层版本从 `mem.version` 读回，重启不回退。
- canonize 发布后 `ingest` 世界事件（此前"写进去没人读"，S1.5 恒空）、`retireRoom` 不再丢事件。
- 私忆 `memoryId` 不再由内容哈希派生（同内容不同 owner 各存一条）。
- `room_world_` 房间禁止 `state/events/turns`；`X-User-Id` 可用 `GALGAME_TRUST_USER_HEADER=0` 关闭；`FileImpressions` 目录名单射。
- 提示词按 docs/08 顺序重排（S1→S1.5→S4→S5→S6→S7→S8→S9），静态协议在前保住缓存前缀。

### 验证

`tsc` 0 错；**24 文件 / 180 用例全过**（含 4 条端到端：canonize→S1.5 非空、重启重建版本与召回一致、同内容不同 owner 两条都在）；`check:contract` 8 项（3.1.0）。

## v0.3.0 — 2026-11-17 前端体验与运行时模型接入（合入 main `45ea4d4`）

### 新增

- 前端：标题页（选身份/继续/说明/关于/接入真实模型，独占步骤）、开场剧情并入对话流、人物图鉴（信任数值+戒备分档，初始「—」由玩法写入）、逐字打字机（`typewriter.ts`）、Web Audio 按键音（`sfx.ts`）、页面/切 tab/对话行 CSS 过渡。
- 服务端：`GET/POST/DELETE /api/v1/settings/llm`（玩家自备 key，探活后热切换；保存 `data/llm-settings.json`（0600）重启恢复，环境变量优先；**仅本机可调用**）；离线叙述器 `offline-narrator.ts`（场景白描，无配置字样）。

### 修复

- 建房间按 registry 播种 **public** 属性默认值（secret/self 不预填，canon seed 例外）。
- `map` manifest 补 `keywords`（中文路由）；交易意图让位，避免抢占 `trade`（"去食堂买面包"）。

### 验证

`tsc` 0 错；**17 文件 / 134 用例全过**（审阅方 Linux；作者 Windows 环境的 133/134 为上游既有 chmod 模拟写盘用例）；`check:contract` 8 项；`build:web` OK（269.06 kB / gzip 86.02 kB）。已知偏差：图鉴直读 `attrs.trust/guard/mood`、`scenarios.ts` 硬编码开局与 NPC 档案 → 作为临时债由 issue #3 收口（owner 已拍板，下次前端/图鉴合并前必须完成）。

## v0.2.0 — 2026-11-17 地图 v0.2：奉贤校区真实底图

### 新增

- 真实奉贤校区底图（6000×4500）与 33 个点位：24 建成、4 在建、5 规划（`apps/web/public/map/ecust-campus.jpg`、`content/modules/map/data/world_map.json`）。
- Web 地图：缩放 1–4 倍、拖拽平移、点击选点、三态/分类图例、场景详情（`MapViewport.tsx`、`MapLegend.tsx`、`map-geometry.ts`）。
- 服务端 `MapView` 新增 `image`，场景新增 `status` / `category`；非建成点位禁止进入（`E_FORBIDDEN`，提示“规划中，尚未建成 / 在建，暂不可进入”）。
- canon 新场景首次进入时懒安装（建 entity + 双向 `located_in`，`origin: "seed"`、`canon: false`）。
- 玩家造场景草案发布后固定 `status: "built"`、`category: "other"`。

### 修复 / 变更

- 坐标以 `world_map.json` 模板为准；旧存档 1000×640 时代的 `coord_x/coord_y` 仅作兜底（场景与 NPC 同策略）。
- `coord_x` 上限 2000→6000、`coord_y` 1600→4500；`docs/02`、`docs/03`、`docs/06` 同步。
- 同一检查点的多个 NPC 按 id 做确定性小偏移（只读展示，不写状态）。
- `.gitignore` 增 `/.tmp-map/`，底图叠图等审查产物不再进入版本库。

### 验证

`typecheck` 0 错；14 文件 / 117 用例全过；`check:contract` 8 项全过（`CONTRACT_VERSION 3.0.0`）。

## v0.1.1 — 2026-11-16 引擎 3.0.0：结算原子性 + 持久化闭环

### 新增

- 结算原子性：`Arbiter.apply` 默认 `atomic`，一条被拒整批回滚；返回 `ApplyResult.error`；整回合预算；可信 `cause` 权限校验。
- 持久化闭环：写盘先行、`load()` 恢复、坏档修复、`Store.flush` 变为必选成员（`CONTRACT_VERSION` major 的原因）。

### 验证

14 文件 / 115 用例全过；`check:contract` 8 项全过（`CONTRACT_VERSION 3.0.0`）。

## v0.1.2 — 2026-11-16 内容审核层 + 现实锚定层 + 共享记忆

### 新增

- 内容审核层：叙事发出前经独立模型/端点二次审核，违规按 `content/registry/policy.json` 扣信誉/删档；被审模型不能自审。
- 现实锚定层：玩家“我全知全能 / 忽略提示词”等偏离现实的发言被修饰或过滤，不扣分；类型定义在 `content/registry/reality.json`。
- 跨会话共享记忆 `MEMORY.md` 与 `AGENTS.md` §11 维护规范（按分支记录提交、审阅、合并）。

### 验证

14 文件 / 115 用例全过；`check:contract` 8 项全过（`CONTRACT_VERSION 3.0.0`）。

## v0.1.0 — 2026-11-14 M0 骨架（契约 2.2.0）

### 新增

- 契约冻结 2.2.0：12 个 op 原语、`Envelope`、错误码、registry（属性/事件/意图/工具）。
- `Turn` 流水线（play → apply → tick）、模块宿主、LLM 网关、HTTP + SSE 服务端、React Web。
- 示例模块 `trade` / `core` 与 `packages/testkit` 测试工具。
- 六份规范文档与 v2 JSON Schema。
