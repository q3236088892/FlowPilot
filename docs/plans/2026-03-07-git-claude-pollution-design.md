# Git / Claude 污染修复设计

> **实现状态：未开始**
> **范围限定：仅覆盖 `.claude/settings.json` 注入边界、git 提交真值语义、以及与此直接相关的测试修复。**

## 背景

当前 FlowPilot 在“接管/运行/收尾”链路里，把两个本应分离的问题耦合在了一起：

1. **接管期注入**：`init` / `setup` 会写入 `CLAUDE.md` 和 hooks。
2. **运行期提交/清理**：`checkpoint` / `finish` 会根据 `repo.commit()` 的结果拼接提示语，并在收尾阶段执行注入清理。

这导致两个具体问题：

- `.claude/settings.json` 的写入边界不清晰：当前实现与测试对“文件不存在时是否创建”并不一致，而且运行期还会通过 `cleanupInjections()` 回写 `.claude/*`。
- git 提交提示不真实：当前 `null` 同时表示“提交成功”和“根本没提交”，于是 `checkpoint()` 和 `finish()` 会在没有真实 commit 的情况下仍输出“已自动提交 / 已提交最终commit”。

## 本次设计的目标

- 只允许在 `init` / `setup` 阶段注入 hooks。
- `init` / `setup` 遇到缺失的 `.claude/settings.json` 时自动创建，并且幂等注入所需 hooks。
- `resume` / `checkpoint` / `finish` / `abort` 等运行阶段**绝不触碰** `.claude/*`。
- git 状态提示必须反映真实结果：
  - 真实发生 commit 才能声称“已自动提交 / 已提交最终commit”。
  - 没有发生 commit 时，必须明确说“未提交”以及原因。
- 修复并对齐测试，覆盖当前已知问题：
  - `src/infrastructure/fs-repository.ts` 中现存语法错误。
  - 与新语义不一致的旧测试期待。

## 非目标

- 不改动任务协议、记忆系统、loop detector、heartbeat、verify 策略。
- 不改动 `CLAUDE.md` 注入时机（仍允许 `init` / `setup` 注入协议块）。
- 不在本次设计中引入新的 CLI 命令或新的用户配置项。
- 不扩展自动提交范围控制到本议题之外的功能。

## 当前状态与代码定位

### 1. hooks 注入与清理边界

- `src/infrastructure/fs-repository.ts`
  - `ensureHooks()` 当前只在 `settings.json` 已存在时注入；文件不存在时直接返回 `false`。
  - 该函数目前存在语法错误，位于写回 settings 的字符串拼接处，导致测试/构建会先被这个问题阻断。
  - `cleanupInjections()` 当前会在运行期删除 `.claude/settings.json` 中的 FlowPilot hooks，这与“运行期绝不触碰 `.claude/*`”的新约束冲突。

### 2. git 提交真值缺失

- `src/domain/repository.ts`
  - `commit(taskId, title, summary, files?): string | null` 的返回值过于粗糙，无法区分“成功提交”和“没有提交”。
- `src/infrastructure/git.ts`
  - `commitIn()` 在 `targets` 为空时直接返回 `null`。
  - `autoCommit()` 在未提供 `files`、过滤后为空、或者 `git add` 后没有 staged 改动时，也都会落到 `null`。
- `src/application/workflow-service.ts`
  - `checkpoint()` 中 `if (!commitErr) ... ' [已自动提交]'`。
  - `finish()` 中 `if (!commitErr) ... '已提交最终commit'`。
  - 上述逻辑都把“no-op”误判成“已提交”。

### 3. 已知受影响测试

- `src/infrastructure/fs-repository.test.ts`
  - 需要与“缺失 settings 时自动创建”的设计对齐。
  - 需要移除或改写“运行期 cleanup 会清理 hooks”的旧期待。
- `src/infrastructure/git.test.ts`
  - 当前以 `null` 断言“仅运行时文件时跳过提交”，与新设计不匹配。
- `src/application/workflow-service.test.ts`
  - 目前缺少对“无真实 commit 时的 checkpoint / finish 输出”覆盖。

## 设计约束（按用户已批准方案固化）

