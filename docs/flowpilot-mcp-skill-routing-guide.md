# FlowPilot 启动、MCP/Skill 触发与智能路由指南

## 1. 结论速览

- **仅把 `flow.js` 放到项目根目录，不会自动拉起 FlowPilot。**
- **FlowPilot 本体不直接调用 MCP/Skill**，它主要做：任务状态管理、协议注入、调度流程、checkpoint/finish/verify。
- **MCP/Skill 的实际调用发生在客户端代理层**（如 Codex 子代理），由注入到 `AGENTS.md/CLAUDE.md` 的协议规则触发。
- 你现在的 `mcp_router` 已可用；要让整个流程稳定使用，关键是：**配置生效 + 会话重启 + 协议里写清触发规则**。

---

## 2. FlowPilot 到底如何“启动”

## 2.1 不会自然拉起

`flow.js` 是 CLI（命令行工具），不是常驻守护进程。需要命令触发：

```bash
node flow.js init
node flow.js next
node flow.js resume
```

## 2.2 如果你想“自动续跑”

使用仓库内守护脚本（可选）：

- `scripts/flow-daemon.ps1`（Windows）
- `scripts/flow-daemon-linux.sh`（Linux）
- `scripts/flow-daemon-macos.sh`（macOS）

它们会轮询工作流状态，在条件满足时自动执行 `resume` 并拉起 `codex exec resume --last`。

---

## 3. MCP/Skill 触发机制（实现原理）

## 3.1 FlowPilot 的职责边界

FlowPilot 在 `init/setup` 时会将协议块写入项目说明文件（如 `AGENTS.md`/`CLAUDE.md`），并可为特定客户端写入辅助配置。

你可以把它理解为：

- FlowPilot = **工作流编排器**
- Codex/Claude 子代理 = **执行器（真正调用 MCP/Skill）**

## 3.2 “自动调用”不是魔法，是协议触发

当协议模板里写明：

- 遇到不熟 API 必须查 `context7`
- 某类任务优先某 Skill
- 某类问题优先某 MCP

那么子代理会按这些规则调用；如果协议不写或写得模糊，调用行为就会弱化或不稳定。

---

## 4. 你当前 `mcp_router`（含两个 MCP）如何确保全流程可用

## 4.1 配置层验收（一次性）

```bash
codex mcp list
codex mcp get mcp_router
```

预期：

- `mcp_router` 状态为 `enabled`
- `transport` 为 `streamable_http`
- URL 指向 `http://localhost:3282/mcp`

## 4.2 服务层验收（可选但建议）

向聚合端点发 `tools/list`，应返回可用工具，且工具里带 `sourceServer`（例如 `context7`、`serena`）。

## 4.3 工作流层验收（每个项目至少一次）

1. 在项目里执行 `node flow.js init`，选择 `Codex`。
2. 确认 `AGENTS.md` 含有 `<!-- flowpilot:start -->` 协议块。
3. **重启 Codex 会话**（Monitor/CLI 现有会话都需要重开）。

> 说明：`Codex Monitor` 与 `codex cli` 在同机同用户下读取同一份 `~/.codex/config.toml`，MCP 配置是一致的；差异通常来自“会话是否重启并吃到新配置”。

---

## 5. 如何修改协议模板，让任务“智能调用合适的 MCP”

## 5.1 推荐目标

让子代理先做“任务识别”，再按路由策略调用最合适 MCP，而不是一上来盲调。

## 5.2 推荐增加的协议片段（可直接粘贴）

将下段加入你的 FlowPilot 协议块（建议放在 `Sub-Agent Prompt Template` 前）：

````markdown
### MCP 智能路由规则（MANDATORY）

1. 先本地后外部：能通过代码/文档/配置本地闭环，不调用 MCP。
2. 代码结构与跨文件定位：优先 `serena`（find_symbol / find_referencing_symbols / search_for_pattern）。
3. 官方库/API 行为确认：优先 `context7`（先 `resolve-library-id`，再 `query-docs`）。
4. 时间敏感或外部事实：优先联网检索 MCP（如已接入的 search 类 MCP），并至少双来源交叉验证。
5. 若同时可用多个 MCP：
   - 先选“最贴近问题域”的 MCP；
   - 再用第二来源做关键结论复核；
   - 在 checkpoint 摘要中写明“调用了哪些 MCP + 为什么”。
6. 禁止为调用而调用：若 MCP 返回无关结果，必须回退并改查询，不得把候选信息当事实。
````

## 5.3 建议的“任务类型 -> MCP 路由”策略

| 任务类型 | 首选 MCP | 次选 MCP | 触发条件 |
|---|---|---|---|
| 代码理解/重构 | `serena` | 本地 `rg`/symbol | 需要跨文件调用链、符号级定位 |
| SDK/API 用法 | `context7` | 官方站点检索 | 不确定参数、版本差异、最佳实践 |
| 最新信息/外部事实 | 搜索类 MCP | 官方文档二次验证 | 涉及时效、政策、价格、公告 |
| 架构决策复核 | `serena` + `context7` | 搜索类 MCP | 既要看本地代码又要核对外部规范 |

---

## 6. 协议模板改造的三种落地方式

## 方式 A：快速生效（当前项目）

直接改当前项目的 `AGENTS.md` 中 `<!-- flowpilot:start --> ... <!-- flowpilot:end -->` 区块。

- 优点：最快
- 缺点：仅当前项目生效

## 方式 B：改源码模板（全局后续项目）

修改：

- `src/infrastructure/protocol-template.ts`

然后重新构建：

```bash
npm run build
```

后续把新的 `dist/flow.js` 复制到其他项目，默认就是新模板。

## 方式 C：项目级自定义模板路径（可复用且不改源码）

在项目配置（`.flowpilot/config.json`）中设置：

```json
{
  "protocolTemplate": "docs/your-protocol-template.md"
}
```

FlowPilot 会优先读取这个文件作为注入模板（读取失败才回退内置模板）。

---

## 7. 关键注意事项

- `ensureInstructionDocument` 发现已存在 `flowpilot` 标记块时，默认不会覆盖旧块。
- 因此你更新模板后，若要重注入，通常需要：
  - 手动更新现有协议块，或
  - 移除旧块后再走一次 setup/init 注入流程。
- 要“确保自动调用你的两个 MCP”，核心不是 FlowPilot 开关，而是：
  - `mcp_router` 可用；
  - 会话重启后生效；
  - 协议里明确“何时必须用哪个 MCP”并要求 checkpoint 记录证据。

---

## 8. 建议的最小验收清单

1. `codex mcp list` 能看到 `mcp_router`。  
2. `node flow.js init` 后，`AGENTS.md` 含协议块。  
3. 发起一个“需要查 API”的任务，观察子代理是否先走 `context7`。  
4. 发起一个“跨文件定位”任务，观察子代理是否先走 `serena`。  
5. checkpoint 摘要中能看到 MCP 选择理由与证据。  

完成以上 5 项，基本可以认为 FlowPilot + MCP 智能路由链路已闭环。
