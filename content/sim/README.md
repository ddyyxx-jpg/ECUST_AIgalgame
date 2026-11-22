# content/sim —— 模拟策略（可调参数，不是代码）

这个目录只放"运行时可以调"的模拟参数；改这里不需要动引擎。

## `policy.json`

```json
{
  "schemaVersion": 1,
  "actionPoints": {
    "enabled": true,
    "attr": "action_points",
    "perTurn": 1,
    "max": 6,
    "refillOnPhaseAdvance": true
  }
}
```

| 字段 | 含义 |
|---|---|
| `enabled` | `false` 或删掉整个 `actionPoints` = 关闭行动点；老存档/测试不受影响 |
| `attr` | 属性键，必须在 `content/registry/attrs.json` 声明（当前是 `action_points`） |
| `perTurn` | 每个普通回合扣多少点；`0` = 只显示不扣 |
| `max` | 推进时段时回满到多少；必须 ≤ registry 里该属性的 `max` |
| `refillOnPhaseAdvance` | `true` = `advance:true` 推进时段时回满；`false` = 只能靠别的玩法补 |

文件缺失、坏 JSON、缺 `actionPoints`、或 `enabled:false` 时，服务端按"功能关闭"处理：
不扣点、不拦截、不回满。这样测试 fixture 和旧部署不需要改。

## 为什么放在内容层

- 属性名不在引擎里硬编码（I2）；引擎只拿 `attrKey`。
- 数值可调，不需要重新编译；以后接"难度/经济"配置也走这里。
- 行动点只是第一条模拟策略，后续 `tick`、动作占用时长、日界八卦等参数继续加在这个文件里。

## `clock`（自动时钟）

```json
"clock": { "enabled": false, "intervalMs": 60000, "ticksPerBeat": 1, "maxTick": 24 }
```

| 字段 | 含义 |
|---|---|
| `enabled` | 默认 `false`；开启后服务端每 `intervalMs` 对每个房间调一次 `MapService.tick({ticks: ticksPerBeat})` |
| `intervalMs` | 真实时间间隔；太短会让 NPC 租约消耗过快，建议 ≥ 30000 |
| `ticksPerBeat` | 每拍推进几个游戏 tick；必须是 1..8（与 `time.advance.ticks` 的 zod 上限一致） |
| `talkLeaseTicks` | talk 租约最多冻结多少 tick（默认 12）；进程崩溃/恢复失败时到点自动作废，防 NPC 永久冻结 |
| `maxTick` | 当前 phase 内最多推到第几 tick，到顶就停，等玩家 `advance`；`0` = 不设上限 |

自动时钟**只推 tick，不切 phase**（D22）；`advance:true` 仍由玩家/前端显式触发，并回满行动点。`clock` 与 `actionPoints` 相互独立：只想跑时钟时，`actionPoints` 可以整段省略（行动点代价按 0 处理）。

## `decision`（NPC 自由活动：感知投影 + 编号菜单 + 单选决策）

```json
"decision": { "enabled": false, "maxPerBeat": 2, "intervalTicks": 6, "hourlyCalls": 12, "maxOptions": 4 }
```

| 字段 | 含义 |
|---|---|
| `enabled` | 默认 `false`；开启后自动时钟在每拍 tick 前，对空闲 NPC 调一次 LLM 做单选 |
| `maxPerBeat` | 每拍最多让几个 NPC 决策（硬上限，防止一开就烧钱） |
| `intervalTicks` | 每多少个 tick 决策一次；`1` = 每拍 |
| `hourlyCalls` | 每房间每小时最多调用次数（进程内计数，重启清零） |
| `maxOptions` | 菜单最多几项（含“留下”），2..6 |

流程：只挑 `sim_lease` 为空、且不与玩家同地点的 NPC → `buildPerception` 只投影地点/时段/在场者姓名 → 菜单只给“留下 + 相邻地点” → 模型只回 `{"choice": 2, "reason": "..."}` → 服务端把选择写成一条 `sim_lease`（去别处写 move、留下写 stay）。移动仍由 map 模块下一次 tick 沿最短路执行，决策层不直接改位置。

