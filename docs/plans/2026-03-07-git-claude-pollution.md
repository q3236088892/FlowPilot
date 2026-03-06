# Git / Claude 污染修复实现计划

> **状态：待执行**
> **目标：按最小改动修复 hooks 注入边界、git 提交真值语义，以及与之直接相关的测试。**

## 实施范围

只改动以下路径：

- `src/domain/repository.ts`
- `src/infrastructure/git.ts`
- `src/infrastructure/fs-repository.ts`
- `src/application/workflow-service.ts`
- `src/infrastructure/git.test.ts`
- `src/infrastructure/fs-repository.test.ts`
- `src/application/workflow-service.test.ts`

不扩散到 README、用户手册、协议模板以外的模块。

## 前置结论

在开始功能修改前，先处理两个当前阻塞项：

1. `src/infrastructure/fs-repository.ts` 存在语法错误，测试和类型检查会先被它阻断。
2. 现有 commit API 以 `string | null` 表示结果，无法支撑“真实 commit / 未提交 / 提交失败”三态消息。

## 实施步骤

### 1. 修复仓储层阻塞项并固化 hooks 注入边界

**目标文件**

- `src/infrastructure/fs-repository.ts`
- `src/infrastructure/fs-repository.test.ts`

**动作**

- 先修复 `src/infrastructure/fs-repository.ts` 中 settings 写回语句的语法错误。
- 调整 `ensureHooks()`：
  - 若 `.claude/` 不存在则创建目录。
  - 若 `.claude/settings.json` 不存在则创建最小 JSON。
  - 幂等合并 `hooks.PreToolUse`，只补足缺失的 `TaskCreate` / `TaskUpdate` / `TaskList` matcher。
  - 保留用户现有 settings 和其他 hooks。
- 调整 `cleanupInjections()`：
  - 仅清理 `CLAUDE.md` 中的协议块。
  - 移除 `.claude/settings.json` 的清理逻辑，保证运行期静默。

**完成标准**

- `ensureHooks()` 在空目录里首次执行即可生成 settings。
- 重复执行不重复写入相同 matcher。
- `cleanupInjections()` 不再触碰 `.claude/*`。

### 2. 引入显式的 git commit 结果模型

**目标文件**

- `src/domain/repository.ts`
- `src/infrastructure/git.ts`
- `src/infrastructure/git.test.ts`

**动作**

- 在 `src/domain/repository.ts` 定义新的 commit 结果类型，替换 `string | null`。
- 在 `src/infrastructure/git.ts` 中把 `commitIn()` 和 `autoCommit()` 改成返回三态结果：
  - `committed`
  - `skipped`
  - `failed`
- 明确 no-op 原因：
  - 未提供 `files`
  - 过滤后仅剩运行时产物
  - 没有 staged 变化
- 若存在父仓库 + 子模块：聚合多个仓库的结果，任何一个真实提交即判为 `committed`。

**完成标准**

- 调用方可以无歧义判断是否真的发生 commit。
- 仅运行时文件不再伪装成“成功提交”。
- git 错误仍能向上返回可读错误。

### 3. 把 checkpoint / finish 文案改成真实结果驱动

**目标文件**

- `src/application/workflow-service.ts`
- `src/application/workflow-service.test.ts`

**动作**

- `checkpoint()`：
  - 只在 `commitResult.status === 'committed'` 时附加 `[已自动提交]`。
  - `skipped` 时输出明确原因，例如：
    - `未提供 --files`
    - `本次文件均为运行时产物`
    - `没有可提交的 git 变更`
  - 只有真实 commit 时才执行 `repo.tag(id)`。
- `finish()`：
  - 只有真实 commit 时才输出“已提交最终commit”。
  - `skipped` 时输出“未生成最终commit：<原因>”。
  - `committed` 和 `skipped` 都视为收尾成功，都要把工作流清理到待命状态。
  - `failed` 才保留现有“git提交失败”路径。

