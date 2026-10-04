# ccc — Claude Code 风格的命令行编程 Agent

`ccc` 是一个复刻 Claude Code 交互体验与工作方式的终端 AI 编程助手，可以接任何 **Anthropic 兼容 API**（例如 DeepSeek 的 `https://api.deepseek.com/anthropic`）。
配置项与 Claude Code 使用**同名环境变量**（`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL`、`CLAUDE_CODE_EFFORT_LEVEL` …），同一套配置可以直接搬过来用。

```
> 给 math.js 加一个 multiply 函数并补上测试
⏺ Read(math.js)
  ⎿  Read 4 lines

⏺ Edit(math.js)
  ⎿  Updated with 4 additions and 1 removal
     3   }
     4 - module.exports = { add };
     4 + function multiply(a, b) {
     ...
⏺ Bash(node test.js)
  ⎿  PASS
     PASS
```

## 安装与运行

需要 Node.js 22+。Windows 上 Bash 工具使用 Git Bash（与 Claude Code 相同），会自动查找，也可以用 `CLAUDE_CODE_GIT_BASH_PATH` 指定。

```bash
cd D:\d\node\copy-claude-code
npm install
node bin/ccc.js            # 直接运行
npm link                   # 可选：注册全局命令 ccc，之后在任意项目目录里输入 ccc
```

> 在 Git Bash 自带的 mintty 窗口里交互模式需要 `winpty ccc`；推荐在 Windows Terminal / PowerShell / cmd 中运行。

## 配置

与 Claude Code 相同的变量，优先级从低到高：

1. `<安装目录>/.env`（本仓库已放好你的 DeepSeek 配置，已在 `.gitignore` 中）
2. `~/.ccc/settings.json` 中的 `"env"` 块（全局）
3. `<项目>/.ccc/settings.json`（项目共享）
4. `<项目>/.ccc/settings.local.json`（项目本地，不提交）
5. Shell 环境变量
6. 命令行参数（`--model`、`--effort`）

```bash
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=sk-...
ANTHROPIC_MODEL=deepseek-flash[1m]          # [1m] 后缀 = 1M 上下文窗口（发送时自动去掉）
ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-flash[1m]
ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-flash[1m]
ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-flash # 小模型：WebFetch 摘要等
CLAUDE_CODE_SUBAGENT_MODEL=deepseek-flash    # Task 子 agent 使用的模型
CLAUDE_CODE_EFFORT_LEVEL=max                 # 以 output_config.effort 发送
CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432       # 自动压缩按这个窗口大小计算
```

其他可选项：`CLAUDE_CODE_MAX_OUTPUT_TOKENS`、`MAX_THINKING_TOKENS`（0 关闭思考）、`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`、`DISABLE_AUTOCOMPACT`、`API_TIMEOUT_MS`、`BASH_DEFAULT_TIMEOUT_MS`、`BASH_MAX_TIMEOUT_MS`、`BASH_MAX_OUTPUT_LENGTH`、`ANTHROPIC_API_KEY`、`ANTHROPIC_CUSTOM_HEADERS`。完整列表见 `.env.example` 或 `ccc config list`。

修改配置的方式：

```bash
ccc config list                                   # 查看生效值及其来源
ccc config set CLAUDE_CODE_EFFORT_LEVEL high      # 写入 ~/.ccc/settings.json
ccc config set ANTHROPIC_MODEL deepseek-pro --project
```

会话中也可以用 `/config`、`/model`、`/effort` 修改。

## 功能

**工具**（与 Claude Code 同名同语义）：`Bash`（持久 cwd、超时、后台运行）、`BashOutput`、`KillShell`、`Read`（行号、图片、ipynb）、`Write`、`Edit`（必须先读后改、检测外部修改、保留 CRLF/BOM）、`Glob`、`Grep`（有 ripgrep 用 rg，否则 JS 实现）、`WebFetch`、`WebSearch`（DuckDuckGo/Bing）、`NotebookEdit`、`TodoWrite`、`Task`（子 agent）、`ExitPlanMode`、`AskUserQuestion`，以及 MCP 工具。

