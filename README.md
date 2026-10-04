# claude-pro — 完全访问的命令行编程 Agent

`claude-pro` 是一个**自己实现**的 Claude Code 风格终端 AI 编程助手：不依赖官方 Claude Code，可以接任何 **Anthropic 兼容 API**（DeepSeek 的 `https://api.deepseek.com/anthropic`、Anthropic 官方 API 等）。

和官方相比最大的区别：**没有任何权限确认**。Bash 命令、文件读写、联网、MCP 工具，模型要用就直接执行，不弹窗、不问、没有 allow/deny 规则。它面向你自己的测试机器，目的是让模型的能力不被打断地发挥出来。作为补偿，每次文件修改都会做检查点，`/rewind` 可以撤销。

```
> 给 math.js 加一个 multiply 函数并补上测试
⏺ Read(math.js)
  ⎿  Read 4 lines

⏺ Edit(math.js)
  ⎿  Updated with 4 additions and 1 removal
⏺ Bash(node test.js)
  ⎿  PASS
```

> **认证**：自己实现的 agent 只能用 API key（`ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY`），不能用 Claude 订阅登录；订阅登录只有官方 `claude` 程序可以用。

## 安装与运行

需要 Node.js 22+。Windows 上 Bash 工具使用 Git Bash（与 Claude Code 相同），会自动查找，也可以用 `CLAUDE_CODE_GIT_BASH_PATH` 指定。

```bash
cd D:\d\node\copy-claude-code
npm install
node bin/claude-pro.js     # 直接运行
npm link                   # 注册全局命令 claude-pro，之后在任意项目目录里输入 claude-pro
```

> 在 Git Bash 自带的 mintty 窗口里交互模式需要 `winpty claude-pro`；推荐在 Windows Terminal / PowerShell / cmd 中运行。

## 配置

与 Claude Code 相同的环境变量，优先级从低到高：

1. `<安装目录>/.env`（已在 `.gitignore` 中，参考 `.env.example`）
2. `~/.claude-pro/settings.json` 中的 `"env"` 块（全局）
3. `<项目>/.claude-pro/settings.json`（项目共享）
4. `<项目>/.claude-pro/settings.local.json`（项目本地，不提交）
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

其他可选项：`CLAUDE_CODE_MAX_OUTPUT_TOKENS`、`MAX_THINKING_TOKENS`（0 关闭思考）、`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`、`DISABLE_AUTOCOMPACT`、`API_TIMEOUT_MS`、`BASH_DEFAULT_TIMEOUT_MS`、`BASH_MAX_TIMEOUT_MS`、`BASH_MAX_OUTPUT_LENGTH`、`ANTHROPIC_API_KEY`、`ANTHROPIC_CUSTOM_HEADERS`，以及本项目自己的 `CLAUDE_PRO_MAX_RETRIES`、`CLAUDE_PRO_MAX_TOOL_RESULT_CHARS`、`CLAUDE_PRO_MAX_SUBAGENT_DEPTH`、`CLAUDE_PRO_VERIFY_COMMAND`、`CLAUDE_PRO_VERIFY_MAX_ROUNDS`、`CLAUDE_PRO_DISABLE_AUTO_MEMORY`、`CLAUDE_PRO_CONFIG_DIR`。完整列表见 `claude-pro config list`。

```bash
claude-pro config list                                   # 查看生效值及其来源
claude-pro config set CLAUDE_CODE_EFFORT_LEVEL high      # 写入 ~/.claude-pro/settings.json
claude-pro config set ANTHROPIC_MODEL deepseek-pro --project
```

会话中也可以用 `/config`、`/model`、`/effort` 修改。

## 完全访问与安全网