**完成标准**

- `checkpoint()` 和 `finish()` 的文案与真实 git 行为一一对应。
- `finish()` 不会因为“没有可提交文件”而卡在未清理状态。

### 4. 修复并补齐测试

**目标文件**

- `src/infrastructure/fs-repository.test.ts`
- `src/infrastructure/git.test.ts`
- `src/application/workflow-service.test.ts`

**动作**

- `src/infrastructure/fs-repository.test.ts`
  - 断言首次 `ensureHooks()` 会创建 `.claude/settings.json`。
  - 断言重复执行仍只有 3 个 matcher。
  - 删除或改写“cleanup 会移除 hooks”的旧期待。
- `src/infrastructure/git.test.ts`
  - 把 `toBeNull()` 一类旧断言改为三态结果断言。
  - 补 `no-files`、`runtime-only`、`no-staged-changes` 三种 no-op 场景。
- `src/application/workflow-service.test.ts`
  - 新增 `checkpoint()` 未传 `files` 时的消息断言。
  - 新增 `finish()` 无真实 commit 时的消息断言。
  - 新增运行期不改写 `.claude/settings.json` 的回归测试。

**完成标准**

- 测试名称和期待与新设计一致。
- 不再存在把“未提交”误当成“已提交”的断言。

### 5. 最小验证顺序

**建议执行顺序**

1. 先跑与语法错误最直接相关的测试：
   - `src/infrastructure/fs-repository.test.ts`
2. 再跑 git 层：
   - `src/infrastructure/git.test.ts`
3. 再跑应用层：
   - `src/application/workflow-service.test.ts`
4. 最后按需要执行 `npm test` 做回归确认。

**验证重点**

- `init` / `setup` 期是否创建并幂等注入 `.claude/settings.json`
- `checkpoint` 无真实 commit 时是否明确报“未自动提交”
- `finish` 无真实 commit 时是否明确报“未生成最终commit”且仍成功收尾
- `finish` / `abort` 后 `.claude/settings.json` 是否保持不变

## 风险控制

- 不改动 `src/interfaces/cli.ts` 的参数语义，避免扩散 CLI 行为变化。
- 不改动运行时文件过滤范围，避免本次修复顺带改变提交白名单策略。
- 不引入新的配置项，避免把一个边界修复变成新的兼容性问题。

## 交付完成判定

满足以下条件即可视为本议题完成：

- `init` / `setup` 满足“缺失即创建、存在即幂等注入”。
- 所有运行阶段都不再读写 `.claude/*`。
- git 提示语只在真实 commit 时宣称已提交。
- 无 commit 发生时，`checkpoint` / `finish` 都给出明确 no-op 原因。
- 相关测试通过，且旧的空值语义断言已全部移除或改写。

## 建议对应的 FlowPilot 任务拆分

```text
1. [backend] 修复 hooks 注入边界与 fs 仓储语法错误
   更新 src/infrastructure/fs-repository.ts，使 init/setup 在缺失时创建 .claude/settings.json、幂等注入 hooks，并移除运行期对 .claude/* 的清理逻辑。
2. [backend] 引入真实 git commit 结果模型 (deps: 1)
   调整 src/domain/repository.ts 与 src/infrastructure/git.ts，区分 committed / skipped / failed，并保留 no-files、runtime-only、no-staged-changes 等原因。
3. [backend] 对齐 checkpoint 与 finish 的真实提示语 (deps: 2)
   更新 src/application/workflow-service.ts，只有真实 commit 才显示已自动提交/已提交最终commit；no-op 时明确提示未提交原因，并保证 finish 可正常收尾。
4. [backend] 修复并补齐相关测试 (deps: 1, 2, 3)
   更新 src/infrastructure/fs-repository.test.ts、src/infrastructure/git.test.ts、src/application/workflow-service.test.ts，覆盖 settings 创建、幂等 hooks、无 commit checkpoint、无 commit finish 等场景。
```