- hooks 注入只允许出现在 `init` 和 `setup`。
- `init` / `setup` 期间若 `.claude/settings.json` 不存在，则创建。
- `init` / `setup` 期间若 `.claude/settings.json` 已存在，则幂等注入所需 hooks。
- `resume` / `checkpoint` / `finish` 及其他运行阶段不得修改 `.claude/*`。
- git 提示必须真实：只有真实发生 git commit 才能宣称 auto-commit / final commit；否则必须明确说明没有 commit 发生以及原因。

## 方案设计

## 一、把 hooks 写入明确收敛到接管期

### 设计决策

- `src/application/workflow-service.ts`
  - 继续仅在 `init()` / `setup()` 调用 `repo.ensureHooks()`。
  - `resume()` / `checkpoint()` / `finish()` / `abort()` 不再通过任何路径读写 `.claude/*`。
- `src/infrastructure/fs-repository.ts`
  - `ensureHooks()` 负责：
    - 创建 `.claude/` 目录（若不存在）。
    - 创建最小合法的 `.claude/settings.json`（若不存在）。
    - 在 `hooks.PreToolUse` 中幂等追加 `TaskCreate` / `TaskUpdate` / `TaskList` 的拦截规则。
  - `cleanupInjections()` 只处理 `CLAUDE.md` 协议块，不再读取或修改 `.claude/settings.json`。

### 原因

- 这与用户批准的“只允许 init/setup 注入”严格一致。
- 运行期不再改写 `.claude/*`，可避免 finish/abort 时再次制造工作区噪音。
- 行为更容易测试：接管期负责注入，运行期只消费状态，不负责回滚 `.claude`。

## 二、把 git 提交结果从二元错误值升级为显式状态

### 新的返回语义

将 `src/domain/repository.ts` 的 `commit()` 返回值从 `string | null` 升级为显式结果对象。建议形态如下：

```ts
interface CommitResult {
  status: 'committed' | 'skipped' | 'failed';
  reason?: 'no-files' | 'runtime-only' | 'no-staged-changes';
  error?: string;
}
```

### 语义定义

- `committed`
  - 至少发生了一次真实 `git commit`。
- `skipped`
  - 没有发生 commit，但这不是错误。
  - 典型原因：
    - 未提供 `--files`。
    - 提供的文件在过滤后只剩运行时产物（如 `.claude/settings.json`、`.workflow/*`、`.flowpilot/*`）。
    - `git add -- <files>` 后没有 staged 变化。
- `failed`
  - 发生 git 级别错误，例如 `git add` / `git commit` 失败。

### 为什么必须用结构化结果

当前 `null` 同时承担了“成功”和“未提交”两种含义，调用方无法做出真实提示。只要 `checkpoint()` 和 `finish()` 还依赖这个二义值，消息就无法修正。

## 三、精确定义 checkpoint 和 finish 的消息规则

### `checkpoint()`

位于 `src/application/workflow-service.ts`。

新的输出规则：

- `committed`
  - `任务 001 完成 (1/3) [已自动提交]`
- `skipped` + `reason=no-files`
  - `任务 001 完成 (1/3) [未自动提交：未提供 --files]`
- `skipped` + `reason=runtime-only`
  - `任务 001 完成 (1/3) [未自动提交：本次文件均为运行时产物]`
- `skipped` + `reason=no-staged-changes`
  - `任务 001 完成 (1/3) [未自动提交：没有可提交的 git 变更]`
- `failed`
  - 继续保留 `[git提交失败] ...` 分支

并且：

- 只有 `committed` 时才调用 `repo.tag(id)`。
- `skipped` 不影响任务完成，只影响提示内容。

### `finish()`

位于 `src/application/workflow-service.ts`。

新的输出规则：

- `committed`
  - `验证通过 ... 已提交最终commit，工作流回到待命状态`
- `skipped`
  - `验证通过 ... 未生成最终commit：<原因>，工作流回到待命状态`
- `failed`
  - `验证通过 ... [git提交失败] ...`

并且：

- `finish()` 在 `committed` 和 `skipped` 两种情况下都应视为“收尾成功”，都应执行清理并返回待命状态。
- 只有 `failed` 才应阻止最终收尾。

