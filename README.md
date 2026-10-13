# claude-pro — 完全访问的命令行编程 Agent

`claude-pro` 是一个**自己实现**的 Claude Code 风格终端 AI 编程助手：可以直接接 **Anthropic 兼容 API**（DeepSeek 的 `https://api.deepseek.com/anthropic`、Anthropic 官方 API 等），也可以读取本机 Claude Code 的现有订阅登录态，直接发送 Claude Code OAuth HTTP 请求。

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

> **认证**：`api` 后端使用 `ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY`；`claude-code` 后端读取现有 Claude Code OAuth 凭据并直接请求 Anthropic。本项目没有登录流程，不复制凭据，也不启动官方 CLI 来生成回复；访问令牌过期时，它用凭据文件里的刷新令牌**自己续期**（见下）。

## 安装与运行

需要 Node.js 22+。Windows 上 Bash 工具使用 Git Bash（与 Claude Code 相同），会自动查找，也可以用 `CLAUDE_CODE_GIT_BASH_PATH` 指定。

从 npm 安装（推荐）：

```bash
npm install -g @yanzc/claude-pro
claude-pro                 # 在任意项目目录里运行
```

自动更新（与 Claude Code 一样）：用 npm 全局安装的版本在启动时、以及运行中**每 5 分钟**查一次 npm 上的最新版（同一台电脑上的所有会话共用这个间隔，查到的新版本号也共享；查询绕过 npm 的 CDN 缓存）。
- **不打断工作**：发现新版后先记下，底部显示 `update x.y.z ready · installs when idle`；**等这个会话和这台电脑上其他开着的会话都空闲**（没有在执行任务、没有等待回答的问题、没有后台 agent/命令/文件传输）才安装，有会话在忙就每 30 秒再看一次，本会话一轮结束时也会再试。
- **安装中有提示**：底部显示 `⇣ updating claude-pro to x.y.z…`（`npm install -g --prefer-online`），装好后提示并自动重启加载，对话保留；重启后显示 `↻ Restarted: updated to claude-pro x.y.z`。
- **多个终端**：同一时间只有一个会话去安装（加锁），其他会话看到程序文件变了，会提示"x.y.z 已由另一个窗口安装"，各自在空闲时重启；正在工作的会话等它的任务结束才重启。
- npm 刚发布时安装包要几分钟才能下载，期间安装失败会在 1 分钟后重试。所以发布后一般 5–10 分钟内各个客户端就用上新版。
- `/update` 立即检查；`CLAUDE_PRO_AUTO_UPDATE=0` 或 `DISABLE_AUTOUPDATER=1` 关闭。从源码运行（git 检出）的副本从不自动更新。

从源码运行：

```bash
git clone https://github.com/yanzaocheng/copy-claude-code.git
cd copy-claude-code
npm install
node bin/claude-pro.js     # 直接运行
npm link                   # 注册全局命令 claude-pro，之后在任意项目目录里输入 claude-pro
```

> 在 Git Bash 自带的 mintty 窗口里交互模式需要 `winpty claude-pro`；推荐在 Windows Terminal / PowerShell / cmd 中运行。

## 复用已有的 Claude Code 登录态

已有本机 Claude Code 订阅登录时，选择 `claude-code` 认证即可，不需要在本项目中登录或填写 API key：

```powershell
node bin/claude-pro.js --provider claude-code
node bin/claude-pro.js --provider claude-code --model opus
node bin/claude-pro.js --provider claude-code -p "用 Read 工具读取 package.json，告诉我项目版本"
```

希望**所有目录**默认都复用该登录态（写入 `~/.claude-pro/settings.json`）：

```powershell
claude-pro config set CLAUDE_PRO_PROVIDER claude-code
```

只对当前项目生效时加 `--local`（写入 `<项目>/.claude-pro/settings.local.json`，优先于用户级设置）。反过来，某个项目要继续用 `.env` 里的 API（如 DeepSeek）：在那个项目里 `claude-pro config set CLAUDE_PRO_PROVIDER api --local`，或者只这一次 `claude-pro --provider api`。

