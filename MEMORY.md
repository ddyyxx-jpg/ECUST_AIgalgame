# MEMORY.md —— 离线交接入口（不是状态真源）

> 本文件只告诉 AI 去哪里找真源、怎样交接。**不要在这里维护快照、进度、测试数、契约版本、分支决策或审阅记录**——它们必然过期。
> 真源：规则 = `AGENTS.md`；名字/接口 = `docs/03-接口总表.md`；op 参数形状 = `packages/shared/src/contract/types.ts` 与 `packages/shared/src/zod/op.ts`；版本 = `packages/shared/src/contract/version.ts`；当前代码 = `git status` / `git log`；任务与验收 = GitHub Issues + PR 描述/评论；历史 = `CHANGELOG.md` + git history。
> **上游开放 Issue 列表：https://github.com/ddyyxx-jpg/ECUST_AIgalgame/issues?q=is%3Aissue+is%3Aopen**（交接时先查这里，避免重复建单）。
> 定位：活文档，但只保留入口与规则；与 `AGENTS.md` 冲突时以 `AGENTS.md` 为准（`AGENTS.md` 又服从 `docs/03` 与用户当面指令）。

## 开工前（按顺序）

1. 读 `AGENTS.md` 全文，尤其 §0 不变量、§1 必读、§3 权限、§3.1 权限和契约、§7 自查、§11 任务交接。
2. 读当前任务的 GitHub Issue / PR 全文（**含评论区**），确认验收标准与最新结论；不要依赖旧会话的口述或本地快照。
3. 查契约名字与版本：`docs/03-接口总表.md` + `packages/shared/src/contract/version.ts`。
4. 查代码现状：`git status`、`git log -5`、相关源文件；不靠记忆里的数字。
5. 按 `AGENTS.md` §1 读对应规范文档。

## 任务交接（状态去哪了）

- **待办 / 验收标准 / 已知限制**：GitHub Issue 的描述与评论。遗留问题没有 Issue 时先建 Issue，再删旧记录；**可独立验收的遗留须在获授权后建单**。
- **分支进展 / 审阅意见 / 打回项**：对应 PR 的描述与评论；逐条回复，不覆盖他人意见，不另写本地台账。
- **退路**：离线或没有写权限时继续本地工作；交付时给出待同步的摘要（Issue 号 / PR 号 / 待写内容），联网后补写。
- **已合并历史与版本变化**：`CHANGELOG.md` + `git log`；提交决策写进提交信息。
- **验证命令与提交前自查**：`AGENTS.md` §7；真实输出贴进 PR / 回复，不抄进本文件。
- **push / 合并授权**：`AGENTS.md` §3.1；每次都要用户当面确认。

## 交接块模板（写进 Issue 或 PR 描述，不写进本文件）

```text
## 状态交接（YYYY-MM-DD）
- 目标 / 验收：<Issue 号与验收条目，或 PR 要解决的 Issue>
- 当前状态：<已做 / 未做 / 阻塞；head SHA>
- 决策与理由：<为什么选 A 不选 B，一句话>
- 验证：<真实命令 → 结果摘要>
- 下一步 / 遗留：<具体动作 + Issue 号；没有就建一个>
```

## 历史

- 2026-11-19：按 issue #73 把逐提交记账迁到 GitHub Issues / PR；旧快照从 git history 与 `CHANGELOG.md` 查阅。