## 四、提交边界与过滤策略保持最小变更

位于 `src/infrastructure/git.ts`。

保留当前总体思路，但把“是否真的提交过”显式化：

- 继续只允许 `git add -- <files...>`，不回退到全量 stage。
- 继续过滤运行时产物：
  - `.claude/settings.json`
  - `.workflow/*`
  - `.flowpilot/*`
- 对父仓库与子模块提交做聚合：
  - 任一仓库真实提交成功，则整体结果为 `committed`。
  - 若所有仓库都只是 no-op，则整体结果为 `skipped`。
  - 任一仓库失败，则整体结果为 `failed`，并汇总错误信息。

## 五、运行期不再清理 `.claude/settings.json`

### 设计决策

`src/infrastructure/fs-repository.ts` 中现有的 `cleanupInjections()` 需要拆分语义：

- 保留 `CLAUDE.md` 协议块清理。
- 删除 `.claude/settings.json` hooks 清理逻辑。

### 影响

- `finish()` / `abort()` 以后不会再修改 `.claude/settings.json`。
- 本次 issue 的重点从“运行后自动回滚 `.claude`”改为“接管期可注入，但运行期保持静默”。
- 这样与批准约束完全一致，也更容易解释给用户。

## 测试设计

## 一、仓储层

### `src/infrastructure/fs-repository.test.ts`

新增或调整以下覆盖：

- `ensureHooks()` 在 settings 缺失时自动创建 `.claude/settings.json`。
- `ensureHooks()` 重复执行时幂等，不重复追加 matcher。
- `cleanupInjections()` 只清理 `CLAUDE.md`，不再断言 hooks 被移除。
- 修复因 `src/infrastructure/fs-repository.ts` 语法错误导致的基础测试阻断。

## 二、git 层

### `src/infrastructure/git.test.ts`

新增或调整以下覆盖：

- 未传 `files` → 返回 `skipped/no-files`。
- 仅传运行时产物 → 返回 `skipped/runtime-only`。
- 传了业务文件但无 staged 变化 → 返回 `skipped/no-staged-changes`。
- 真实发生 commit → 返回 `committed`。

## 三、应用层

### `src/application/workflow-service.test.ts`

新增或调整以下覆盖：

- `checkpoint()` 未传 `--files` 时，任务照常完成，但消息明确说明“未自动提交”。
- `checkpoint()` 仅传运行时文件时，消息明确说明“未自动提交”。
- `finish()` 在无可提交文件时返回“未生成最终commit”，同时工作流成功收尾。
- `finish()` / `abort()` 不会修改 `.claude/settings.json`。

## 风险与取舍

- **取舍 1：finish 不再依赖 commit 成功才能回到待命**
  - 好处：把“无 commit”从错误改为真实 no-op，符合用户预期。
  - 风险：如果用户过去把“是否生成最终 commit”当成“是否 finish 成功”的唯一信号，需要同步更新测试和输出文案。
- **取舍 2：不在运行期自动移除 hooks**
  - 好处：严格满足“不触碰 `.claude/*`”约束。
  - 风险：项目里会保留注入过的 hooks；但这是接管期的显式副作用，不再是运行期惊喜写入。

## 受影响文件清单

- `src/domain/repository.ts`
- `src/infrastructure/git.ts`
- `src/infrastructure/fs-repository.ts`
- `src/application/workflow-service.ts`
- `src/infrastructure/git.test.ts`
- `src/infrastructure/fs-repository.test.ts`
- `src/application/workflow-service.test.ts`

## 验收标准

- `init` / `setup` 可在缺失 `.claude/settings.json` 时创建并注入 hooks。
- 重复执行 `init` / `setup` 不会重复注入相同 matcher。
- `resume` / `checkpoint` / `finish` / `abort` 不读写 `.claude/*`。
- `checkpoint` 只有真实 commit 才显示 `[已自动提交]`。
- `finish` 只有真实 commit 才显示“已提交最终commit”。
- 无 commit 发生时，输出能明确说明“未提交”的原因。
- 相关测试覆盖上述行为，且不再被 `src/infrastructure/fs-repository.ts` 的语法错误阻断。
