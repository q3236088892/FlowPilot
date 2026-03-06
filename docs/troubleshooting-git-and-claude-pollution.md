# 排查：在其他项目单独运行 FlowPilot 导致 `.claude/` 与 Git 污染（删除文件“复活”）

> 目标读者：**在“其他项目”中复制 `flow.js` 并单独运行 FlowPilot 的使用者**。  
> 目标：解释现象与根因，给出立刻可执行的规避措施，并指明推荐的代码修复方向。

## 背景（为何会碰到）

FlowPilot 的典型用法是把构建产物 `flow.js` 复制到你的项目里，然后执行：

```bash
node flow.js init
```

这一步会让 FlowPilot 对你的项目做“接管/注入”（例如写入协议、注入 hooks），随后子 Agent 会按任务 checkpoint 并触发自动 git 提交。若这些注入/提交/清理策略缺少隔离边界，就可能出现 **`.claude/` 目录“突然出现”**、**误提交**、以及 **删除文件后又被恢复** 等问题。

---

## 1) 现象

### 现象 A：项目根目录出现 `.claude/`

- 运行 FlowPilot 后，项目根目录出现 `.claude/`（即使你原本项目没有）。
- `.claude/settings.json` 可能被修改（注入 hooks / env 等）。
- 如果你的仓库没有忽略该目录，它会出现在 `git status` 中，甚至被提交进历史。

### 现象 B：删除的文件“复活”

- 你在工作区**删除**了某些文件（例如 `rm file` / IDE 删除），看起来已经消失。
- 随后在某些阶段（恢复工作流、清理步骤、切换任务/分支、再次执行命令）文件又出现在工作区——像是被“还原/复活”。

---

## 2) 根因（源码层定位）

本次排查确认根因集中在三个点，分别对应 **注入**、**提交策略**、**清理策略**：

### 根因 A：`ensureHooks` 注入 `.claude/settings.json`

- **位置**：`FlowPilot/src/infrastructure/fs-repository.ts` 的 `ensureHooks()`
- **行为**：向目标项目的 `.claude/settings.json` 注入 hooks（例如拦截 `TaskCreate/TaskUpdate/TaskList`）  
  结果就是 `.claude/settings.json` 被写入/修改，从而“污染”目标项目仓库。

> 补充：在某些项目里，即使 FlowPilot 本身不主动创建 `.claude/`，Claude Code 或用户环境也可能先创建该文件；而 FlowPilot 会继续对其进行注入，最终仍表现为“`.claude` 出现/变化”。

### 根因 B：`commitIn` 默认 `git add -A`（提交范围过大）

- **位置**：`FlowPilot/src/infrastructure/git.ts` 的 `commitIn()`
- **行为**：在本次排查对应的实现中，`commitIn()` 以 `git add -A`（或等价的全量 stage）作为默认策略，把工作区里**所有变化**（包括 `.claude/`、临时文件、误改动、删除操作等）一起纳入暂存区。
- **后果**：FlowPilot 的自动提交不再是“只提交本任务产物”，而是“把当时工作区的一切都提交了”，导致误提交与历史污染。

### 根因 C：`gitCleanup` 自动 `git stash push`（stash 造成恢复/复活）

- **位置**：`FlowPilot/src/infrastructure/git.ts` 的 `gitCleanup()`
- **行为**：在本次排查对应的实现中，`gitCleanup()` 会自动执行 `git stash push`（并在后续阶段 `stash pop/apply`），把当下工作区的改动（包含删除操作）打包进 stash 并再恢复。
- **后果**：用户直观感受就是“文件删除后又复活”，并且工作区状态被 FlowPilot 越权改写。

---

## 3) 风险 / 影响

- **污染 Git 历史**：`.claude/settings.json` 等与业务无关的文件被提交，仓库历史混入环境/工具配置。
- **误提交风险**：全量 `git add -A` 会把不属于当前任务的改动一起提交（包括本地调试文件、误删误改、私有配置）。
- **stash 恢复导致“复活”**：自动 stash 在恢复时把删除操作带回来，造成文件“死灰复燃”，并干扰你对工作区的判断。
- **协作成本上升**：团队成员拉取代码后看到 `.claude/` 或异常提交，会引发额外沟通与回滚成本。

---

## 4) 立刻可做的规避措施（强烈建议照做）