**交互**
- 流式 Markdown 渲染（代码高亮、表格、中文宽度对齐），思考过程折叠显示（`ctrl+o` 展开）
- 权限确认对话框：Bash 命令、带 diff 预览的文件修改、"不再询问"规则
- 权限模式：`shift+tab` 在 default → acceptEdits → plan 之间切换；`--dangerously-skip-permissions`
- 计划模式：只读调研后通过 `ExitPlanMode` 提交计划供你批准
- `Esc` 中断；忙碌时输入的消息会排队并插入当前任务
- `!` Bash 模式、`#` 写入记忆（CLAUDE.md）、`@` 文件补全并附加内容、`\`+回车 或 `ctrl+j` 换行、粘贴大段文本折叠为 `[Pasted text #1 +42 lines]`
- `alt+v` 粘贴剪贴板里的图片（截图用 `Win+Shift+S`），输入框里显示为 `[Image #1]`；超过 1568px 的图会自动缩小。把图片文件拖进终端（或粘贴图片路径）也会作为图片附加
- 上下文用量接近阈值时自动压缩（`CLAUDE_CODE_AUTO_COMPACT_WINDOW`），也可手动 `/compact`
- 会话自动保存到 `~/.ccc/projects/`，`ccc -c` 继续上次，`ccc -r` 选择历史会话

**斜杠命令**：`/help` `/clear` `/compact` `/config` `/model` `/effort` `/status` `/cost` `/context` `/init` `/review` `/memory` `/verify` `/tasks` `/permissions` `/resume` `/todos` `/agents` `/mcp` `/bashes` `/verbose` `/export` `/doctor` `/exit`，以及 `.claude/commands/*.md`、`.ccc/commands/*.md`、`~/.ccc/commands/*.md` 中的自定义命令（支持 `$ARGUMENTS`、`$1`、`` !`cmd` ``）。

**记忆**：自动读取 `~/.ccc/CLAUDE.md`、项目各级目录的 `CLAUDE.md` / `.claude/CLAUDE.md` / `AGENTS.md` / `CLAUDE.local.md`。

**自动记忆（跨会话）**：每个项目有一个由 agent 自己维护的记忆目录 `~/.ccc/projects/<项目>/memory/`。它会把你的偏好、纠正过的做法、项目约束等写成一条条小文件，并在 `MEMORY.md` 里建索引；每次新会话开始时索引自动载入。直接说"记住……"或"忘掉……"即可。写这个目录永远不弹确认；`/memory` 查看；`CCC_DISABLE_AUTO_MEMORY=1` 关闭。

**子 agent**：内置 `general-purpose`、`Explore`、`Plan`；自定义 agent 放在 `.claude/agents/*.md` 或 `~/.ccc/agents/*.md`（frontmatter：`name`、`description`、`tools`、`model`）。

**后台子 agent**：模型可以用 `Task` 的 `run_in_background: true` 把子 agent 放到后台，自己继续干别的。子 agent 完成后，结果会作为 `<task-notification>` 自动送回；如果当时主 agent 空闲，会自动开启新的一轮来处理结果。`TaskOutput` 用于提前等待结果，`TaskStop` 用于取消；`/tasks` 列出所有后台 agent，`/tasks kill agent_1` 停止其中一个。`-p` 模式会等所有后台 agent 结束后再退出。

**自动验证循环**：设置一条验证命令（`--verify "npm test"`、会话中 `/verify npm test`，或 `CCC_VERIFY_COMMAND`）后，只要某一轮改过文件，模型结束前就会自动运行这条命令。失败的输出会发回给模型继续修复，直到通过，最多 `CCC_VERIFY_MAX_ROUNDS` 轮（默认 3）。没有改文件的轮次不会触发验证。

**大输出落盘**：工具结果超过 `CCC_MAX_TOOL_RESULT_CHARS`（默认 50000 字符）时，全文会保存到 `~/.ccc/projects/<项目>/tool-results/`，只把预览和文件路径发给模型，模型可以再用 `Read`/`Grep` 按需查看。Bash 输出被截断时同样会保存全文。超过 7 天的旧文件在启动时自动清理。

**MCP**：项目 `.mcp.json` 或 settings 中的 `mcpServers`，支持 stdio 和 streamable HTTP：

```json
{ "mcpServers": {
  "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
  "remote": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${TOKEN}" } }
} }
```

**权限规则**（`settings.json` 的 `permissions.allow` / `permissions.deny`，或 `/permissions`）：
`Bash(npm test:*)`、`Bash(git diff)`、`Edit(src/**)`、`Read(./.env)`、`WebFetch(domain:github.com)`、`mcp__server`。

**完全放开权限**（所有工具不再询问；deny 规则仍然生效）：

```bash
ccc --dangerously-skip-permissions        # 本次会话；加 -c 可接着上一次对话
```

或者永久生效，写入 `~/.ccc/settings.json`（或项目的 `.ccc/settings.json`）：

```json
{ "permissions": { "defaultMode": "bypassPermissions" } }
```

以 bypass 模式启动后，`shift+tab` 可以在 default → acceptEdits → plan → bypass 之间来回切换。

## claude-pro：用本地订阅登录的官方 CLI

`claude-pro` 是一个启动器：它运行官方 `claude` 命令，由官方 CLI 自己使用本机已登录的订阅账号（在 `claude` 里 `/login` 过一次即可），本项目**不读取、不保存**任何登录凭据。在此之上加了 pro 默认值：

- 默认 `--dangerously-skip-permissions`（不再逐个确认；加 `--safe` 恢复确认）
- 追加一段偏自主执行、先验证再汇报的系统提示（`src/pro-prompt.js`；个人补充写在 `~/.ccc/claude-pro.md`）
- 从子进程环境里去掉 `ANTHROPIC_BASE_URL` / 密钥 / 模型覆盖等变量，避免误走第三方端点（`--keep-env` 可保留）

```bash
npm link                      # 同时注册 ccc 和 claude-pro
claude-pro                    # 交互模式
claude-pro -c                 # 继续上一次会话
claude-pro -p "解释一下 src/agent.js"
claude-pro --which            # 查看实际调用的 claude 可执行文件
```

其余参数原样传给 `claude`。`ccc` 仍然是走 `.env` 里 API 配置（如 DeepSeek）的独立实现。

## Hooks

`settings.json` 里的 `hooks` 与 Claude Code 同形：`PreToolUse`、`PostToolUse`、`UserPromptSubmit`、`Stop`。事件内容以 JSON 放在环境变量 `CCC_HOOK_INPUT`；退出码 0 = 通过（stdout 作为附加上下文），2 = 拦截（stderr 反馈给模型；`Stop` 则让模型继续干活），其他 = 仅警告。

```json
{ "hooks": { "PostToolUse": [ { "matcher": "Edit|Write", "hooks": [ { "type": "command", "command": "npm test --silent" } ] } ] } }
```

## 非交互模式

```bash
ccc -p "解释一下 src/agent.js"                     # 只输出最终回答
cat error.log | ccc -p "这个报错是什么原因"
ccc -p --output-format json "..."                 # JSON 结果（含 token 用量）
ccc -p --allowedTools "Bash(npm test:*)" Edit "修复失败的测试"
```

## 快捷键

| 按键 | 作用 |
|---|---|
| `Enter` | 发送 |
| `\` + `Enter` / `ctrl+j` / `alt+enter` | 换行 |
| `Esc` | 中断当前任务；连按两次清空输入 |
| `ctrl+c` | 中断 / 清空输入 / 连按两次退出 |
| `shift+tab` | 切换权限模式 |
| `ctrl+o` | 切换详细输出（思考过程、完整工具输出） |
| `ctrl+t` | 显示/隐藏 todo 列表 |
| `ctrl+l` | 清屏重绘 |
| `alt+v` | 粘贴剪贴板图片 |
| `↑` / `↓` | 历史记录 |
| `Tab` | 补全命令 / 文件 |

## 开发

```bash
npm test                     # 单元测试（node:test）
```

`test/tui-harness.js` 可以在无头 xterm 中驱动真实的交互界面（发送按键、截取屏幕），用于测试 UI。

代码结构：

```
bin/ccc.js            入口
bin/claude-pro.js     官方 claude CLI 启动器（本地订阅登录）
src/main.js           参数解析、config 子命令
src/config.js         配置加载（.env / settings.json / 环境变量）与模型解析
src/api.js            Anthropic SDK 封装：流式、重试、effort/thinking 参数
src/agent.js          Agent 循环：工具调度、并行只读工具、中断、自动压缩
src/permissions.js    权限模式与规则
src/prompts.js        系统提示词、压缩提示词
src/tools/*           各工具实现
src/hooks.js          Hooks 运行器
src/tasks.js          后台子 agent 注册表与完成通知
src/mcp.js            MCP 客户端（stdio / HTTP）
src/ui/*              终端 UI：屏幕管理、输入框、对话框、Markdown 渲染
src/commands.js       斜杠命令
```

## 与 Claude Code 的差异

未实现：IDE 集成、`/login` 等账号功能。

提示：选中文字自动复制是终端的功能。Windows Terminal 在设置里打开“选择时自动复制”（settings.json 里的 `"copyOnSelect": true`）即可。WebSearch 通过抓取 DuckDuckGo/Bing 实现（DeepSeek 没有服务端搜索工具）。
