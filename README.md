# claude-pro — 完全访问的命令行编程 Agent

`claude-pro` 是一个**自己实现**的终端 AI 编程助手，**支持多家模型厂商**：用 `/connect` 接上 Anthropic、OpenAI、DeepSeek、Kimi、智谱、通义、OpenRouter、7bit.fun 网关或你自己的接口，各用各的 Key，可以同时连接多家、随时切换模型。7bit.fun 只是其中一家，额外提供余额、远程网页控制和跨电脑会话。

最大的特点：**没有任何权限确认**。Bash 命令、文件读写、联网、MCP 工具，模型要用就直接执行，不弹窗、不问、没有 allow/deny 规则。它面向你自己的测试机器，目的是让模型的能力不被打断地发挥出来。作为补偿，每次文件修改都会做检查点，`/rewind` 可以撤销。

```
> 给 math.js 加一个 multiply 函数并补上测试
⏺ Read(math.js)
  ⎿  Read 4 lines

⏺ Edit(math.js)
  ⎿  Updated with 4 additions and 1 removal
⏺ Bash(node test.js)
  ⎿  PASS
```

> **认证**：`/connect` 里粘贴各家的 API Key。7bit.fun 的 Key 保存在 `~/.claude-pro/gateway.json`，其他厂商的保存在 `~/.claude-pro/providers.json`。跨电脑互发任务和通讯录只在连接了 7bit.fun 时才有。

## 安装与运行

需要 Node.js 22+。Windows 上 Bash 工具使用 Git Bash，会自动查找，也可以用 `CLAUDE_CODE_GIT_BASH_PATH` 指定。

从 npm 安装（推荐）：

```bash
npm install -g @yanzc/claude-pro
claude-pro                 # 在任意项目目录里运行
```

更新是手动触发的：npm 全局安装的版本运行 `/update` 后才检查 npm，并在会话空闲时安装新版；安装由单个会话加锁，完成后通过重启加载新版本并保留对话。源码仓库副本不会被 `/update` 改写。

从源码运行：

```bash
git clone https://github.com/yanzaocheng/copy-claude-code.git
cd copy-claude-code
npm install
node bin/claude-pro.js     # 直接运行
npm link                   # 注册全局命令 claude-pro，之后在任意项目目录里输入 claude-pro
```

> 在 Git Bash 自带的 mintty 窗口里交互模式需要 `winpty claude-pro`；推荐在 Windows Terminal / PowerShell / cmd 中运行。

## 登录与供应商

交互式启动时，如果还没有连接任何厂商，会自动打开 `/connect`；也可以手动运行：

```powershell
claude-pro /connect
claude-pro
claude-pro --model opus
claude-pro -p "用 Read 工具读取 package.json，告诉我项目版本"
```

网关的 key 保存在 `~/.claude-pro/gateway.json`（Windows 对应 `%USERPROFILE%\.claude-pro\gateway.json`），不会读取 Claude CLI 或 Codex CLI 的登录文件。

## 7bit.fun 网关

先登录 https://7bit.fun/user ，在「API 密钥」点「创建新密钥」，然后在 claude-pro 里运行 `/connect`，选第一项 **7bit.fun**，粘贴 Key。输入时只显示星号和长度；Key 先用 `GET /v1/account` 验证，通过后才保存，并显示账户名和余额。被拒绝时会显示网关的原话，可以再粘贴一次。已经连接时再选 7bit.fun，回车保留原来的 Key，或者粘贴新的替换。`/disconnect 7bit.fun` 忘掉网关 Key，这台电脑的会话随之从网关下线。

2026-11-19 起没有 `/login`、`/logout` 命令，也不再用浏览器跳转授权（网关的 `/cli/login` 已停用）。之前保存的 Key 照常可用，不需要重新连接。

## /connect：选择供应商

和 OpenCode 的 `/connect` 一样：从列表里选一家，粘贴它的 API Key，就能用它的模型。**可以同时连接多家**，它们的模型都列在 `/model` 里，名字一律是 `厂商/模型`（如 `7bit/claude-opus-5-5`、`deepseek/deepseek-v4-pro`、`openrouter/anthropic/claude-sonnet-4.5`），随时切换。没连接的厂商不会出现在 `/model` 里。

- **默认模型跟随已连接的厂商**：设置里没有指定 `model` 时，连了提供 Claude 的厂商（7bit.fun 或 Anthropic）就用 `opus`，否则用第一个连接的厂商在 `/connect` 时选的模型。只连了 DeepSeek 的用户，启动后直接就是 DeepSeek 的模型。
- **`opus`、`sonnet`、`haiku` 是别名**：指向已连接的 Claude 厂商，两家都连了按 `/connect` 列表顺序取 7bit.fun；`7bit/opus` 固定指 7bit.fun 的。
- **兼容旧写法**：不带前缀的名字（`claude-opus-5-5`、`gpt-6.2-sol`）按 7bit.fun 的模型处理，旧设置和记住的选择照常可用。
- **断开时自动换模型**：`/disconnect` 了正在用的厂商，会换到仍连接着的厂商的默认模型。

| 供应商 | 协议 | 地址 |
|---|---|---|
| 7bit.fun | 网关 | 余额、远程网页、跨电脑会话都靠它 |
| Anthropic (Claude) | Anthropic | api.anthropic.com |
| OpenAI | OpenAI | api.openai.com/v1 |
| DeepSeek | Anthropic | api.deepseek.com/anthropic |
| Kimi (Moonshot) | Anthropic | api.moonshot.cn/anthropic |
| 智谱 GLM | Anthropic | open.bigmodel.cn/api/anthropic |
| MiniMax | Anthropic | api.minimaxi.com/anthropic |
| 通义千问（阿里云百炼） | Anthropic | dashscope.aliyuncs.com/apps/anthropic |
| OpenRouter | OpenAI | openrouter.ai/api/v1 |
| 硅基流动 | OpenAI | api.siliconflow.cn/v1 |
| 火山方舟 | OpenAI | ark.cn-beijing.volces.com/api/v3 |
| Google Gemini | OpenAI | generativelanguage.googleapis.com/v1beta/openai |
| xAI (Grok) | OpenAI | api.x.ai/v1 |
| Ollama（本机） | OpenAI | localhost:11434/v1，不需要 Key |
| 你自己的（Anthropic 兼容 / OpenAI 兼容） | 任选 | 自己填名字和地址：中转站、LM Studio、vLLM…… |