下面是“无需改 FlowPilot 源码、立即见效”的做法，按优先级排列。

### 4.1 先把 `.claude/` 加入目标项目的 `.gitignore`

在你运行 FlowPilot 的目标项目里，追加：

```gitignore
# Claude Code / FlowPilot 注入产物（建议永远忽略）
.claude/
```

如果 `.claude/` 已经被提交/被 git 跟踪，需要把它从索引移除（不会删本地文件）：

```bash
git rm -r --cached .claude
git commit -m "chore: ignore .claude directory"
```

### 4.2 强制要求 checkpoint 使用 `--files`（只提交明确文件）

如果你的工作流/协议里允许子 Agent 自动提交，请**强制每次 checkpoint 都显式给出文件列表**，把提交范围收敛到“任务产物”。

示例：

```bash
echo "完成xxx [REMEMBER] ..." | node flow.js checkpoint 001 --files src/a.ts src/b.ts
```

如果你发现子 Agent 的 checkpoint 经常漏 `--files`，短期的策略是：

- **宁可不让它自动提交**，也不要让它“全量提交”。（避免把 `.claude/`、误删文件等一起提交）
- 在提交前人工检查暂存区：

```bash
git status
git diff
git diff --cached
```

### 4.3 运行 FlowPilot 前，保持工作区干净（避免 stash/恢复放大问题）

在目标项目中运行 FlowPilot 之前，先确认：

```bash
git status --porcelain
```

若有输出，建议先手动处理（提交/丢弃/自己 stash），不要让工具替你 stash。

### 4.4 如果你已经遇到“删除文件复活”，先排查并清理 stash

先查看 stash：

```bash
git stash list --date=local
```

如果确认 stash 是自动产生且不再需要，可以逐条删除：

```bash
git stash drop stash@{0}
```

或（高风险）全部清空：

```bash
git stash clear
```

> 注意：`git stash clear` 不可恢复。清理前建议先 `git stash show -p stash@{n}` 看一下内容。

---

## 5) 建议的代码修复方向（需要改哪些模块）

以下是“从根上解决”的修复方向，适用于 FlowPilot 本体改造（而不是每个目标项目自己擦屁股）。

### 5.1 `FlowPilot/src/infrastructure/git.ts`

- **修复提交边界**：`commitIn()` 必须只 `git add -- <files...>`，禁止默认 `git add -A`。
- **加入运行时产物过滤**：对 `.claude/`、`.workflow/`、`.flowpilot/` 等明确“工具运行时文件”做统一过滤，避免误 stage/误 commit。
- **禁用/收敛清理行为**：`gitCleanup()` 不应自动 stash 整个工作区；若必须做保护性操作，应改为：
  - 仅在“完全可控场景”执行（例如工作区已确认干净）
  - 或提供显式开关（默认关闭），并在输出中提示风险

### 5.2 `FlowPilot/src/infrastructure/fs-repository.ts`

- **限制 `ensureHooks()` 的写入策略**：
  - 默认不应修改目标项目的 `.claude/settings.json`（或至少需要显式确认/开关）
  - 更安全的方式是：把 FlowPilot 需要的规则放到它自己的目录（如 `.workflow/`）或通过运行参数注入，而不是写入用户项目的 `.claude/`
- **提供 “dry-run / no-inject” 模式**：允许用户在不注入 `.claude/` 的情况下运行（至少用于 CI/只读排查）。

### 5.3 `FlowPilot/src/application/workflow-service.ts`

- **强制提交时必须提供文件列表**：在 `checkpoint()` → `repo.commit(...)` 的链路上，可以做策略升级：
  - 若 checkpoint 未提供 `files`，则默认不自动提交（或者只提交白名单路径）
  - 把“`checkpoint --files`”作为协议强约束，减少误提交空间
- **把注入与提交拆开**：注入（CLAUDE/hook）和 git 提交属于不同风险级别的行为，应该有不同的开关与提示。

---

## 快速自查清单（建议复制执行）

```bash
# 1) 目标项目忽略 .claude
printf "\n.claude/\n" >> .gitignore

# 2) 如果已被跟踪，移出索引
git rm -r --cached .claude 2>/dev/null || true

# 3) 运行前确认工作区干净
git status --porcelain

# 4) 如遇“复活”，检查 stash
git stash list --date=local
```