- **没有权限系统**：没有确认弹窗，没有 allow/deny 规则，也没有 `/permissions`。旧参数 `--dangerously-skip-permissions`、`--permission-mode`、`--allowedTools`、`--disallowedTools` 仍被接受但会被忽略（`--permission-mode plan` 等同于 `--plan`）；settings 里残留的 `permissions` 字段也会被忽略。
- **计划模式（唯一的开关）**：`shift+tab`、`/plan` 或 `--plan` 进入。此时只能读和调研，改文件、跑会改东西的命令都会被挡住；模型调研完用 `ExitPlanMode` 提交计划，你批准后回到完全访问。
- **检查点与 `/rewind`**：每条提问都会建一个检查点，Write / Edit / NotebookEdit 修改文件前会先保存原样。`/rewind` 选一条提问，再选恢复"代码和对话"、"仅代码"或"仅对话"；对话回退后，原来的提问会回填到输入框。**Bash 命令造成的改动不会被记录**，所以模型被要求优先用文件工具改文件。
- **想要护栏时用 hooks**：`PreToolUse` 钩子仍然可以拦截任何工具调用，由你自己定规则（见下）。
- 模型自己的使用规则不受影响，系统提示里的安全条款与官方 Claude Code 现在的措辞一致：允许授权的安全测试、防御、CTF、教学，拒绝恶意用途。这一条是模型的使用规范，不是能力限制，没有去掉。

**已经放开的限制**（都可以用环境变量改回去）：

| 项目 | 以前 | 现在 |
|---|---|---|
| 单次输出 `max_tokens` | 32000 | 128000；如果 API 允许的更少，会从报错里读出真实上限并自动降下来 |
| Bash 默认 / 最长超时 | 2 分钟 / 10 分钟 | 10 分钟 / 1 小时 |
| Bash 输出返回给模型的上限 | 30000 字符 | 60000 字符，超出部分的全文保存到文件 |
| 单个工具结果上限（超出落盘） | 50000 字符 | 100000 字符 |
| `Read` 一次最多 | 2000 行、每行 2000 字符、总共 12 万字符 | 10000 行、每行 20000 字符、总共 40 万字符 |
| `Glob` / `Grep` 默认返回条数 | 100 / 250 | 1000 / 1000 |
| `WebFetch` | 只返回小模型的摘要（最多 4096 token），自动把 http 升成 https | `raw: true` 直接拿转换后的全文；摘要上限 16000 token、页面上限 40 万字符；按原样请求 URL，localhost 和内网也可以 |
| 子 agent | 不能再派子 agent | 嵌套到 2 层（`CLAUDE_PRO_MAX_SUBAGENT_DEPTH`，0 = 不嵌套） |
| `Bash` 的标准输入 | 一律关闭 | 可以用 `stdin` 参数喂入文本（回答提示、给脚本传数据） |
| 提示词里的限制 | “尽量少输出”“除非必要不要建文件”“不要强推/改 git 配置/amend” | 回答长度按任务需要；需要就建文件（测试、脚本、配置）；用户要求时可以做上述 git 操作 |

**刻意保留的**：`Edit`/`Write` 必须先 `Read`（防止覆盖没看过的改动，这是正确性保护，不是能力限制）、计划模式（需要时才开）、"没被要求就不提交"、做不可撤销且没被要求的外部操作（强推、发布包、给外部服务发消息或花钱）之前先说一声。

## 功能

**工具**（与 Claude Code 同名同语义）：`Bash`（持久 cwd、超时、后台运行、可喂 stdin）、`BashOutput`、`KillShell`、`Read`（行号、图片、ipynb）、`Write`、`Edit`（必须先读后改、检测外部修改、保留 CRLF/BOM）、`NotebookEdit`、`Glob`、`Grep`（有 ripgrep 用 rg，否则 JS 实现）、`WebFetch`、`WebSearch`（DuckDuckGo/Bing）、`TodoWrite`、`Task`（子 agent）、`TaskOutput`、`TaskStop`、`Skill`、`ExitPlanMode`、`AskUserQuestion`，以及 MCP 工具。