同时有两种接口的供应商优先走 Anthropic 协议：思考过程、工具调用、图片都是原生的。OpenAI 协议由 claude-pro 在本地转换（`src/openai-chat.js`，移植自 codex-gateway）：工具调用、图片、用量、`reasoning_content` 思考过程、推理强度（`/effort` → `reasoning_effort`）都会转换；提示词缓存标记和 Anthropic 的服务端工具不会发过去（WebSearch 会退回到抓取搜索页）。

连接时的步骤：粘贴 Key（只显示星号）→ 用 Key 请求它的模型列表（自动识别 Key 放在 `x-api-key` 还是 `Authorization: Bearer`；被拒绝可以重新粘贴）→ 从列表里选要用的模型（或“继续用当前模型”）→ 给这个模型发一个很小的请求，确认协议、Key 和模型都对，才保存。模型的上下文窗口、输出上限和价格取自 [models.dev](https://models.dev)（OpenCode 用的模型目录，缓存一天），没有收录的模型按 200k 窗口算、不计价。

Key 保存在 `~/.claude-pro/providers.json`（只有你自己能读）。`/disconnect [供应商]` 忘掉它的 Key；正在用它的模型时会回到默认模型。余额、远程网页和跨电脑会话只跟 7bit.fun 的登录有关，和当前用哪家的模型无关。一段对话中途换到另一家的模型时，上一家的思考过程不会发给下一家（它无法验证别家的签名），换回去时又会带上。

```text
/connect            供应商列表（已连接的打 ✔）
/connect deepseek   直接连接某一家
/model deepseek/deepseek-v4-pro
/disconnect deepseek
```

网关地址默认是 `https://7bit.fun`，也可以通过 `CLAUDE_PRO_GATEWAY_URL` 修改。旧地址 `https://gw.predix.icu` 是同一个网关：用它保存的登录和设置会自动按 7bit.fun 读取，不需要重新登录。账户余额和用量在网关用户页查看。

## 配置

各家的 key 只来自 `/connect`（7bit.fun 的在 `~/.claude-pro/gateway.json`，其他厂商的在 `~/.claude-pro/providers.json`），没有环境变量或 `.env` 文件可以设置它们。

一般只需要 `/connect`、`/model`、`/effort` 和 settings。五个普通设置直接写在 `settings.json` 顶层（下面也是默认值；`model` 不写时跟随已连接的厂商，见上面的 `/connect`）：

```json
{
  "model": "opus",
  "effort": "auto",
  "promptCacheTtl": "1h",
  "subagentPromptCacheTtl": "5m",
  "cleanupPeriodDays": 30
}
```

`cleanupPeriodDays` 和 Claude Code 的同名设置一样：会话最后一次使用超过这么多天就删除（连同它的 trace，此后 `/resume` 里也看不到），每次启动后在后台清理所有项目，一台机器一小时最多一次；保存的大块工具输出最多留 7 天、`/rewind` 快照最多 14 天，项目记忆从不删。最小 1，想长期保留就设 `3650` 之类的大数。这一项只从 `~/.claude-pro/settings.json` 读，项目里的设置文件改不了它。

也可以用命令修改：

```bash
claude-pro config list                       # 普通设置，含默认值
claude-pro config set model sonnet
claude-pro config set promptCacheTtl 1h
claude-pro config list --advanced            # 另外显示高级配置
claude-pro config set CLAUDE_PRO_GATEWAY_URL https://7bit.fun
```

会话中 `/config` 默认只显示这五项，`/config advanced` 查看高级项；`/config set model sonnet` 等同于 CLI 的 `config set`。普通设置写顶层，高级设置写 `env`。`/config set/unset` 保留 `--project`、`--local`，分别修改项目共享设置或本地设置。`/model`、`/effort` 仍会记住选择；`--model`、`--effort` 可覆盖本次启动。

设置文件从低到高：`~/.claude-pro/settings.json`、项目 `.claude-pro/settings.json`、`.claude-pro/settings.local.json`。高级项仍兼容进程环境变量（高于设置文件），包括网关地址、是否连网关、输出/thinking 预算、缓存总开关、保活、网络重试、工具路径、验证、自动记忆/话题标题和 Trace 开关；普通设置不从进程环境读取。旧 `settings.json.env` 中的 `CLAUDE_PRO_GATEWAY_MODEL`、`CLAUDE_CODE_EFFORT_LEVEL`、`CLAUDE_CODE_PROMPT_CACHE_TTL`、`CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` 只作为兼容别名读取，同文件顶层新字段优先；用 `config set` 或 `/config set` 设置旧别名，会改写顶层新字段并移除同文件旧别名。没有 `--provider` 或 `CLAUDE_PRO_PROVIDER` 配置：用哪家由模型名决定（`/model`、`--model deepseek/deepseek-v4-pro`、设置 `model`）。

## 系统提示词

默认使用内置的系统提示词。只想改这一次启动时，用启动参数（和官方 Claude Code 一样）：`--append-system-prompt "..."` 在默认提示词后面追加，`--system-prompt "..."` 或 `--system-prompt-file 文件` 整个替换（工具说明也会一起换掉）。长期的规则写进 CLAUDE.md 或记忆（消息以 `#` 开头）。

## 提示词缓存：自动的，尽量少花钱

每次请求都要把整个对话发给模型，用 Anthropic 的提示词缓存，重复的历史按缓存价（十分之一）计费，不用配置：

- 网关对话默认用 1 小时缓存（停顿一会儿回来不用整段重写）；子 agent、压缩等默认用 5 分钟。顶层 `promptCacheTtl`、`subagentPromptCacheTtl` 修改时长；`DISABLE_PROMPT_CACHING` 总开关见 `claude-pro config list --advanced`。旧的强制 5 分钟、启用 1 小时和按模型关闭缓存的变量不再生效。
- `/cost` 显示缓存还能保留多久、命中率和没命中的原因；缓存过期后发下一条消息会把整个对话重新写入缓存。
- 缓存还热时 `/model`、`/effort` 会先确认（切换会让缓存失效）；离开一个多小时回来时，清掉较早的工具结果，少重写一些。
- 人不在时自动保温（Claude 模型）：缓存到期前 5 分钟把上一个请求重发一次，只要 1 个输出 token。读缓存会让它再保留一小时，花费是整段重写的 1/40（Opus 上 15 万 token 的对话：约 $0.03，重写约 $1.20）。一次停顿最多保温 8 小时，`CLAUDE_PRO_CACHE_KEEPALIVE_HOURS` 可以改（0 关闭）。`/cost` 显示刷新次数和花费。GPT 模型不需要：网关上的 GPT 缓存停顿几个小时后通常还在。

（缓存标记放在哪、端点不认时怎么退、压缩如何复用缓存等细节见 ARCHITECTURE.md 6.5。）

## 运行时 Trace：用真实数据优化模型和工具

默认在每个会话写入独立的隐私保护 JSONL：`~/.claude-pro/projects/<项目>/traces/<session-id>.jsonl`。Trace 只保存 turn/request/tool/compaction/verification 的计数、耗时、token 数、缓存 fingerprint 和参数结构，不保存 API key、cookie、token、密码、完整 prompt、工具输入或工具输出。大输出只记录大小和是否落盘；单个文件固定 20 MiB，超出后轮换为 `.1`；30 天没再写入的 trace 在启动时清理。

```text
/trace       # 当前会话的请求、工具、缓存、压缩和验证汇总
/trace 20    # 另外显示最近 20 条结构化事件
```

可用高级配置：`CLAUDE_PRO_TRACE=0` 关闭。目录固定为上述项目 Trace 目录，旧 `CLAUDE_PRO_TRACE_DIR`、`CLAUDE_PRO_TRACE_MAX_SIZE` 不再生效。`/cost` 也会显示轻量工具成功率和验证次数。Trace 是 best-effort，写入失败不会影响 Agent 主循环。

## 限流：自动暂停，到点自动恢复

网关账户的 5 小时和每周限额用完时，不报错停下，而是暂停并显示倒计时（`✻ 5-hour limit reached · resumes at 23:41 (in 2h 13m)`，Esc 可取消），到重置时间重发同一个请求，任务接着做完。暂停期间可以直接输入 `/model <另一个模型>`（暂停时唯一能在任务进行中执行的命令）：暂停立即结束，这个请求改发给新模型，不用先按 Esc 再说"继续"。暂停超过一小时、提示词缓存已过期时，重发前会先清掉旧的工具结果和旧工具调用里的大段文本（和离开一小时后回来时一样），避免把整段对话原样重写进缓存。网关过载（529）同样先重试、再暂停等它恢复。最多等 6 小时（`CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS`，`0` = 不等直接报错）；重置时间更远（比如周限额还有几天）时直接报错，并写明几点重置。

## 终端标题、状态行与窗口缩放

- **终端标题**：标签/窗口标题显示 `✳ <会话标题> | <目录> · <模型> · <effort>`（会话标题是**当前话题**：每次发消息后，后台让小模型（haiku）判断是否换了话题，换了就生成一个简短标题；"继续"之类的消息不会改标题。话题记在会话文件里，`/resume`、重启后仍在，`/resume` 列表也显示它。旧会话没有话题时，恢复时按最近一条提问生成。还没生成时显示第一条提问。最多 40 字，保证模型和 effort 不被窄标签截掉。`CLAUDE_PRO_DISABLE_TOPIC_TITLE=1` 关闭，省掉每条消息一次的小请求）。忙碌时前缀在 `⠂`/`⠐` 之间闪动，限流暂停时变 `⏸`，退出时恢复进入前的标题。`/model`、`/effort`、`/clear`、`/resume` 后自动更新。**VS Code**(1.140 起)只对它认得的 AI 命令行(claude/codex/copilot/gemini)把程序设置的标题显示在标签上(`terminal.integrated.tabs.allowAgentCliTitle`,默认开),其余一律显示进程名 `node`;它在 Windows 上靠 `node.exe` 命令行里的 `\claude-code\` 路径段识别它,所以监督进程用 `bin\claude-code\..\claude-pro.js` 启动会话(目录不必存在,Node 自己化简 `..`)。不经过监督进程的启动方式(`CLAUDE_PRO_NO_SUPERVISOR=1`)或 Linux/macOS 上,要在 VS Code 设置里把 `terminal.integrated.tabs.title` 改成 `${sequence}` 才能看到标题。
- **用户的提问**：带一条深灰色背景（横跨整个窗口宽度），和回复一眼就能分开。背景条是用当前背景色清除行尾（`\x1b[K`）画出来的，不靠补空格，窗口变宽变窄都正好铺满。
- **状态行**：终端没有常驻页脚。每次回答结束后打印一行 `✻ Done at 14:05 · worked 1m 3s · $0.12 (total $3.40) · ctx 45k/1M · opus-5-5 max`：完成时间、这一轮用时、这一轮的花费（括号里是对话累计）、上下文用量、模型和 effort。花费按官方价（和网关扣费同一张价目表，含 5 分钟/1 小时缓存写入、长上下文价）把每个请求算进去，子 agent、压缩、话题标题、WebFetch 都算，按 Esc 中断的请求按已读入的输入和估算的已输出部分算；记在会话文件里，重启、`/resume` 后接着累计，`/clear` 从零开始。`/cost` 第一行也显示它，`-p --output-format json` 的结果带本次运行的 `total_cost_usd`。不认识价格的模型（第三方端点的自定义模型）不计；网关上游分组倍率不是 1 的账户以网关流水为准。输入行下面只在需要马上知道时出现一行提示（再按一次 Ctrl-C 退出、本轮结束后重启、正在更新）。
- **缩放窗口**：拖动期间不重绘，停下约 80ms 后从左上角整屏绝对重绘一次，输入框不会再留下残影。注意：很短的会话里这次重绘会覆盖终端上方 shell 的内容。

## 自动重启：改了自己的代码马上生效

交互式会话运行在一个很薄的**监督进程**（`src/supervisor.js`，只用 Node 内置模块）之下，所以程序可以自己重启、加载自己刚改过的代码，不需要你退出再启动：

- **模型自己重启**：改完 `src/`、`bin/` 里的代码后，模型调用 `Restart` 工具。它先在一个临时进程里把新代码完整启动一遍（所有模块能加载、界面能画出来、工具定义和系统提示词合法）——**启动不起来就不重启**，把错误还给模型去修，修好再调用；通过后在**本回合结束时**重启，对话、待办列表、`/model`、`/effort`、排队的消息、输入框里没发出去的草稿、`/rewind` 检查点都带过去，新进程里模型收到一条"已重启"的提示后接着做（可用 `then` 指定重启后先验证什么）。只在**源码仓库**（有 `.git` 的克隆，包括 `npm link` 到它）里这样做：从 npm 装的副本没有版本控制、下次更新会被覆盖，那里不给模型 `Restart` 工具，系统提示词改成"不要改自己的文件，绕过问题并在最后说明缺陷，方便用户反馈"。
- **改了源码自动重启**：`src/`、`bin/` 下的文件变过，就自动做同样的检查并重启。本会话的回合进行中发生的改动（多半是它自己改的）在回合结束时加载；会话空闲时看到的改动是别处做的（另一个会话在改程序、编辑器），要等源码连续 3 分钟没有再变才加载，输入行下面会提示，急用可以 `/restart`——否则一个会话每改一步，其余打开的会话都跟着检查、重启一次，加载的还是改到一半的代码。npm 装好的新版本是完整的，不用等。检查不通过只提示错误、不重启。按 Esc 打断的那一回合不会触发。源码自动重启固定开启，旧 `CLAUDE_PRO_AUTO_RESTART` 不再生效。
- **手动**：`/restart`（别名 `/reload`），`/restart force` 跳过检查并无视后台任务。
- 后台 agent / 后台 shell 会被重启杀掉，所以有它们在跑时拒绝重启（可 `force`）。5 分钟内重启超过 5 次视为死循环，拒绝。
- 重启之间终端保持原样（不退回 shell 提示符，原始模式不关），重启时敲的键不会丢；标签标题也不闪。
- 需要真正退出再启动的只有两种情况：改了 `bin/claude-pro.js` 或 `src/supervisor.js`（运行中的监督进程是旧代码）；以及新代码启动不起来而你想强行重启。`-p`、管道、`config` 子命令不经过监督进程；`CLAUDE_PRO_NO_SUPERVISOR=1` 也可以关掉它（环境变量，不是配置项）。
- `claude-pro --self-check` 可以单独运行那个启动检查。

## 本机 Web 控制台：claude-pro web

在会话里输入 `/web`，或在终端运行 `claude-pro web`（`--no-open` 只启动不打开浏览器），会在浏览器里打开 `http://127.0.0.1:7878`（端口被占用时换一个随机端口）。它和终端用的是同一份配置和数据，改动对新会话生效。

- **布局**：和 DeepSeek Harness 一样左右分栏。左边是「工作区」：按项目（目录）分组列出所有会话，运行中的带状态点（绿色空闲、黄色工作中、红色在等你回答），鼠标停留显示目录、时间和状态，可以搜索和折叠；右边是选中的会话。
- **新会话（后台会话）**：选一个目录、写第一条消息（可以带图片），会话马上启动，自动打开并发出这条消息。没在运行的会话，在它的输入框里发消息就会在后台接着运行。后台会话只在控制台里看和操作：⋯ 菜单里「结束会话」（正在工作时会先停止任务，对话会保存），「改到终端窗口里」（结束后台运行，在终端标签里接着这个对话）。这样终端窗口都可以关掉，只用控制台（本机或远程访问）。
  - **都在控制台的进程里运行**（和 DeepSeek Harness 一样）：后台会话不再各开一个 claude-pro 进程和监督进程，每个会话省下 100 MB 以上（实测 8 个会话加控制台共约 75 MB），启动只要约 0.1 秒。每个会话的后台命令、REPL 解释器、浏览器标签互相分开，`/bashes` 只列自己的。
  - **加载新代码时一起重启**：源码改了、`/update` 装了新版本、模型调用 Restart、或用了 `/restart`，控制台等所有后台会话都空闲了（没有在回答、没有待回答的提问、没有在跑的后台命令或后台 agent），再整体换成新进程，每个会话接着原来的对话、编号不变，打开的网页自动接上。要求重启的会话会收到提示，说明在等哪些会话。`/cd` 不需要新代码，只重启那一个会话。
  - **自动恢复**：正在运行的后台会话记在 `~/.claude-pro/web-running.json`。控制台进程意外退出（崩溃、被结束）后，下次启动时（`claude-pro web`、`/web`，或开着远程访问的会话启动时）把它们全部恢复。控制台只在没有后台会话、没有打开的网页、没开远程访问 30 分钟后才退出。出错记录在 `~/.claude-pro/web-errors.log`。
- **会话**：运行中的会话实时显示，底部输入框可以发消息、粘贴/拖入/添加图片、停止当前任务、切换模型和推理强度；没在运行的会话显示完整记录，可以「在终端中继续」。
- **概览**：版本和更新、安装位置、默认模型、7bit.fun 余额、运行中的会话数、会话记录占用的空间。
- **全部会话**（在「更多」里）：所有项目的对话记录表格，可以搜索（会话名、第一句话、id、目录）、按项目筛选、按时间/大小/花费排序。点开看完整对话（Markdown、工具调用、思考过程、图片），可以改名、导出 Markdown、删除（先进回收站，保留 7 天，可恢复），或「在终端中继续」（打开一个 Windows Terminal 新标签，在原目录里 `claude-pro --resume <id>`）。
- 运行中的会话在网页上还可以回答它弹出的问题、看工具调用的完整输出；结束、重启和更新只能在终端里做。
- **模型与供应商**：连接/断开 7bit.fun 和各家供应商（粘贴 Key → 列出模型 → 测试 → 保存，和 /connect 一样），添加自定义的 OpenAI/Anthropic 兼容接口，设置默认模型和推理强度。Key 只显示开头和结尾。
- **设置**：所有普通和高级设置，中文说明、当前生效的值和它来自哪一层，可以写到用户、项目或项目本地的设置文件，或恢复默认。
- **记忆与指令**：全局和各项目的 CLAUDE.md、自动记忆，查看、编辑、删除（删除的文件移到 `~/.claude-pro/trash/files`）。
- **扩展**：技能、子 agent、自定义命令（查看、编辑、新建）、MCP 服务器（添加、修改、删除；环境变量和请求头的值不显示）、hooks。
- **用量**：近 7/30/90 天按天、模型、项目统计的请求数、tokens 和按价格估算的花费（来自运行 Trace），以及花费最多的会话。

服务是整台电脑共用的一个后台进程，没有页面打开 30 分钟后自动退出，下次 `/web` 再启动；claude-pro 更新（或源码改动）后会自动换成新版本。只监听 127.0.0.1，只接受以 127.0.0.1/localhost 访问的请求，修改类请求必须来自控制台自己的页面；第一次用 `/web` 打开时地址里带一个令牌，之后换成 cookie（令牌在 `~/.claude-pro/web.json`，只有你能读）。控制台不能打开 `gateway.json`、`providers.json` 这类存 Key 的文件，也不能打开会话记录以外的任意文件。

## 远程访问：在手机上用这台电脑的控制台

在会话里运行 `/web remote on`（第一次会让你设一个至少 10 位的密码），控制台就能在 **`https://<你的通讯号>.7bit.fun`** 打开：手机或别的电脑上打开这个地址，输入密码，就能看会话、发任务（可以带图片）、回答问题、改设置，和在本机打开 `/web` 一样。通讯号在网关网页「通讯录」里改（只能用小写字母、数字和 `-`），比如改成 `yanzc` 就是 `https://yanzc.7bit.fun`。

- **怎么连的**：本机控制台的后台服务主动连一条 WebSocket 到 7bit.fun 网关（用 `/connect` 保存的 Key），网关把这个域名的请求从这条连接转给它。电脑不开任何端口，转过来的请求只能到控制台本身。
- **密码只在本机校验**：`~/.claude-pro/web-remote.json` 里只存 scrypt 哈希，网关不知道密码。登录页可以选「记住这台设备 30 天」，不勾就只保持 1 天。同一个 IP 连续输错 5 次锁 15 分钟，一小时内总共错 20 次就锁到这个小时结束。每次登录（成功或失败）都有记录。
- **管理**：`/web remote` 看状态和地址，`/web remote password` 改密码（所有设备退出），`/web remote logout` 让所有设备退出，`/web remote off` 关闭。控制台左边「远程访问」页面也能做这些，并列出登录着的设备和最近的登录。
- **保持在线**：开启后控制台服务不再空闲退出；电脑休眠、关机时打不开，claude-pro 的任何会话启动时会把它重新接上。
- **多台电脑**：同一个账号的几台电脑都开了远程访问时，打开地址先让你选电脑（记在 cookie 里），控制台左下角有「切换电脑」。
- **安全**：能登录就等于能在这台电脑上执行命令，密码要够强；从外网打开时控制台不接受 `/web` 的本机令牌，修改类请求必须来自这个域名的页面。

## 会话之间互发任务（本机和其他电脑）

每个交互会话都有一个名字（默认是目录名，`/rename` 不带参数时显示），别的会话可以给它发任务，它做完后回答自动发回来。

- **本机**：同一台电脑上开着的会话直接互通（经 127.0.0.1，不经过网络）。
- **其他电脑**：同一个网关账户下在线的会话经网关互通。例如公司电脑上开着 claude-pro，在家里输入 `@公司 跑一下测试`，任务送到公司那台的会话，回答自动显示在家里这边。电脑名默认是主机名，用 `CLAUDE_PRO_MACHINE_NAME=公司` 改成好记的名字（支持中文）。
- **输入 `@` 后按 Tab** 列出文件和会话的混合补全（本机的和其他电脑在线的会话都会列出），选文件可引用它，选会话再写任务回车即可：
  - `@文件路径`：引用文件；带空格的路径使用 `@"文件路径"`；
  - `@名字 任务`：向本机或远程会话发送任务；
  - `@电脑名/名字 任务`：向其他电脑上的指定会话发送任务；那台电脑只开着一个会话时直接 `@电脑名 任务`。
  - 文件和会话同名时，行首 `@名字 任务` 按会话处理；要强制引用文件可写 `@./名字`。
- **`@` 可以写在句子中间**：在空格后面打 `@` 再按 Tab 也会列出文件和会话；在发给当前 agent 的消息里提到 `@名字`，agent 会被告知那是哪个会话、怎么联系它。文件引用仍会展开为文件内容。输入法打出全角 `＆` 不再是会话语法。
- **`/rename 新名字`**：给当前会话改名（比如 `/rename web-server`），别的会话从此用 `@web-server` 找它；这个名字也成为对话标题（终端标签页、`/resume` 列表、网页），不再自动按话题改；`/resume` 这个对话时名字一起回来。
- **`/peers`**：列出本机、其他电脑和通讯录好友在线的会话。模型也能用 ListPeers / MessagePeer 工具自己找别的会话分派任务。
- 回答会在对方这一轮做完后自动发回；对方正忙时，任务排在它当前工作之后。网关替离线的会话暂存回答（24 小时；网关重启会丢失还没送达的消息）。
- **安全**：在线的会话能被同一网关账户执行任何任务。能登录这个账户、或持有它任一 API key 的人，都能在这些电脑上以完全权限执行命令。不需要时 `/disconnect 7bit.fun`。

## 通讯录：和别人的会话互发任务

不同网关账户之间，双方同意后，各自的 claude-pro 会话也能互发任务。

- **通讯号**：每个账户有一个公开的通讯号（默认随机，如 `cp7k3qxm`），别人用它加你，看不到你的邮箱。`/contacts handle 新名字` 或网关网页「通讯录」里修改（3-20 个小写字母、数字、`_`、`-`，以字母开头）。
- **加好友**：`/contacts add 对方通讯号` 发出请求；对方在线的会话会提示，对方用 `/contacts accept 你的通讯号` 同意（也可以 `reject`、`block`），或在网页通讯录里点同意。双方互相请求时直接成为好友。`/contacts remove` 删除，`/contacts block` 拉黑（对方不能再请求、不能发任务，也不会被告知）。`/contacts` 列出全部。
- **发任务**：好友在线的会话在 `/peers` 和 ListPeers 里显示为 `@通讯号:电脑名/会话名`；`@通讯号 任务`（对方只开着一个会话时）或 `@通讯号:电脑名/会话名 任务` 发送，回答自动发回。
- **确认**：好友发来的任务默认在终端弹窗问你「执行 / 拒绝 / 以后都执行」，拒绝时对方会收到“已拒绝”。`/contacts trust 通讯号 auto` 让这个好友的任务直接执行，`confirm` 改回每条确认。交给模型时会注明这是外人的请求、不是用户的指令，并要求它不泄露密钥和私人文件、不做破坏性操作。
- **好友能看到什么**：只有你在线会话的名字、电脑名和是否在忙；看不到目录、标题和对话，发来的消息里也不带你的目录。
- **要求**：双方都要在 claude-pro 里 `/connect` 连上 7bit.fun（模型用别家也可以，这个 key 只用于通讯）。

## 完全访问与安全网

- **没有权限系统**：没有确认弹窗，没有 allow/deny 规则，也没有 `/permissions`。旧参数 `--dangerously-skip-permissions`、`--permission-mode`、`--allowedTools`、`--disallowedTools` 仍被接受但会被忽略，`--plan` 也是；settings 里残留的 `permissions` 字段也会被忽略。
- **没有计划模式**：想先看方案再动手，直接在消息里说（例如"先给方案，我确认前不要改代码"）。
- **检查点与 `/rewind`（或在空输入框连按两次 `Esc`）**：每条提问都会建一个检查点，Write / Edit / MultiEdit / NotebookEdit 修改文件前会先保存原样。菜单按时间列出这次会话的提问（最新的在最下面、默认选中），选一条后可以：**Restore code and conversation**（代码和对话都回到这条之前）、**Restore conversation**（只回退对话，文件不动）、**Restore code**（只恢复文件，对话不动）、**Summarize from here**（这条及之后的对话压缩成摘要，腾出上下文）、**Summarize up to here**（这条之前的压缩成摘要，之后的原样保留）、**Never mind**（回到列表）。回退对话或"Summarize from here"后，那条提问的原文（完整的，不截断）回填到输入框，可以改了再发，相当于删掉不想要的那段对话重新来。`/clear` 之后，菜单最上面多一项 `/resume <id> (previous session)`，可以回到 `/clear` 之前的对话（本进程内有效）。**Bash 命令造成的改动不会被记录**，所以模型被要求优先用文件工具改文件。
- **想要护栏时用 hooks**：`PreToolUse` 钩子仍然可以拦截任何工具调用，由你自己定规则（见下）。

**已经放开的限制**（Bash 默认超时、最长超时和输出上限固定为下表数值，不再读取旧配置；单次调用仍可指定超时）：

| 项目 | 以前 | 现在 |
|---|---|---|
| 单次输出 `max_tokens` | 32000 | 48000（网关按它预扣余额）；如果网关允许的更少，会从报错里读出真实上限并自动降下来 |
| Bash 默认 / 最长超时 | 2 分钟 / 10 分钟 | 10 分钟 / 1 小时 |
| Bash 输出返回给模型的上限 | 30000 字符 | 60000 字符，超出部分的全文保存到文件 |
| 单个工具结果上限（超出落盘） | 50000 字符 | 100000 字符 |
| `Read` 一次最多 | 2000 行、每行 2000 字符、总共 12 万字符 | 10000 行、每行 20000 字符、总共 40 万字符；加 `allow_large: true`不限行数和长度，只要上下文在自动压缩之前还放得下（同一批并行读取共用这份余量），放不下就拒绝并写明差多少 |
| `Glob` / `Grep` 默认返回条数 | 100 / 250 | 1000 / 1000 |
| `WebFetch` | 用当前会话选择的主模型做摘要（最多 4096 token），自动把 http 升成 https | `raw: true` 直接拿转换后的全文；摘要使用当前会话模型，上限 16000 token、页面上限 40 万字符；按原样请求 URL，localhost 和内网也可以；跳转之间保存 Cookie（不再出现 redirect count exceeded）；被反爬拦截（403、验证页）或内容要靠 JS 渲染时，自动改用无头 Chrome/Edge 打开（临时配置，不带你的 Cookie）；Cloudflare 人机验证、需要登录的页面会提示改用 Browser 工具 |
| 子 agent | 不能再派子 agent | 嵌套到 2 层 |
| `Bash` 的标准输入 | 一律关闭 | 可以用 `stdin` 参数喂入文本（回答提示、给脚本传数据） |
| 提示词里的限制 | “尽量少输出”“除非必要不要建文件”“不要强推/改 git 配置/amend” | 回答长度按任务需要；需要就建文件（测试、脚本、配置）；用户要求时可以做上述 git 操作 |

**刻意保留的**：`Edit`/`Write` 必须先 `Read`（防止覆盖没看过的改动，这是正确性保护，不是能力限制；`Write` 覆盖已有文件要求读过完整内容，只读了一部分时用 `Edit`；`--resume` 恢复会话时会按记录重建读取状态，读过之后被改动的文件需要重读）、"没被要求就不提交"、做不可撤销且没被要求的外部操作（强推、发布包、给外部服务发消息或花钱）之前先说一声。

## 功能

**工具**：`Bash`（持久 cwd、超时、后台运行、可喂 stdin）、`BashOutput`、`KillShell`、`Read`（行号、图片、ipynb）、`Write`、`MultiEdit`（一次调用改一个文件的多处，按顺序，要么全改要么全不改）、`Edit`（old_string 必须与文件当前内容唯一匹配：没 Read 过、或读后被命令改过的文件也能直接改，结果里会注明；replace_all 和 `Write` 仍要先读、并检测外部修改；只是时间戳变了、内容没变不算修改；保留 CRLF/BOM 和文件编码：UTF-8、带 BOM 的 UTF-16、GBK）、`NotebookEdit`、`Glob`、`Grep`（有 ripgrep 用 rg，否则用内置 JS 搜索：异步不卡界面，遵循 `.gitignore`/`.ignore`、`!` 排除 glob、`^`/`$` 行锚点、多行匹配、上下文行；PATH 上没有 rg 时自动用 VS Code 自带的 rg.exe，也可用 `CLAUDE_PRO_RIPGREP_PATH` 指定；与 rg 不同的是它始终跳过 `node_modules` 等目录，除非 glob 里点名；模型误传的 `file_path` 当作 `path`，grep 的 `-l`/`-c` 当作输出模式）、`WebFetch`（也能读 x.com 上的单条帖子）、`WebSearch`（在网关上用当前会话选择的主模型自带的搜索，返回标题、链接、日期和带 [n] 出处标记的摘要；`allowed_domains: ["x.com"]` 搜 X 上的帖子，`["github.com"]` 搜 GitHub；当前模型不可用时才退回抓取 DuckDuckGo/Bing 网页）、`TodoWrite`、`Task`（子 agent）、`TaskOutput`、`TaskStop`、`Skill`、`AskUserQuestion`，以及 MCP 工具。

**交互**
- 流式 Markdown 渲染（代码高亮、表格、中文宽度对齐），所有模型返回的思考过程始终展开显示，恢复会话时也会显示已保存的思考；`/verbose` 只切换工具输出详细度和压缩摘要，不影响思考显示
- `Esc` 中断；忙碌时输入的消息会排队并插入当前任务
- `!` Bash 模式、`#` 写入记忆（CLAUDE.md）、`\`+回车 或 `ctrl+j` 换行、粘贴大段文本折叠为 `[Pasted text #1 +42 lines]`
- **简洁的终端界面**：输入行就是一个 `> `（Bash 模式 `!`、记忆模式 `#`），没有边框、浮窗和常驻页脚；输出直接写进终端自己的滚动记录，用终端自己的滚动、选中、复制和查找（Windows Terminal 的 `Ctrl+Shift+F`）。输入行固定在窗口最底下。对话框（选模型、/rewind、提问）是不带边框的编号列表，`↑`/`↓` 或数字选择，`Enter` 确认，`Esc` 取消。**补全按 Tab**（像 shell）：只有一个匹配时直接补上，多个时先补上共同前缀并列出候选，再按 `Tab`/`↓` 在候选里移动，`Enter` 选中，`Esc` 关闭；列表打开时继续输入会跟着过滤。`Ctrl+V` 粘贴剪贴板文字（剪贴板里只有图片时作为图片附加），`Alt+V` 优先附加剪贴板图片。项目管理、看会话、改配置用网页控制台（`claude-pro web`）
- `ctrl+c` 或连按两次 `Esc` 清掉的草稿不会丢：在空输入框按 `↑` 找回（连同粘贴的文本和图片），中间发过别的消息也可以
- `@` 同时补全文件和本机/远程会话：文件引用走 `Read` 工具，等于模型自己读了这个文件。最多带前 2000 行（被截断时会明确告诉模型，并把该文件记为"只读了一部分"，之后 `Write` 不会去覆盖没给它看过的行）；图片作为图片附加；二进制文件和超过 512KB 的文本会被跳过并提示原因；`@目录` 列出目录内容；行首 `@会话 任务` 把任务发给另一会话
- 上下文用满上游输入上限时自动压缩（留出写摘要要用的余量：窗口的 5%，最多 4 万 token，这样摘要请求能读缓存而不是因超长被拒），不再读取 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`；子 agent 定义的 `autoCompactWindow` 仍有效，也可手动 `/compact`
- 会话自动保存到 `~/.claude-pro/projects/`，`claude-pro -c` 继续上次，`claude-pro -r` 选择历史会话

**`/cd <目录>`**：换工作目录，对话接着进行。目录可以是绝对路径、`~`、相对当前目录的路径；不存在或不是目录时报错（不会创建）。会话在新目录里重启一次（约一秒），新目录的项目设置、CLAUDE.md、记忆、git 状态、`@` 文件/会话补全、输入历史都换成新目录的；对话、模型、effort、待办不变。会话记录跟着搬到新目录下，在新目录里 `/resume` 能找到。用 `/rename` 或 `--name` 起过的名字保留，默认按目录取的名字换成新目录名。任务进行中不能切换。

**斜杠命令**：`/help` `/cd` `/rename` `/peers` `/contacts` `/web`（`/web remote …`）`/clear` `/compact` `/config` `/model` `/effort` `/status` `/cost` `/trace` `/context` `/init` `/review` `/memory` `/verify` `/tasks` `/rewind` `/skills` `/resume` `/todos` `/agents` `/mcp` `/bashes` `/verbose` `/export` `/doctor` `/exit`，以及 `.claude/commands/*.md`、`.claude-pro/commands/*.md`、`~/.claude-pro/commands/*.md` 中的自定义命令（支持 `$ARGUMENTS`、`$1`、`` !`cmd` ``）。

**记忆**：自动读取 `~/.claude-pro/CLAUDE.md`、项目各级目录的 `CLAUDE.md` / `.claude/CLAUDE.md` / `CLAUDE.local.md`；某一级目录没有 `CLAUDE.md` 时读它的 `AGENTS.md` 代替（两者都有时通常是同一份说明，不重复发送）。

**自动记忆（跨会话）**：每个项目有一个由 agent 自己维护的记忆目录 `~/.claude-pro/projects/<项目>/memory/`。它会把你的偏好、纠正过的做法、项目约束等写成一条条小文件，并在 `MEMORY.md` 里建索引；每次新会话开始时索引自动载入。直接说"记住……"或"忘掉……"即可；`/memory` 查看；`CLAUDE_PRO_DISABLE_AUTO_MEMORY=1` 关闭。

**Skills**：`<目录>/skills/<名字>/SKILL.md`，frontmatter 写 `name` 和 `description`，正文是指令。搜索 `~/.claude-pro/skills/`、`<项目>/.claude/skills/`、`<项目>/.claude-pro/skills/`（项目级覆盖用户级）。模型发现任务匹配某个 skill 的描述时会通过 `Skill` 工具自动加载它；你也可以直接用 `/<skill 名> [参数]` 调用，`/skills` 列出全部。

**子 agent**：内置 `general-purpose`、`Explore`、`Plan`；自定义 agent 放在 `.claude/agents/*.md` 或 `~/.claude-pro/agents/*.md`（frontmatter：`name`、`description`、`tools`、`model`、`effort`（low/medium/high/xhigh/max）、`autoCompactWindow`（这个 agent 自己的自动压缩窗口，token 数））。模型调用 `Task` 时也可以给单个子 agent 指定 `model`（sonnet/opus/haiku 或完整 id）和 `effort`，优先于 agent 定义里的，定义里的又优先于会话的。

**后台子 agent**：模型可以用 `Task` 的 `run_in_background: true` 把子 agent 放到后台，自己继续干别的。子 agent 完成后，结果会作为 `<task-notification>` 自动送回；如果当时主 agent 空闲，会自动开启新的一轮来处理结果。`TaskOutput` 用于提前等待结果，`TaskStop` 用于取消；`/tasks` 列出所有后台 agent，`/tasks kill agent_1` 停止其中一个。`-p` 模式会等所有后台 agent 结束后再退出。

**验证循环（默认关闭）**：需要时显式设置验证命令（例如 `--verify "npm run check"`、会话中 `/verify npm run check`，或 `CLAUDE_PRO_VERIFY_COMMAND`），`/verify off` 关闭；程序不再自己去找项目的测试脚本来跑。设置之后，只要某一轮改过文件，模型结束前就会自动运行验证命令。失败的输出会发回给模型继续修复，直到通过，最多 3 轮。没有改文件的轮次不会触发验证。

**大输出落盘**：工具结果超过 10 万字符时，全文会保存到 `~/.claude-pro/projects/<项目>/tool-results/`，只把预览和文件路径发给模型，模型可以再用 `Read`/`Grep` 按需查看。Bash 输出被截断时同样会保存全文。超过 7 天的旧文件在启动时自动清理。

**Hooks**：`settings.json` 里的 `hooks`：`PreToolUse`、`PostToolUse`、`UserPromptSubmit`、`Stop`。事件内容以 JSON 从 **stdin** 传给脚本（同时放在环境变量 `CLAUDE_PRO_HOOK_INPUT`，另有 `CLAUDE_PROJECT_DIR`）；退出码 0 = 通过（stdout 作为附加上下文），2 = 拦截（stderr 反馈给模型；`Stop` 则让模型继续干活），其他 = 仅警告。当护栏用的 hook 加上 `"onFailure": "block"`：启动不了、超时或以其他退出码结束时按拦截处理，而不是放行。hook 输出里的 `<system-reminder>` 标签会被转义，冒充不了系统提示。

```json
{ "hooks": {
  "PreToolUse":  [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node scripts/no-rm-rf.js" } ] } ],
  "PostToolUse": [ { "matcher": "Edit|Write", "hooks": [ { "type": "command", "command": "npm run check --silent" } ] } ]
} }
```

**MCP**：项目 `.mcp.json` 或 settings 中的 `mcpServers`，支持 stdio 和 streamable HTTP：

```json
{ "mcpServers": {
  "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
  "remote": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${TOKEN}" } }
} }
```

## 浏览器

`Browser` 工具操作你自己的 Edge/Chrome（带着你的登录状态），也可以用 claude-pro 自己的浏览器（`browser: "own"`）。先在 Edge 的 `edge://inspect/#remote-debugging`（Chrome 是 `chrome://inspect/#remote-debugging`）里打开允许远程调试。浏览器对每个新连接都会弹窗问“是否允许远程调试”（没有“始终允许”），所以连接由一个后台小进程（`src/browser/broker.js`）替所有 claude-pro 会话保持：每个浏览器实例只需点一次“允许”，claude-pro 重启、新开会话都沿用这个连接，不再弹窗。最后一个用它的会话退出 10 分钟后，后台进程才断开连接并退出；之后再用浏览器会重新问一次。

**指定标签页**：在消息里写网址或标题里的字（例如“操作 YouTube 那个标签页”），模型在当前连着的浏览器里按标题和网址找到它。标签页 ID 是 `t` 加浏览器内部 ID 的前几位，只要标签页没关就不变：重新连接或 claude-pro 重启后，同一个 ID 还是同一个标签页，所以也可以直接在消息里写“用 t3f9a”。标签页关了，ID 就失效并报错，不会落到别的标签页上。

用过的浏览器实例会记住：claude-pro 重启后，模型下一次用浏览器时自动连回这个实例，对话里的标签页 ID 仍然有效。没用过时，自动选第一个开了远程调试的浏览器（按 Edge、Chrome、Brave、Chromium 的常用数据目录，再到用独立数据目录运行的实例）；要固定默认，`/config set CLAUDE_PRO_BROWSER edge`。

## 非交互模式

```bash
claude-pro -p "解释一下 src/agent.js"                  # 只输出最终回答
cat error.log | claude-pro -p "这个报错是什么原因"
claude-pro -p --output-format json "..."              # JSON 结果（含 token 用量）
claude-pro -p --verify "npm run check" "修复失败的检查" # 改完自动运行检查，失败继续修
claude-pro -p "只调研，给出重构方案，不要改文件"     # 只出方案：在消息里说就行
```

## 快捷键

| 按键 | 作用 |
|---|---|
| `Enter` | 发送 |
| `\` + `Enter` / `ctrl+j` / `alt+enter` | 换行 |
| `Esc` | 中断当前任务；连按两次：有文字时清空输入，输入框为空时打开回退菜单（同 `/rewind`） |
| `ctrl+c` | 中断 / 清空输入 / 连按两次退出 |
| `ctrl+v` | 粘贴剪贴板文字（只有图片时附加图片） |
| `alt+v` | 附加剪贴板图片（没有图片时粘贴文字） |
| `ctrl+l` | 清屏 |
| `↑` / `↓` | 在多行输入（包括自动折行的长文字）里上下移动光标；光标在第一行时 `↑` 先移到开头、再按才翻到上一条历史消息，`↓` 在最后一行同理 |
| `Tab` | 补全 `/命令`、`@文件`、`@会话`：一个匹配直接补上，多个时列出，`Tab`/`↓` 选下一个，`Enter` 选中，`Esc` 关闭 |
| `?` + `Enter` | 列出快捷键 |

## 开发

GitHub Actions（`.github/workflows/test.yml`）在 Ubuntu、macOS、Windows 上用 Node 22 和 24 跑 `npm run check`。这个自检会以 `--self-check` 启动程序，确认模块能够加载并且界面可以启动。

```bash
npm run check                 # 启动自检，不连接真实账户
```

```
bin/claude-pro.js     入口；交互式会话在这里交给监督进程
src/supervisor.js     监督进程：子进程以退出码 75 请求重启时重新启动它，只用 Node 内置模块
src/restart.js        重启的程序侧：交接的状态、启动检查（runSelfCheck）、监视源码、重启提示
src/selfcheck.js      `--self-check`：在假终端里把整个程序启动一遍并检查工具/系统提示词
src/tools/restart.js  Restart 工具
src/main.js           参数解析、config 子命令
src/config.js         配置加载（settings.json / 环境变量）与模型解析
src/api.js            后端路由、Anthropic SDK 封装：流式、重试、effort/thinking 参数
src/ratelimit.js      限流：解析重置时间响应头、决定等多久、墙上时钟休眠、提示文案
src/agent.js          Agent 循环：工具调度、并行只读工具、中断、自动压缩、验证循环
src/checkpoints.js    检查点与 /rewind
src/filestate.js      恢复会话时从记录重建"已读文件"状态（文件自读取后没变过才信任）
src/hooks.js          Hooks 运行器
src/tasks.js          后台子 agent 注册表与完成通知
src/prompts.js        系统提示词、压缩提示词、自动记忆提示
src/tools/*           各工具实现（含 Skill、NotebookEdit）
src/mcp.js            MCP 客户端（stdio / HTTP）
src/ui/*              终端 UI：屏幕管理、输入框、对话框、Markdown 渲染
src/remote.js         对话事件模型（applyEvent，控制台页面里有同一份）和网关的会话中继连接（跨电脑、通讯录互发任务）
src/live.js           本机 Web 控制台的实时查看：会话的对话事件流（经会话自己的 127.0.0.1 peer 服务）
src/web/*             本机 Web 控制台（claude-pro web / /web）：服务端、API、页面，远程访问的密码和隧道（remote-access.js）
src/commands.js       斜杠命令
```

## 其他说明

WebSearch 依赖网关：没有网关时只能抓取 DuckDuckGo/Bing 网页，而它们常把程序当爬虫拦下（DuckDuckGo 返回 202，Bing 只按查询的第一个词搜），结果可能离题。GitHub 相关的查询，系统提示词让模型优先用 Bash 跑 `gh`（需要已安装并登录）。检查点只覆盖文件工具的修改，不覆盖 Bash 命令造成的改动。

## 历史

旧名 ccc，最后一版保存在 git 标签 `ccc-last`。