`~/.claude.json` 保存设备 ID 和 OAuth 账号信息，实际访问令牌保存在 `~/.claude/.credentials.json` 的 `claudeAiOauth.accessToken` 中。Windows 对应 `%USERPROFILE%\.claude.json` 和 `%USERPROFILE%\.claude\.credentials.json`。可用 `CLAUDE_PRO_CLAUDE_CONFIG_FILE` 和 `CLAUDE_PRO_CLAUDE_CREDENTIALS_FILE` 指向现有文件；`CLAUDE_CONFIG_DIR` 可以指定凭据目录。凭据位置参考[官方认证文档](https://code.claude.com/docs/en/authentication#credential-management)。

调用方式是：本项目 → `https://api.anthropic.com/v1/messages?beta=true`。请求复用 `Authorization: Bearer <accessToken>`，带上 Claude Code 的 OAuth beta、`x-app: cli`、User-Agent、系统标识，以及来自 `.claude.json` 的设备和账号 metadata。流式响应、原生 `tool_use` / `tool_result`、工具执行、hooks、检查点及会话功能都由本项目原有逻辑处理。

此模式默认 `sonnet` → `claude-sonnet-5-5`，`opus` → `claude-opus-5-5`，`haiku` → `claude-haiku-5-5`（与 Claude Code 2.1.293 起一样；话题标题、WebFetch 摘要等小请求用它）；子 agent 默认用 `sonnet`（`CLAUDE_PRO_CLAUDE_CODE_SUBAGENT_MODEL` 可改）。使用 `--model`、`/model` 或 `CLAUDE_PRO_CLAUDE_CODE_MODEL` 指定模型。**`/model`、`/effort` 的选择会一直保留**：按后端记在 `~/.claude-pro/settings.json` 的 `remembered` 里，之后每次启动（交互式和 `-p`）都沿用，优先于 `.env`/settings/环境变量里的配置；命令行 `--model`/`--effort` 只覆盖当次启动；`/model default`、`/effort default` 删掉记住的选择，回到配置的值。`claude-pro config list` 会显示当前记住的选择。已有的 DeepSeek API URL、API key 和 API 模型别名不会参与订阅请求。OAuth 令牌始终只发往 Anthropic，原 API 配置可以通过 `--provider api` 继续使用。

每次请求重新读取现有凭据；如果本机 Claude Code 更新了令牌，下次请求自动使用新值。

**令牌自动续期**：访问令牌有效期 8 小时。发请求前如果它已过期或不到 5 分钟就过期，本项目会用同一个文件里的刷新令牌向官方令牌接口续期（协议与官方客户端一致），把新令牌写回 `.credentials.json`——刷新会**轮换刷新令牌**，所以必须写回，否则官方客户端手里的就是失效的。写回只改令牌相关字段、原子替换、保持原有缩进；和官方客户端使用同样的目录锁（`.claude/.oauth_refresh.lock` 与 `.claude.lock`），两边不会同时刷新，抢先被对方刷新过就直接用对方的结果。请求收到 401 时也会强制续期一次再重试。只有刷新令牌本身被拒绝或过期（约 30 天不用）时才需要你运行 `claude` 再 `/login`，此时报错会写明原因。不想让本项目改写凭据文件：`CLAUDE_PRO_DISABLE_TOKEN_REFRESH=1`。令牌接口地址固定，不能通过任何设置（包括项目里的 `.env`）改掉，避免刷新令牌被发到别处。HTTP 认证兼容方式依赖 Claude Code 的接口约定，官方协议变化时可能需要同步调整；可用 `CLAUDE_PRO_CLAUDE_CODE_VERSION` 指定 User-Agent 中的版本（默认读取本机 npm 安装版本）。

## /login：Claude 订阅、网关、Codex 订阅三选一

什么都没配置时（没有 `CLAUDE_PRO_PROVIDER`，也没有 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`）默认用**网关**，第一次启动直接弹出登录选择（网关排第一）；配置了 API 端点、密钥或模型的老用户仍然默认 `api`。交互界面里 `/login` 选择模型请求发往哪里（记在 `~/.claude-pro/settings.json` 的 `CLAUDE_PRO_PROVIDER`，每个后端各自记住 `/model`、`/effort`）：

- **Claude 订阅**（`claude-code`）：本机 Claude Code 的登录，见上一节。
- **网关**（`gateway`）：[codex-gateway](../codex-gateway) 的账户，默认 `https://gw.predix.icu`（`CLAUDE_PRO_GATEWAY_URL` 可改）。第一次选它会在浏览器打开网关的登录页，登录（或注册）后点“授权”，浏览器被带回本机，claude-pro 用一次性 code 换到这台电脑专用的 API Key，存在 `~/.claude-pro/gateway.json`（仅本人可读）。费用从网关账户余额扣，`/cost` 显示余额，充值和用量在网关的 `/user` 页面。模型默认 `opus`，`/model` 可选 `sonnet`、`haiku`、`gpt-6.1-sol`（网关用它自己的 Codex 登录转发，按 OpenAI 官方价扣费）；子 agent 在 Claude 主模型下没有固定模型：主 agent 每次调用 `Task` 按任务难易自己选 `haiku`（查找、读文件）、`sonnet`（搜索、步骤清楚的子任务）或 `opus`（难调的 bug、设计、审查等结论要依赖的分析），`Task` 的说明里列着三者的实际模型和价格；没选时用主模型（GPT 主模型下子 agent 用主模型）。网关每次请求按 `max_tokens` 预扣余额，所以这里默认 `max_tokens` 是 48K（Opus 预扣 $0.96，请求结束按实际输出扣费；`CLAUDE_CODE_MAX_OUTPUT_TOKENS` 可改）。每个请求带上会话 ID（`X-Claude-Code-Session-Id`，和 Claude Code 一样；子 agent 用主对话的，`/clear` 换新的，`--resume` 和自动重启沿用原来的），网关据此让同一个对话 1 小时内继续用同一个上游账号，提示词缓存才不会因为换账号而失效。`/logout` 删除本机的网关 Key。
- **Codex 订阅**（`codex`）：本机 `codex login`（ChatGPT 套餐）写下的 `~/.codex/auth.json`（`CODEX_HOME` 可改）。请求直接发往 Codex 后端，Anthropic 格式在本机和 OpenAI Responses 格式互相转换（工具调用、推理、缓存用量都对应上）；访问令牌快到期时用同一文件里的刷新令牌续期并写回，Codex CLI 也能接着用。模型默认取 `~/.codex/config.toml` 的 `model`，否则 `gpt-6.1-sol`；不设 effort 时用模型自己的默认值（`models_cache.json` 里写的）。

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

其他可选项：`CLAUDE_CODE_MAX_OUTPUT_TOKENS`、`MAX_THINKING_TOKENS`（0 关闭思考）、提示词缓存的 `CLAUDE_CODE_PROMPT_CACHE_TTL`、`CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`、`ENABLE_PROMPT_CACHING_1H`、`FORCE_PROMPT_CACHING_5M`、`DISABLE_PROMPT_CACHING`（见下文“提示词缓存”）、`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`、`DISABLE_AUTOCOMPACT`、`API_TIMEOUT_MS`、`BASH_DEFAULT_TIMEOUT_MS`、`BASH_MAX_TIMEOUT_MS`、`BASH_MAX_OUTPUT_LENGTH`、`ANTHROPIC_API_KEY`、`ANTHROPIC_CUSTOM_HEADERS`，以及本项目自己的 `CLAUDE_PRO_MAX_RETRIES`、`CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS`、`CLAUDE_PRO_RATE_LIMIT_POLL_MS`（见下文“限流”）、`CLAUDE_PRO_MAX_TOOL_RESULT_CHARS`、`CLAUDE_PRO_CLEAR_AFTER_IDLE`（见下文“提示词缓存”）、`CLAUDE_PRO_MAX_SUBAGENT_DEPTH`、`CLAUDE_PRO_VERIFY_COMMAND`、`CLAUDE_PRO_VERIFY_MAX_ROUNDS`、`CLAUDE_PRO_DISABLE_AUTO_MEMORY`、`CLAUDE_PRO_RIPGREP_PATH`（rg 的路径；`off` 强制使用内置 JS 搜索）、`CLAUDE_PRO_CONFIG_DIR`。完整列表见 `claude-pro config list`。

```bash
claude-pro config list                                   # 查看生效值及其来源
claude-pro config set CLAUDE_CODE_EFFORT_LEVEL high      # 写入 ~/.claude-pro/settings.json
claude-pro config set ANTHROPIC_MODEL deepseek-pro --project
```

会话中也可以用 `/config`、`/model`、`/effort` 修改。

## 提示词缓存：和 Claude Code 一致，尽量少花钱

每次请求都会把整个对话重新发给模型，账单的大头是"重复读历史"。本项目按 [Claude Code 的做法](https://code.claude.com/docs/en/prompt-caching)使用 Anthropic 的提示词缓存：

- **断点**：在工具列表末尾、系统提示词、最新一条消息的末尾各放一个 `cache_control`（共 3 个，上限 4 个）。系统提示词在一个会话里只构建一次，前缀稳定才能命中。
- **开箱即用，不需要配置**：默认值和 Claude Code 一致。订阅登录（`--provider claude-code`）和网关（`gateway`）下**主对话用 1 小时**缓存（Claude Code 在订阅额度内就是这样请求的；网关按 2 倍价计费 1 小时写入，但按网关的用量记录算，533 次 Opus 请求里停顿 5–60 分钟让整段对话重写了 9 次、多花 $14.77，全部改用 1 小时只多花 $2.80），API key / 其他端点用 5 分钟（API 默认值，不发送 `ttl` 字段）；子 agent、压缩等其他请求永远默认 5 分钟。effort 不设就用模型自己的默认值（Sonnet 5.5、Opus 5.5 是 medium），自动压缩窗口不设就是模型的整个窗口。
- **`.env` 只属于 API 提供方**：`--provider claude-code` 时，`.env` 里的 `CLAUDE_CODE_EFFORT_LEVEL`、`CLAUDE_CODE_AUTO_COMPACT_WINDOW`、`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`、`CLAUDE_CODE_MAX_OUTPUT_TOKENS`、`MAX_THINKING_TOKENS` 不会被读取（它们是为 DeepSeek 之类的端点调的），订阅模式用上面的默认值；`/config` 会列出被忽略的键。想在订阅模式下调，用 `/config set`、`/effort`、设置文件、环境变量或 `--effort`，这些照常生效。
- **TTL 分两个桶**（可以改），每次命中会重新计时：
  - **主对话**（你的每一轮）：`CLAUDE_CODE_PROMPT_CACHE_TTL=5m|1h`，或设置项 `promptCacheTtl`
  - **其他请求**（子 agent、压缩、小模型的辅助请求）：`CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=5m|1h`，或设置项 `subagentPromptCacheTtl`
  - 变量优先于设置项（无论来自哪个文件）；无效的值被忽略，按下一条规则算。`ENABLE_PROMPT_CACHING_1H=1` 让两个桶都用 1 小时（上面两个变量和设置项优先）；`FORCE_PROMPT_CACHING_5M=1` 强制两个桶都用 5 分钟，优先级最高；其他取值被忽略。
  - 1 小时档的缓存写入按 2 倍价格计费（5 分钟档是 1.25 倍），而且每一轮新增的内容都按这个价写：用 API key 按 token 付费时，只有上下文很大、而且常常停顿超过 5 分钟才划算，所以那里默认是 5 分钟。订阅额度内 Claude Code 默认用 1 小时；想在订阅模式或网关下用 5 分钟，设 `FORCE_PROMPT_CACHING_5M=1`。
- **关闭缓存**：`DISABLE_PROMPT_CACHING=1` 完全不发 `cache_control`；`DISABLE_PROMPT_CACHING_HAIKU` / `_SONNET` / `_OPUS` 只关 haiku/sonnet/opus 别名所指的模型，`_FABLE` 只关 Fable 模型。
- **端点不认**：网关对 `cache_control`（或 `ttl`）返回 400 时，不会让请求失败：在被点名的位置去掉标记（报 `ttl` 则退回 5 分钟）后重发；没点名位置的报错一次去掉一处（先消息、再工具、再系统提示词），尽量多保留缓存。请求成功之后才记住这个端点拒绝了什么（之后不再发送），`/status` 会显示；报错本身只是提到 `cache_control` 而去掉标记也没用时，什么都不会记住。
- **一次性的请求不加缓存标记**：WebFetch 摘要这类整页内容只发一次的小模型请求，缓存写入只会多收钱，所以不标记。
- **压缩复用缓存**：压缩请求就是对话自己的请求（同样的模型、系统提示词、工具、effort），只在末尾追加一条"请写摘要"的指令，所以能读到前面各轮写好的缓存，而不是把整个历史重新处理一遍。只有这样得不到摘要（模型一直想调工具）或请求超长时，才退回更简单、不能命中缓存的请求。
- **会话中途不改系统提示词**：保存记忆（`#`）、`/config set` 只做标记，系统提示词要到下一次 `/clear` 或压缩时才重建（与 Claude Code 对 CLAUDE.md 的处理一致）；`/status` 会提示有待生效的改动。子 agent 共用会话开始时的日期和 git 状态快照，同类型的子 agent 反复启动时前缀相同。会话跨过午夜时，系统提示词里的日期不变（保住缓存），新日期以一条提醒附在下一条消息后面，每天一次。
- **恢复会话**：会话文件里保存了当时的系统提示词（`/clear` 之后的新会话也保存），`--resume` / `/resume` 继续用它，所以缓存还没过期时能接着命中；模型不同、或这次的 `--append-system-prompt` 文本不同时不用它，重新构建。日期过期了，会在下一条消息后面附一句提醒。
- **离开一个多小时后清掉旧的工具结果**：距上一条消息超过 65 分钟再发消息时，缓存一定已经过期，这次请求本来就要把整段对话重写一遍。这时和 Claude Code 一样，把最近 5 个以外的旧工具结果（读文件、命令、搜索、网页的输出）换成一行占位，能清掉的不足 2 万 token 就不动；之前的 thinking 也一起去掉（改了早先的工具结果，API 就不再接受它后面的 thinking）。之后每次请求都少读这部分。命令、搜索的原始输出存进 `tool-results/`，模型需要时能读回来；文件需要时重新读，编辑前也要求先重读。子 agent 的报告、你的回答等不清。默认只对订阅登录和 api.anthropic.com 开启；DeepSeek 等其他端点的缓存可能保留几个小时，清了反而不命中，默认关。`CLAUDE_PRO_CLEAR_AFTER_IDLE=1` / `0` 强制开关。
- **缓存还热时，切换要确认**：`/model`、`/effort` 会让下一次请求把整个对话重读一遍，缓存还没过期时会先问一下；过期了、新对话、或端点不报告缓存用量时不问。
- **看效果**：`/cost` 显示命中率、miss 次数、缓存是否还热、最近一次 miss 的可能原因（系统提示词/工具/effort/模型变了，还是缓存过期了）；子 agent 和压缩的用量也算在内。`-p --output-format json` 的 `usage` 同样含子 agent 和压缩，并带 `cache_creation_input_tokens`。

## 限流：自动暂停，到点自动恢复

订阅账号（`--provider claude-code`）有滚动窗口限额：5 小时和每周。窗口用完后 API 返回 429，并在 `anthropic-ratelimit-unified-*` 响应头里写明是哪个窗口、什么时候重置（与官方客户端读取的字段相同）。遇到这种情况本项目**不再报错停下**，而是：

1. 暂停当前请求，界面上显示实时倒计时：`✻ 5-hour limit reached · resumes at 23:41 (in 2h 13m) (esc to cancel)`，并记录一行说明；
2. 到重置时间（再加几秒余量和随机抖动，避免多个子 agent 同时冲上去）后，**原样重发同一个请求**，对话、已完成的工具结果都不受影响，不会重复发送你的提示；
3. 请求被接受后提示 `The limit has cleared; continuing.`，任务接着做完。

要点：

- **等待期间可以随时 `Esc` 取消**；`-p` 模式会在 stderr 打印同样的说明，进程保持运行直到恢复。
- **服务器没给出重置时间**（只有一句泛泛的 429）时，按 1s、2s、4s…递增、最长 `CLAUDE_PRO_RATE_LIMIT_POLL_MS`（默认 5 分钟）的间隔反复试，限流一解除就继续。
- **等待上限** `CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS`，默认 6 小时（够等一个 5 小时窗口）。重置时间超出上限（比如周限额还有几天）时立即报错，并写明「它在几点重置、还有多久」，而不是只说“稍后再试”。设为 `0` 则不等待、直接报错；`CLAUDE_PRO_MAX_RETRIES=0` 会关闭一切重试（含等待）。
- 等待用墙上时钟分段检查（每 15 秒一次），电脑睡眠/休眠后醒来会立刻发现已过了重置时间，不会多等。
- **登录令牌**：官方登录的访问令牌有效期 8 小时，等 5 小时窗口恢复时它多半已经过期。恢复时本项目先**自己用刷新令牌续期**（见上文"令牌自动续期"），然后接着做，不需要你干预。只有续期失败时才会等：刷新令牌被拒绝（需要 `claude` → `/login`）、令牌接口暂时连不上、或关闭了自动续期。此时界面显示"Waiting for the Claude Code login to be renewed"并写明失败原因，每 5 分钟重试续期、每 15 秒检查一次凭据文件，你登录后就自动接着做；等待时长受上面的等待上限剩余部分约束，用完才报错，并写明失败原因和已经等了多久。凭据文件恰好被别的进程写到一半（JSON 不完整）也按同样方式等过去。
- **压缩对话时**撞上限流同样会暂停，界面显示同样的倒计时（不会一直停在"Compacting conversation"上让人以为卡死了）。
- **子 agent 和后台 agent** 同样会等待，暂停与恢复都以 `[agent 名]` 为前缀提示一次（倒计时那一行属于主 agent，因为后台 agent 暂停时主 agent 可能还在干活）。轮询（服务器没给重置时间）每隔几分钟重试一次，但只提示一次，不会刷屏。
- `/doctor` 这类诊断请求不等，直接报告限流。
- **API 过载（529 / `overloaded_error`）** 也不会让任务停下：先按 `CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS`（默认 1 秒）起、每次翻倍、最长 `CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS`（默认 32 秒）快速重试 `CLAUDE_PRO_MAX_RETRIES` 次；用完后转为暂停（界面显示 `API overloaded · checking again in …`，Esc 取消），每隔最长间隔再试一次，直到 API 恢复（提示 `The API is answering again; continuing.`），最多等 `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS`（默认同 `CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS`，6 小时；`0` = 重试用完就报错）。

## 终端标题、页脚与窗口缩放

- **终端标题**：标签/窗口标题显示 `✳ <会话标题> | <目录> · <模型> · <effort>`（会话标题是**当前话题**：每次发消息后，后台让小模型（haiku）判断是否换了话题，换了就生成一个简短标题，和官方客户端一样；"继续"之类的消息不会改标题。话题记在会话文件里，`/resume`、重启后仍在，`/resume` 列表也显示它。旧会话没有话题时，恢复时按最近一条提问生成。还没生成时显示第一条提问。最多 40 字，保证模型和 effort 不被窄标签截掉。`CLAUDE_PRO_DISABLE_TOPIC_TITLE=1` 关闭，省掉每条消息一次的小请求）。忙碌时前缀在 `⠂`/`⠐` 之间闪动，限流暂停时变 `⏸`，退出时恢复进入前的标题。`/model`、`/effort`、`/clear`、`/resume` 后自动更新。**VS Code**(1.140 起)只对它认得的 AI 命令行(claude/codex/copilot/gemini)把程序设置的标题显示在标签上(`terminal.integrated.tabs.allowAgentCliTitle`,默认开),其余一律显示进程名 `node`;它在 Windows 上靠 `node.exe` 命令行里的 `\claude-code\` 路径段识别 Claude Code,所以监督进程用 `bin\claude-code\..\claude-pro.js` 启动会话(目录不必存在,Node 自己化简 `..`)。不经过监督进程的启动方式(`CLAUDE_PRO_NO_SUPERVISOR=1`)或 Linux/macOS 上,要在 VS Code 设置里把 `terminal.integrated.tabs.title` 改成 `${sequence}` 才能看到标题。
- **用户的提问**：带一条深灰色背景（横跨整个窗口宽度），和回复一眼就能分开。背景条是用当前背景色清除行尾（`\x1b[K`）画出来的，不靠补空格，窗口变宽变窄都正好铺满。
- **页脚**：输入框下方右侧常驻当前模型和 effort（如 `sonnet-5-5 · high`）；没发送 effort（auto）或该模型不支持时只显示模型；窄窗口放不下时先让位给"上下文快满"等提示，再不行就不显示。模型前面是**当前对话累计花费**（如 `$1.23 · opus-5-5 · effort high`）：按官方价（和网关扣费同一张价目表，含 5 分钟/1 小时缓存写入、长上下文价）把每个请求算进去，子 agent、压缩、话题标题、WebFetch 都算，按 Esc 中断的请求按已读入的输入和估算的已输出部分算；记在会话文件里，重启、`/resume` 后接着累计，`/clear` 从零开始。`/cost` 第一行也显示它，`-p --output-format json` 的结果带本次运行的 `total_cost_usd`。不认识价格的模型（第三方端点的自定义模型）不计；网关上游分组倍率不是 1 的账户以网关流水为准。花费前面是**提示词缓存时钟**（和官方 VS Code 扩展的 prompt cache clock 一致）：`◷ 12m` 表示对话的缓存估计还能保留 12 分钟（按 5 分钟或 1 小时 TTL 倒数，每次用到缓存的回复重新开始计时）；倒数结束后分钟数消失、图标变红，直到下一次回复——这时发下一条消息会把整个对话重新写入缓存，更慢也更贵；压缩之后到下一次回复之前也是红色，因为压缩后的对话还没进缓存。时钟记在会话文件里，重启、`/resume` 后接着显示（压缩后关掉的会话恢复时是冷的）；还没有回复报告过缓存用量时不显示。窄窗口先省掉花费，再省掉时钟。
- **缩放窗口**：拖动期间不重绘，停下约 80ms 后从左上角整屏绝对重绘一次，输入框不会再留下残影。注意：很短的会话里这次重绘会覆盖终端上方 shell 的内容。

## 自动重启：改了自己的代码马上生效

交互式会话运行在一个很薄的**监督进程**（`src/supervisor.js`，只用 Node 内置模块）之下，所以程序可以自己重启、加载自己刚改过的代码，不需要你退出再启动：

- **模型自己重启**：改完 `src/`、`bin/` 里的代码后，模型调用 `Restart` 工具。它先在一个临时进程里把新代码完整启动一遍（所有模块能加载、界面能画出来、工具定义和系统提示词合法）——**启动不起来就不重启**，把错误还给模型去修，修好再调用；通过后在**本回合结束时**重启，对话、待办列表、`/model`、`/effort`、排队的消息、输入框里没发出去的草稿、`/rewind` 检查点都带过去，新进程里模型收到一条"已重启"的提示后接着做（可用 `then` 指定重启后先验证什么）。只在**源码仓库**（有 `.git` 的克隆，包括 `npm link` 到它）里这样做：从 npm 装的副本没有版本控制、下次更新会被覆盖，那里不给模型 `Restart` 工具，系统提示词改成"不要改自己的文件，绕过问题并在最后说明缺陷，方便用户反馈"。
- **改了源码自动重启**：一个回合结束（或空闲）时，如果 `src/`、`bin/` 下的文件变过，就自动做同样的检查并重启。检查不通过只提示错误、不重启。按 Esc 打断的那一回合不会触发。`CLAUDE_PRO_AUTO_RESTART=0` 关闭。
- **手动**：`/restart`（别名 `/reload`），`/restart force` 跳过检查并无视后台任务。
- 后台 agent / 后台 shell 会被重启杀掉，所以有它们在跑时拒绝重启（可 `force`）。5 分钟内重启超过 5 次视为死循环，拒绝。
- 重启之间终端保持原样（不退回 shell 提示符，原始模式不关），重启时敲的键不会丢；标签标题也不闪。
- 需要真正退出再启动的只有两种情况：改了 `bin/claude-pro.js` 或 `src/supervisor.js`（运行中的监督进程是旧代码）；以及新代码启动不起来而你想强行重启。`-p`、管道、`config` 子命令不经过监督进程；`CLAUDE_PRO_NO_SUPERVISOR=1` 也可以关掉它（环境变量，不是配置项）。
- `claude-pro --self-check` 可以单独运行那个启动检查。

## 远程控制：在浏览器或手机上看执行过程、下发指令

和 Claude Code 的 `/remote-control` 一样，可以在手机或另一台电脑上看着会话干活，并给它发指令；这里**不用任何命令或设置**。官方版经 Anthropic 中转，这里经**网关**（gw.predix.icu，即 `CLAUDE_PRO_GATEWAY_URL`）中转：claude-pro 只向网关发出站请求，**不监听任何端口，不走局域网**；在网关用户端登录后，左侧菜单"**远程控制**"里按电脑分组列出自己的会话，可以查看、操作，也可以在某台电脑上新建、结束、重启会话，恢复历史对话（见下面"网页管理电脑和后台会话"）。模型请求走哪个提供方都可以，远程控制只用网关的登录。

- **默认在线**：这台电脑登录了网关（`/login` 选网关）以后，每个交互会话启动时自动连上网关（不阻塞启动，断开后自动重连），网页上能看到这台电脑上所有开着的会话，别的电脑也能给它们发任务（见下一节）。`/login` 登录成功后当前会话**马上上线**（不用重启），并打印它的链接；`/logout` 后马上下线；在别的窗口登录或退出，这个窗口几秒内跟上。想让模型请求走 Claude 订阅：先 `/login` 选网关登录，再 `/login` 选 Claude 订阅，网关登录保留，会话照样在线。
- **链接和二维码**：`/status` 显示这个会话的远程状态（在线、连接中、没登录、key 被拒…）、它在网关上的链接（`https://gw.predix.icu/user#remote/<id>`）和二维码，手机扫码即可打开（没登录时先登录，登录后直接进入这个会话）。所有会话的列表在 `/user#remote`。在线时输入框右上角显示 `⇄ &名字`，有网页在看时页脚显示 `⇄ N watching`。
- **网页上能看到**：完整对话（用户消息、流式输出的回答、可展开的思考、工具调用和结果，包括 diff 和正在运行的命令的最新几行输出）、斜杠命令和提示的输出、当前状态（正在想/运行多久/多少 token、限流暂停的倒计时）、待办列表、排队中的消息。
- **网页上能做**：发消息（和在终端里输入完全一样：忙的时候排队插入，`/命令`、`!shell` 都可以）、**Stop**（等于 Esc）、回答模型的提问（`AskUserQuestion`，含多选和"其他"）、以及 `/model`、`/rewind` 之类命令弹出的选择框。网页顶部可以直接改会话的名字、工作目录（`/cd`，带目录浏览）、模型和 effort（都是替你发对应的斜杠命令，终端里显示同样的结果；任务进行中不能改）。网页输入框里输入 `/`、`@`、`&` 有和终端一样的补全，也能粘贴或拖入图片（每次最多 6 张、每张不超过 5 MB，PNG/JPEG/GIF/WebP）。终端和网页可以交替使用，两边同步。
- **安全**：只有同一个网关账户登录后才能看到和操作这个会话；**能登录这个网关账户的人，就能通过它在这台电脑上以完全权限执行命令**。会话内容经网关中转并暂存在网关上。
- **省流量**：没人打开网页时只上报状态（列表里的标题、忙/闲），不上传对话；有人打开时先发一份完整快照，再实时推送。
- **重启不断线**：自动重启（改了源码、自动更新）沿用同一个会话 id，网页显示"重启中"后接着看；网关重启丢了状态时，claude-pro 自动重新注册并补发完整对话。
- 一个会话对应网关上的一个远程会话。每个网关账户最多 20 个（超出时淘汰最久没活动的离线会话）；已结束的会话在列表里保留 6 小时，断开但没结束的保留 24 小时。不支持从网页上传图片。
- 不想在线：`/logout`（这台电脑的会话和电脑服务都会下线）。

### 网页管理电脑和后台会话（电脑服务 `claude-pro host`）

装了 claude-pro 的电脑就是网页的"执行者"：网页是操作界面（新建、打开、结束、重启会话，恢复历史对话，看电脑状态和日志），电脑在后台执行，不弹窗口。在终端里手动开的 claude-pro 照常工作，也照常出现在网页上（同一台电脑下）。

- **接入一台新电脑**：网页"远程控制"里点**添加电脑**，它给出一条命令，例如 `npm i -g @yanzc/claude-pro && claude-pro connect K7QF-M2XD`（`--url <网关>` 可选），在那台电脑上运行一次：用配对码换到这台电脑自己的密钥（存进 `~/.claude-pro/gateway.json`，和 `/login` 一样），设置登录后自动启动，并马上启动电脑服务，打印"已连接到 <账户>，可以在网页上使用这台电脑了"。已经 `/login` 过网关的电脑不用 connect：`/login` 成功后同样会设置自动启动并启动电脑服务；登录了网关的会话启动时也会做一次。
- **新建会话**：选电脑、浏览目录（上面列出最近用过的目录）、可选模型，创建。默认是**后台会话**：那台电脑上没有任何窗口，会话完全在网页上使用（和终端里的 claude-pro 同一套代码，命令、工具、记忆、CLAUDE.md、自动更新都一样）；勾上"同时打开终端窗口"才弹出终端窗口（Windows Terminal，没装时是普通控制台；macOS"终端"；Linux 桌面上的终端，没有桌面时是 tmux）。一台电脑可以开很多个，每个都是独立进程，一个崩溃不影响别的。
- **历史对话**：网页列出这台电脑上保存的对话（可搜索），点一下就在原来的目录里恢复成后台会话；已经开着的直接打开那个会话。
- **后台会话的管理**：网页上可以结束（等于 `/exit`，忙时先中断，10 秒不退就强制结束）、重启（等于 `/restart`，对话保留）、看日志、展开某个工具调用的完整输出。会话意外退出时自动拉起（同一段对话、同一个网页链接；10 分钟内最多 3 次，之后标为失败并显示日志最后几行，可以在网页上重启）。电脑重启后，电脑服务会重新打开之前的后台会话（只恢复对话，不自动继续被中断的任务）；用结束或 `/exit` 关掉的不再打开。
- **在本机终端接上后台会话**：`claude-pro attach [名字]`（不带名字时列出本机的后台会话供选择）：完整的终端界面，可以输入；`Ctrl+]` 断开，会话继续在后台跑。可以同时 attach 多个终端，网页也可以同时看。会话重启时 attach 自动重新接上。后台会话里 `Ctrl+C` 两次或 `Ctrl+D` 不会结束会话（只有 `/exit` 会）。
- **自动启动**：默认在用户登录后启动（Windows 在"启动"文件夹放一个不弹窗口的 .vbs；macOS 是 LaunchAgent；Linux 桌面是自动启动项，没有桌面时是 systemd 用户服务）。`claude-pro host install --at-boot`：**开机就运行，不用登录**（Windows 是"系统启动时"运行的计划任务，以当前用户身份、不管是否登录，不保存密码，所以访问不了网络共享；需要在"以管理员身份运行"的终端里执行。Linux 是 systemd 用户服务加 `loginctl enable-linger`。macOS 没有 root 做不到，只能登录后启动）。`claude-pro host uninstall` 撤销（之后会话和 `/login` 不会再自动设置）；`CLAUDE_PRO_HOST=0` 完全关掉自动启动和自动拉起。
- **其他命令**：`claude-pro host status`（是否在运行、在线、自动启动方式、日志位置）；`claude-pro host stop`（停掉，并把这台电脑从网页列表里去掉；之后会话不再自动拉起它，`claude-pro host start` 才重新启动；后台会话继续运行，下次启动的电脑服务会接管）；`claude-pro host`（在前台运行，看日志调试用）。服务日志在 `~/.claude-pro/host.log`（网页上也能看），后台会话的日志在 `~/.claude-pro/logs/sessions/<id>.log`，状态在 `~/.claude-pro/host.json`，后台会话列表在 `~/.claude-pro/host-sessions.json`。
- **跟着登录走**：`/logout`、或者网页上移除了这台电脑（密钥作废）后，后台会话结束（保留在恢复列表里），服务从网页列表下线并等待；重新 `/login` 或 `claude-pro connect` 后自动恢复。claude-pro 升级或源码改动后，服务一两分钟内自己换成新版本：先确认新版本能加载，加载不了就继续用旧的，不会让网页失去这台电脑。
- **安全**：能登录这个网关账户的人，可以在这台电脑上任意目录打开会话、以完全权限执行命令。

## 会话之间互发任务（本机和其他电脑）

每个交互会话都有一个名字（默认是目录名，输入框右上角的 `&名字`），别的会话可以给它发任务，它做完后回答自动发回来。

- **本机**：同一台电脑上开着的会话直接互通（经 127.0.0.1，不经过网络）。
- **其他电脑**：同一个网关账户下在线的会话经网关互通。例如公司电脑上开着 claude-pro，在家里输入 `&公司 跑一下测试`，任务送到公司那台的会话，回答自动显示在家里这边。电脑名默认是主机名，用 `CLAUDE_PRO_MACHINE_NAME=公司` 改成好记的名字（支持中文）。
- **输入 `&`** 弹出所有能发的会话（本机的和其他电脑在线的），选一个再写任务回车即可：
  - `&名字 任务`：本机的会话；
  - `&电脑名/名字 任务`：其他电脑上的会话；那台电脑只开着一个会话时直接 `&电脑名 任务`。
  - `@` 只用于引用文件。
- **发送文件**：`/sendfile &公司 C:\Users\yzc\Pictures\a.jpg C:\Users\yzc\Pictures\b.jpg`（别名 `/sf`），文件存进对方电脑的「下载」文件夹（Windows 上是系统设置的下载位置；`CLAUDE_PRO_DOWNLOAD_DIR` 可改），同名文件不覆盖、存为「名字 (1).jpg」，对方存好后把保存位置回给你。不经过模型、不花 token。路径可以带空格（不加引号也行）、可以用 `@` 补全文件名；每次最多 20 个文件、每个最多 5 GB；文件夹要先压缩。
  - **大文件、断点续传**：文件在后台分块发送，输入框下面显示进度（`⇡ 会议录像.mp4 → &公司/proj 42% · 921.6 MB/2.1 GB`），期间可以照常使用会话。网络断了会自动等待重试（最长 1 小时），恢复后从断开的地方接着传；中途关掉了 claude-pro 或 `/sendfile stop` 停掉了，之后再 `/sendfile` 同一个文件，会接着之前传到的位置继续（24 小时内）。接收方同样边下边存，断了用续传接着下，下完校验 sha256 再改成正式文件名；接收方中途退出的话，重新上线后会自动接着下载。也可以直接对 agent 说「把这几张图发到 &公司」，它用 MessagePeer 的 files 参数发送；文件也可以和任务一起发（对方收到任务时知道文件存在哪）。其他电脑之间的文件经网关中转（存 24 小时，对方取走后即删除），同一台电脑上直接复制。文件经网关服务器中转，传输速度受网关服务器带宽限制。
- **`&` 可以写在句子中间**：输入时在空格后面打 `&` 也会弹出会话列表（比如 `/sendfile a.jpg &`）；在发给当前 agent 的消息里提到 `&名字`，agent 会被告知那是哪个会话、怎么联系它。输入法打出全角 `＆` 也可以。
- **`/rename 新名字`**：给当前会话改名（比如 `/rename web-server`），别的会话从此用 `&web-server` 找它；这个名字也成为对话标题（终端标签页、`/resume` 列表、网页），不再自动按话题改；`/resume` 这个对话时名字一起回来。
- **`/peers`**：列出本机和其他电脑上在线的会话。模型也能用 ListPeers / MessagePeer 工具自己找别的会话分派任务。
- 回答会在对方这一轮做完后自动发回；对方正忙时，任务排在它当前工作之后。网关替离线的会话暂存回答（24 小时；网关重启会丢失还没送达的消息）。
- **安全**：在线的会话能被同一网关账户执行任何任务。能登录这个账户、或持有它任一 API key 的人，都能在这些电脑上以完全权限执行命令。不需要时 `/logout`。

## 完全访问与安全网

- **没有权限系统**：没有确认弹窗，没有 allow/deny 规则，也没有 `/permissions`。旧参数 `--dangerously-skip-permissions`、`--permission-mode`、`--allowedTools`、`--disallowedTools` 仍被接受但会被忽略，`--plan` 也是；settings 里残留的 `permissions` 字段也会被忽略。
- **没有计划模式**：想先看方案再动手，直接在消息里说（例如"先给方案，我确认前不要改代码"）。
- **检查点与 `/rewind`（或在空输入框连按两次 `Esc`）**：每条提问都会建一个检查点，Write / Edit / NotebookEdit 修改文件前会先保存原样。和官方一样，菜单按时间列出这次会话的提问（最新的在最下面、默认选中），选一条后可以：**Restore code and conversation**（代码和对话都回到这条之前）、**Restore conversation**（只回退对话，文件不动）、**Restore code**（只恢复文件，对话不动）、**Summarize from here**（这条及之后的对话压缩成摘要，腾出上下文）、**Summarize up to here**（这条之前的压缩成摘要，之后的原样保留）、**Never mind**（回到列表）。回退对话或"Summarize from here"后，那条提问的原文（完整的，不截断）回填到输入框，可以改了再发，相当于删掉不想要的那段对话重新来。`/clear` 之后，菜单最上面多一项 `/resume <id> (previous session)`，可以回到 `/clear` 之前的对话（本进程内有效）。**Bash 命令造成的改动不会被记录**，所以模型被要求优先用文件工具改文件。
- **想要护栏时用 hooks**：`PreToolUse` 钩子仍然可以拦截任何工具调用，由你自己定规则（见下）。
- 模型自己的使用规则不受影响，系统提示里的安全条款与官方 Claude Code 现在的措辞一致：允许授权的安全测试、防御、CTF、教学，拒绝恶意用途。这一条是模型的使用规范，不是能力限制，没有去掉。

**已经放开的限制**（都可以用环境变量改回去）：

| 项目 | 以前 | 现在 |
|---|---|---|
| 单次输出 `max_tokens` | 32000 | 128000（网关 48000，网关按它预扣余额）；如果 API 允许的更少，会从报错里读出真实上限并自动降下来 |
| Bash 默认 / 最长超时 | 2 分钟 / 10 分钟 | 10 分钟 / 1 小时 |
| Bash 输出返回给模型的上限 | 30000 字符 | 60000 字符，超出部分的全文保存到文件 |
| 单个工具结果上限（超出落盘） | 50000 字符 | 100000 字符 |
| `Read` 一次最多 | 2000 行、每行 2000 字符、总共 12 万字符 | 10000 行、每行 20000 字符、总共 40 万字符；加 `allow_large: true`（与 Claude Code 2.1.296 相同）不限行数和长度，只要上下文在自动压缩之前还放得下（同一批并行读取共用这份余量），放不下就拒绝并写明差多少 |
| `Glob` / `Grep` 默认返回条数 | 100 / 250 | 1000 / 1000 |
| `WebFetch` | 只返回小模型的摘要（最多 4096 token），自动把 http 升成 https | `raw: true` 直接拿转换后的全文；摘要上限 16000 token、页面上限 40 万字符；按原样请求 URL，localhost 和内网也可以 |
| 子 agent | 不能再派子 agent | 嵌套到 2 层（`CLAUDE_PRO_MAX_SUBAGENT_DEPTH`，0 = 不嵌套） |
| `Bash` 的标准输入 | 一律关闭 | 可以用 `stdin` 参数喂入文本（回答提示、给脚本传数据） |
| 提示词里的限制 | “尽量少输出”“除非必要不要建文件”“不要强推/改 git 配置/amend” | 回答长度按任务需要；需要就建文件（测试、脚本、配置）；用户要求时可以做上述 git 操作 |

**刻意保留的**：`Edit`/`Write` 必须先 `Read`（防止覆盖没看过的改动，这是正确性保护，不是能力限制；`Write` 覆盖已有文件要求读过完整内容，只读了一部分时用 `Edit`；`--resume` 恢复会话时会按记录重建读取状态，读过之后被改动的文件需要重读）、"没被要求就不提交"、做不可撤销且没被要求的外部操作（强推、发布包、给外部服务发消息或花钱）之前先说一声。

## 功能

**工具**（与 Claude Code 同名同语义）：`Bash`（持久 cwd、超时、后台运行、可喂 stdin）、`BashOutput`、`KillShell`、`Read`（行号、图片、ipynb）、`Write`、`Edit`（必须先读后改、检测外部修改、保留 CRLF/BOM）、`NotebookEdit`、`Glob`、`Grep`（有 ripgrep 用 rg，否则用内置 JS 搜索：异步不卡界面，遵循 `.gitignore`/`.ignore`、`!` 排除 glob、`^`/`$` 行锚点、多行匹配、上下文行；找不到 rg 时可用 `CLAUDE_PRO_RIPGREP_PATH` 指定；与 rg 不同的是它始终跳过 `node_modules` 等目录，除非 glob 里点名；模型误传的 `file_path` 当作 `path`，grep 的 `-l`/`-c` 当作输出模式）、`WebFetch`、`WebSearch`（DuckDuckGo/Bing）、`TodoWrite`、`Task`（子 agent）、`TaskOutput`、`TaskStop`、`Skill`、`AskUserQuestion`，以及 MCP 工具。

**交互**
- 流式 Markdown 渲染（代码高亮、表格、中文宽度对齐），思考过程折叠显示（`ctrl+o` 展开）
- `Esc` 中断；忙碌时输入的消息会排队并插入当前任务
- `!` Bash 模式、`#` 写入记忆（CLAUDE.md）、`\`+回车 或 `ctrl+j` 换行、粘贴大段文本折叠为 `[Pasted text #1 +42 lines]`
- **全屏模式（默认，和 Claude Code 的 `/tui fullscreen` 一样）**：程序画在终端的备用屏幕上（像 vim），输入框固定在窗口最底下，不随输出或终端滚动条移动；对话在程序里滚动：鼠标滚轮（每格 `CLAUDE_PRO_SCROLL_SPEED` 行，默认 3）、`PgUp`/`PgDn`（半屏）、`Ctrl+Home`（对话开头）、`Ctrl+End`（回到最新）。往上翻时新输出不会把画面拉回底部，底部浮着 `Jump to bottom (ctrl+End) ↓ · N new lines`，**点它**或按 `Ctrl+End` 回到底部；发消息时自动回到底部。**选中文字直接用鼠标拖**（不用按 Shift），松开就复制到剪贴板；双击选一个词，三击选一整行；拖到对话区上下边缘会跟着滚动。选中的部分反色显示，点一下别处、按 `Esc` 或任意键就消失；有选中时 `Ctrl+C` 是复制（不会中断任务）。**右键**和在终端里一样：有选中时复制，没有时把剪贴板的文字粘贴进输入框（和 `Ctrl+V` 相同）。仍可按住 Shift 拖动用终端自己的选中。退出后终端回到启动前的样子（对话不留在终端滚动记录里）。`/tui default` 切回经典模式（对话写进终端自己的滚动记录，输入框在窗口底部、靠空行顶到底；`CLAUDE_PRO_PIN_INPUT=0` 让它紧跟在输出下面），`/tui fullscreen` 切回全屏，选择会记住（`CLAUDE_PRO_TUI`）
- `ctrl+c` 或连按两次 `Esc` 清掉的草稿不会丢：在空输入框按 `↑` 找回（连同粘贴的文本和图片），中间发过别的消息也可以
- `@文件` 补全并附加内容：走的就是 `Read` 工具，等于模型自己读了这个文件。最多带前 2000 行（被截断时会明确告诉模型，并把该文件记为"只读了一部分"，之后 `Write` 不会去覆盖没给它看过的行）；图片作为图片附加；二进制文件和超过 512KB 的文本会被跳过并提示原因；`@目录` 列出目录内容
- `alt+v` 粘贴剪贴板里的图片（截图用 `Win+Shift+S`），输入框里显示为 `[Image #1]`；超过 1568px 的图会自动缩小，超过 512 KB 的 PNG（3D 画面、照片类截图）改用 JPEG 发送，通常只有原来的 1/10（每次请求都带着整个对话，图片太重会让请求超过 32 MB 的上限）。把图片文件拖进终端（或粘贴图片路径）也会作为图片附加
- 上下文用量接近阈值时自动压缩（`CLAUDE_CODE_AUTO_COMPACT_WINDOW`），也可手动 `/compact`
- 会话自动保存到 `~/.claude-pro/projects/`，`claude-pro -c` 继续上次，`claude-pro -r` 选择历史会话

**`/cd <目录>`**：换工作目录，对话接着进行。目录可以是绝对路径、`~`、相对当前目录的路径；不存在或不是目录时报错（不会创建）。会话在新目录里重启一次（约一秒），新目录的项目设置、CLAUDE.md、记忆、git 状态、`@` 文件补全、输入历史都换成新目录的；对话、模型、effort、待办、网页上的远程会话（同一个链接）不变。会话记录跟着搬到新目录下，在新目录里 `/resume` 能找到。用 `/rename` 或 `--name` 起过的名字保留，默认按目录取的名字换成新目录名。任务进行中不能切换。

**斜杠命令**：`/help` `/tui` `/cd` `/rename` `/peers` `/sendfile` `/clear` `/compact` `/config` `/model` `/effort` `/status` `/cost` `/context` `/init` `/review` `/memory` `/verify` `/tasks` `/rewind` `/skills` `/resume` `/todos` `/agents` `/mcp` `/bashes` `/verbose` `/export` `/doctor` `/exit`，以及 `.claude/commands/*.md`、`.claude-pro/commands/*.md`、`~/.claude-pro/commands/*.md` 中的自定义命令（支持 `$ARGUMENTS`、`$1`、`` !`cmd` ``）。

**记忆**：自动读取 `~/.claude-pro/CLAUDE.md`、项目各级目录的 `CLAUDE.md` / `.claude/CLAUDE.md` / `CLAUDE.local.md`；某一级目录没有 `CLAUDE.md` 时读它的 `AGENTS.md` 代替（与 Claude Code 相同，两者都有时通常是同一份说明，不重复发送）。

**自动记忆（跨会话）**：每个项目有一个由 agent 自己维护的记忆目录 `~/.claude-pro/projects/<项目>/memory/`。它会把你的偏好、纠正过的做法、项目约束等写成一条条小文件，并在 `MEMORY.md` 里建索引；每次新会话开始时索引自动载入。直接说"记住……"或"忘掉……"即可；`/memory` 查看；`CLAUDE_PRO_DISABLE_AUTO_MEMORY=1` 关闭。

**Skills**：`<目录>/skills/<名字>/SKILL.md`，frontmatter 写 `name` 和 `description`，正文是指令，格式与 Claude Code 的 skills 相同。搜索 `~/.claude-pro/skills/`、`<项目>/.claude/skills/`、`<项目>/.claude-pro/skills/`（项目级覆盖用户级）。模型发现任务匹配某个 skill 的描述时会通过 `Skill` 工具自动加载它；你也可以直接用 `/<skill 名> [参数]` 调用，`/skills` 列出全部。

**子 agent**：内置 `general-purpose`、`Explore`、`Plan`；自定义 agent 放在 `.claude/agents/*.md` 或 `~/.claude-pro/agents/*.md`（frontmatter：`name`、`description`、`tools`、`model`、`effort`（low/medium/high/xhigh/max）、`autoCompactWindow`（这个 agent 自己的自动压缩窗口，token 数））。模型调用 `Task` 时也可以给单个子 agent 指定 `model`（sonnet/opus/haiku 或完整 id）和 `effort`，优先于 agent 定义里的，定义里的又优先于会话的。

**后台子 agent**：模型可以用 `Task` 的 `run_in_background: true` 把子 agent 放到后台，自己继续干别的。子 agent 完成后，结果会作为 `<task-notification>` 自动送回；如果当时主 agent 空闲，会自动开启新的一轮来处理结果。`TaskOutput` 用于提前等待结果，`TaskStop` 用于取消；`/tasks` 列出所有后台 agent，`/tasks kill agent_1` 停止其中一个。`-p` 模式会等所有后台 agent 结束后再退出。

**自动验证循环**：设置一条验证命令（`--verify "npm test"`、会话中 `/verify npm test`，或 `CLAUDE_PRO_VERIFY_COMMAND`）后，只要某一轮改过文件，模型结束前就会自动运行这条命令。失败的输出会发回给模型继续修复，直到通过，最多 `CLAUDE_PRO_VERIFY_MAX_ROUNDS` 轮（默认 3）。没有改文件的轮次不会触发验证。

**大输出落盘**：工具结果超过 `CLAUDE_PRO_MAX_TOOL_RESULT_CHARS`（默认 50000 字符）时，全文会保存到 `~/.claude-pro/projects/<项目>/tool-results/`，只把预览和文件路径发给模型，模型可以再用 `Read`/`Grep` 按需查看。Bash 输出被截断时同样会保存全文。超过 7 天的旧文件在启动时自动清理。

**Hooks**：`settings.json` 里的 `hooks` 与 Claude Code 同形：`PreToolUse`、`PostToolUse`、`UserPromptSubmit`、`Stop`。事件内容以 JSON 从 **stdin** 传给脚本（同时放在环境变量 `CLAUDE_PRO_HOOK_INPUT`，另有 `CLAUDE_PROJECT_DIR`）；退出码 0 = 通过（stdout 作为附加上下文），2 = 拦截（stderr 反馈给模型；`Stop` 则让模型继续干活），其他 = 仅警告。当护栏用的 hook 加上 `"onFailure": "block"`：启动不了、超时或以其他退出码结束时按拦截处理，而不是放行（与 Claude Code 相同）。hook 输出里的 `<system-reminder>` 标签会被转义，冒充不了系统提示。

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
claude-pro -p "只调研，给出重构方案，不要改文件"     # 只出方案：在消息里说就行
```

## 快捷键

| 按键 | 作用 |
|---|---|
| `Enter` | 发送 |
| `\` + `Enter` / `ctrl+j` / `alt+enter` | 换行 |
| `Esc` | 中断当前任务；连按两次：有文字时清空输入，输入框为空时打开回退菜单（同 `/rewind`） |
| `ctrl+c` | 中断 / 清空输入 / 连按两次退出 |
| `ctrl+o` | 切换详细输出（思考过程、完整工具输出） |
| `ctrl+t` | 显示/隐藏 todo 列表 |
| `ctrl+l` | 清屏重绘 |
| `alt+v` | 粘贴剪贴板图片 |
| `PgUp` / `PgDn`、滚轮、`Ctrl+Home` / `Ctrl+End` | 全屏模式下滚动对话 / 到开头 / 回到最新 |
| `ctrl+f` | 全屏模式下在对话里查找（像 VS Code）：输入框的位置换成查找框，边输入边高亮所有匹配（不分大小写，当前这个橙色、其余黄色），右上角显示"第几个/共几个"（`No results` 表示没有）。先跳到视图底部往上最近的一个；`Enter` 或 `↑` 跳到更早的一个，`Shift+Enter` 或 `↓` 跳到更新的一个，到头后绕回；`PgUp`/`PgDn`、滚轮照常滚动；`Esc` 关闭，画面停在当前位置（`Ctrl+End` 回到底部）。再按 `ctrl+f` 会带上上次的关键字（已选中，直接输入就替换）；先用鼠标选中文字再按，会搜选中的文字。查找时有新输出，匹配会跟着更新。经典模式（`/tui default`）的对话在终端自己的滚动缓冲里，请用终端自带的查找 |
| `↑` / `↓` | 在多行输入（包括自动折行的长文字）里上下移动光标；光标在第一行时 `↑` 先移到开头、再按才翻到上一条历史消息，`↓` 在最后一行同理 |
| `Tab` | 补全命令 / 文件 |

## 开发

GitHub Actions（`.github/workflows/test.yml`）在 Ubuntu、macOS、Windows 上用 Node 22 和 24 跑 `npm run check` 和 `npm test`。

```bash
npm test                     # 单元测试（node:test）
```

`test/tui-harness.js` 可以在无头 xterm 中驱动真实的交互界面（发送按键、截取屏幕），用于测试 UI。限流相关的测试把 `src/ratelimit.js` 的 `timing`（时钟和休眠）换成可控的假时钟，几小时的暂停在测试里瞬间走完；`test/e2e.test.js` 则启动真正的命令行进程对接假 API 服务器。

```
bin/claude-pro.js     入口；交互式会话在这里交给监督进程
src/supervisor.js     监督进程：子进程以退出码 75 请求重启时重新启动它，只用 Node 内置模块
src/restart.js        重启的程序侧：交接的状态、启动检查（runSelfCheck）、监视源码、重启提示
src/selfcheck.js      `--self-check`：在假终端里把整个程序启动一遍并检查工具/系统提示词
src/tools/restart.js  Restart 工具
src/main.js           参数解析、config 子命令
src/config.js         配置加载（.env / settings.json / 环境变量）与模型解析
src/api.js            后端路由、Anthropic SDK 封装：流式、重试、effort/thinking 参数
src/ratelimit.js      限流：解析重置时间响应头、决定等多久、墙上时钟休眠、提示文案
src/claude-code.js    读取现有 Claude Code OAuth 登录态，生成认证头和账号 metadata
src/oauth.js          访问令牌过期时用刷新令牌续期，加锁、原子写回凭据文件
src/agent.js          Agent 循环：工具调度、并行只读工具、中断、自动压缩、验证循环
src/checkpoints.js    检查点与 /rewind
src/filestate.js      恢复会话时从记录重建"已读文件"状态（文件自读取后没变过才信任）
src/hooks.js          Hooks 运行器
src/tasks.js          后台子 agent 注册表与完成通知
src/prompts.js        系统提示词、压缩提示词、自动记忆提示
src/tools/*           各工具实现（含 Skill、NotebookEdit）
src/mcp.js            MCP 客户端（stdio / HTTP）
src/ui/*              终端 UI：屏幕管理、输入框、对话框、Markdown 渲染
src/remote.js         远程控制：经网关中转的客户端、对话事件模型（applyEvent，网关页面里有同一份）
src/qr.js             终端二维码（字节模式、纠错 L、版本 1–6）
src/commands.js       斜杠命令
```

## 与 Claude Code 的差异

没有：权限系统（刻意去掉）、IDE 集成、`/login` 等账号功能、插件市场。检查点只覆盖文件工具的修改，不覆盖 Bash 命令造成的改动。WebSearch 通过抓取 DuckDuckGo/Bing 实现（DeepSeek 没有服务端搜索工具）。

提示：选中文字自动复制是终端的功能。Windows Terminal 在设置里打开“选择时自动复制”（settings.json 里的 `"copyOnSelect": true`）即可。

## 历史

这个仓库依次是：自己实现的 agent（旧名 ccc，最后一版保存在 git 标签 `ccc-last`）→ 官方 `claude` 的启动器（提交 `e041b0f`）→ 现在这个版本（自己实现的 agent，去掉权限系统，加入检查点和 Skills）。