**交互**
- 流式 Markdown 渲染（代码高亮、表格、中文宽度对齐），思考过程折叠显示（`ctrl+o` 展开）
- `Esc` 中断；忙碌时输入的消息会排队并插入当前任务
- `!` Bash 模式、`#` 写入记忆（CLAUDE.md）、`@` 文件补全并附加内容、`\`+回车 或 `ctrl+j` 换行、粘贴大段文本折叠为 `[Pasted text #1 +42 lines]`
- `alt+v` 粘贴剪贴板里的图片（截图用 `Win+Shift+S`），输入框里显示为 `[Image #1]`；超过 1568px 的图会自动缩小。把图片文件拖进终端（或粘贴图片路径）也会作为图片附加
- 上下文用量接近阈值时自动压缩（`CLAUDE_CODE_AUTO_COMPACT_WINDOW`），也可手动 `/compact`
- 会话自动保存到 `~/.claude-pro/projects/`，`claude-pro -c` 继续上次，`claude-pro -r` 选择历史会话

**斜杠命令**：`/help` `/clear` `/compact` `/config` `/model` `/effort` `/status` `/cost` `/context` `/init` `/review` `/memory` `/verify` `/tasks` `/plan` `/rewind` `/skills` `/resume` `/todos` `/agents` `/mcp` `/bashes` `/verbose` `/export` `/doctor` `/exit`，以及 `.claude/commands/*.md`、`.claude-pro/commands/*.md`、`~/.claude-pro/commands/*.md` 中的自定义命令（支持 `$ARGUMENTS`、`$1`、`` !`cmd` ``）。

**记忆**：自动读取 `~/.claude-pro/CLAUDE.md`、项目各级目录的 `CLAUDE.md` / `.claude/CLAUDE.md` / `AGENTS.md` / `CLAUDE.local.md`。

**自动记忆（跨会话）**：每个项目有一个由 agent 自己维护的记忆目录 `~/.claude-pro/projects/<项目>/memory/`。它会把你的偏好、纠正过的做法、项目约束等写成一条条小文件，并在 `MEMORY.md` 里建索引；每次新会话开始时索引自动载入。直接说"记住……"或"忘掉……"即可；`/memory` 查看；`CLAUDE_PRO_DISABLE_AUTO_MEMORY=1` 关闭。

**Skills**：`<目录>/skills/<名字>/SKILL.md`，frontmatter 写 `name` 和 `description`，正文是指令，格式与 Claude Code 的 skills 相同。搜索 `~/.claude-pro/skills/`、`<项目>/.claude/skills/`、`<项目>/.claude-pro/skills/`（项目级覆盖用户级）。模型发现任务匹配某个 skill 的描述时会通过 `Skill` 工具自动加载它；你也可以直接用 `/<skill 名> [参数]` 调用，`/skills` 列出全部。

**子 agent**：内置 `general-purpose`、`Explore`、`Plan`；自定义 agent 放在 `.claude/agents/*.md` 或 `~/.claude-pro/agents/*.md`（frontmatter：`name`、`description`、`tools`、`model`）。

**后台子 agent**：模型可以用 `Task` 的 `run_in_background: true` 把子 agent 放到后台，自己继续干别的。子 agent 完成后，结果会作为 `<task-notification>` 自动送回；如果当时主 agent 空闲，会自动开启新的一轮来处理结果。`TaskOutput` 用于提前等待结果，`TaskStop` 用于取消；`/tasks` 列出所有后台 agent，`/tasks kill agent_1` 停止其中一个。`-p` 模式会等所有后台 agent 结束后再退出。

**自动验证循环**：设置一条验证命令（`--verify "npm test"`、会话中 `/verify npm test`，或 `CLAUDE_PRO_VERIFY_COMMAND`）后，只要某一轮改过文件，模型结束前就会自动运行这条命令。失败的输出会发回给模型继续修复，直到通过，最多 `CLAUDE_PRO_VERIFY_MAX_ROUNDS` 轮（默认 3）。没有改文件的轮次不会触发验证。

**大输出落盘**：工具结果超过 `CLAUDE_PRO_MAX_TOOL_RESULT_CHARS`（默认 50000 字符）时，全文会保存到 `~/.claude-pro/projects/<项目>/tool-results/`，只把预览和文件路径发给模型，模型可以再用 `Read`/`Grep` 按需查看。Bash 输出被截断时同样会保存全文。超过 7 天的旧文件在启动时自动清理。

**Hooks**：`settings.json` 里的 `hooks` 与 Claude Code 同形：`PreToolUse`、`PostToolUse`、`UserPromptSubmit`、`Stop`。事件内容以 JSON 从 **stdin** 传给脚本（同时放在环境变量 `CLAUDE_PRO_HOOK_INPUT`，另有 `CLAUDE_PROJECT_DIR`）；退出码 0 = 通过（stdout 作为附加上下文），2 = 拦截（stderr 反馈给模型；`Stop` 则让模型继续干活），其他 = 仅警告。

```json
{ "hooks": {
  "PreToolUse":  [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node scripts/no-rm-rf.js" } ] } ],
  "PostToolUse": [ { "matcher": "Edit|Write", "hooks": [ { "type": "command", "command": "npm test --silent" } ] } ]
} }
```

**MCP**：项目 `.mcp.json` 或 settings 中的 `mcpServers`，支持 stdio 和 streamable HTTP：

```json
{ "mcpServers": {
  "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
  "remote": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${TOKEN}" } }
} }
```

## 非交互模式

```bash
claude-pro -p "解释一下 src/agent.js"                  # 只输出最终回答
cat error.log | claude-pro -p "这个报错是什么原因"
claude-pro -p --output-format json "..."              # JSON 结果（含 token 用量）
claude-pro -p --verify "npm test" "修复失败的测试"     # 改完自动跑测试，失败继续修
claude-pro -p --plan "给出重构方案"                    # 只调研、只出方案，不动文件
```

## 快捷键

| 按键 | 作用 |
|---|---|
| `Enter` | 发送 |
| `\` + `Enter` / `ctrl+j` / `alt+enter` | 换行 |
| `Esc` | 中断当前任务；连按两次清空输入 |
| `ctrl+c` | 中断 / 清空输入 / 连按两次退出 |
| `shift+tab` | 开关计划模式（只读） |
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

```
bin/claude-pro.js     入口
src/main.js           参数解析、config 子命令
src/config.js         配置加载（.env / settings.json / 环境变量）与模型解析
src/api.js            Anthropic SDK 封装：流式、重试、effort/thinking 参数
src/agent.js          Agent 循环：工具调度、并行只读工具、中断、自动压缩、验证循环
src/modes.js          会话模式：完全访问 / 计划模式（没有权限规则）
src/checkpoints.js    检查点与 /rewind
src/hooks.js          Hooks 运行器
src/tasks.js          后台子 agent 注册表与完成通知
src/prompts.js        系统提示词、压缩提示词、自动记忆提示
src/tools/*           各工具实现（含 Skill、NotebookEdit）
src/mcp.js            MCP 客户端（stdio / HTTP）
src/ui/*              终端 UI：屏幕管理、输入框、对话框、Markdown 渲染
src/commands.js       斜杠命令
```

## 与 Claude Code 的差异

没有：权限系统（刻意去掉）、IDE 集成、`/login` 等账号功能、插件市场。检查点只覆盖文件工具的修改，不覆盖 Bash 命令造成的改动。WebSearch 通过抓取 DuckDuckGo/Bing 实现（DeepSeek 没有服务端搜索工具）。

提示：选中文字自动复制是终端的功能。Windows Terminal 在设置里打开“选择时自动复制”（settings.json 里的 `"copyOnSelect": true`）即可。

## 历史

这个仓库依次是：自己实现的 agent（旧名 ccc，最后一版保存在 git 标签 `ccc-last`）→ 官方 `claude` 的启动器（提交 `e041b0f`）→ 现在这个版本（自己实现的 agent，去掉权限系统，加入检查点和 Skills）。