模型坏输出/超时/未配置时走确定性 `fallbackChoice`（同房间同 NPC 同时刻同结果），不会让 tick 卡住。默认关闭是因为这是唯一按 NPC 计费的循环；开启前先确认 `hourlyCalls` 和房间规模。

## NPC 动作租约（WorldX 的核心机制）

`content/registry/attrs.json` 的 `sim_lease` 是 NPC 身上的一条 JSON：

```json
{ "action": "move|stay|talk", "target": "loc_xxx", "remaining": 2, "phase": "noon", "resume": "..." }
```

- `remaining > 1`：本 tick 只递减，不接新动作；
- `remaining == 1` 且 `action:"move"`：本 tick 沿最短路走到 `target`，然后把租约改成 2 tick 的 stay；
- `remaining == 1` 且 `action:"stay"`：本 tick 结束停留并清空，下一 tick 回到日程；
- 没有租约：按 `npc-schedules.json` 的当前 phase 目标，决定“走完整条最短路 + 占用 1 tick”或“原地停留 2 tick”；
- 自由活动/对话恢复写入的租约目标可以**不是当前日程地点**：租约优先于日程，只要目标仍是 live loc；
- phase 变了：旧租约作废，按新 phase 重排；
- `action:"talk"`：玩家对话中，map tick 整段跳过（不递减、不接新动作；空闲 NPC 也会写 talk，`resume` 为空）；`resume` 保存原租约（原 lease JSON 字符串），对话回合结束由服务端恢复；talk 跨 phase 视为过期，清空重排；另带 `expiresAt`（绝对 tick），到点即使没换 phase 也作废，兜底进程崩溃/恢复失败。
- `sim_lease` 的 `visibility:self` + `hidden` 只影响 UI 与图鉴；出站投影还会整体剥掉该属性，`/state`、`/events`、`turn.patch.state` 都不返回租约（含 `resume`）。

这样自动 tick 不会让 NPC 每拍重新决策，也不会在玩家对话中途开始新动作；玩家打断后，租约的剩余占用时间仍在，走完才接下一个动作。

## 从 WorldX / SillyTavern 借什么（按优先级）

| 来源 | 机制 | 本仓库落点 | 状态 |
|---|---|---|---|
| WorldX | 动作租约（action lease） | `sim_lease` + map 模块 tick；对话打断用 talk 冻结 | 已落地 |
| WorldX | 感知投影 + 编号行动菜单 + 单选决策 | `apps/server/src/npc-decision.ts`：空闲 NPC → 公开感知 → 编号菜单 → 单选 JSON → `sim_lease` | 已落地（默认关闭，`decision.enabled` 开启） |
| WorldX | 记忆打分（相关/新近/重要/情绪）与反思回流 | 已有 `packages/engine` 记忆子系统，补决策侧召回 | 复用 |
| SillyTavern | 角色卡 v2（description/personality/scenario/first_mes/mes_example） | `content/npcs/<id>.json`，由提示词组装器读取；现有 `scenarios/npcs.json` 只保留外观/展示字段 | 下一步 |
| SillyTavern | World Info / Lorebook（关键词触发条目） | `content/lorebook.json` + `apps/server/src/lorebook.ts`；提示词只注入命中条目，字段 `keys/constant/order` | 已落地（内容层） |
| SillyTavern | Author's Note（作者注，稳定语气/当前剧情提示） | `content/lorebook.json` 的全局 `authorNote`，进叙事提示词稳定前缀 | 已落地（内容层） |
| SillyTavern | 群聊 / 多角色发言顺序 | 已有 dev/v2 群聊与 `conversation.step`，补“谁先说”的可配置策略 | 复用 |
| SillyTavern | 分支/重开（swipe、checkpoint） | 已有 saves/slots；补“从某回合分叉”的 UI 入口 | 复用 |
| SillyTavern | Quick Replies / 候选动作 | 已有 CandidatePanel；把行动菜单作为候选来源 | 复用 |
| SillyTavern | 正则后处理 / 变量宏 | 提示词输出后处理层，禁止直接改世界状态 | 下一步 |

原则：这些机制都只影响“给 LLM 看什么、怎么选”，不新增 op、不让 LLM 直写状态；所有结果仍走 `Proposal → Arbiter`。
