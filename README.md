# claude-pro — 完全访问的命令行编程 Agent

`claude-pro` 是一个**自己实现**的终端 AI 编程助手：模型请求只通过 **codex-gateway** 发送。网关负责上游模型和账户计费，claude-pro 本地只保存网关登录得到的机器专用 key。

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

> **认证**：只使用网关登录。`/login` 会在浏览器完成授权，再把本机专用 key 保存到 `~/.claude-pro/gateway.json`；模型请求和远程会话发布都只发往网关。

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

## 网关登录

claude-pro 只支持 codex-gateway。交互式启动时如果没有网关登录，会自动打开浏览器；也可以手动运行：

```powershell
claude-pro /login
claude-pro --provider gateway
claude-pro --provider gateway --model opus
claude-pro --provider gateway -p "用 Read 工具读取 package.json，告诉我项目版本"
```

登录得到的 key 保存在 `~/.claude-pro/gateway.json`（Windows 对应 `%USERPROFILE%\.claude-pro\gateway.json`），不会读取 Claude CLI 或 Codex CLI 的登录文件。

## /login：网关账户

`/login` 只有一个选项：网关。第一次登录会在浏览器打开网关授权页，授权后 claude-pro 用一次性 code 换取本机专用 API key。

```text
/login
/logout
/cost
```

网关地址默认是 `https://gw.predix.icu`，也可以通过 `CLAUDE_PRO_GATEWAY_URL` 修改。账户余额和用量在网关用户页查看。

## 配置

只需要配置网关地址、模型和可选的本机网关 key：

```bash
CLAUDE_PRO_PROVIDER=gateway
CLAUDE_PRO_GATEWAY_URL=https://gw.predix.icu
CLAUDE_PRO_GATEWAY_MODEL=opus
```

通常不需要手动填写 key；运行 `/login` 后它会保存到 `~/.claude-pro/gateway.json`。无浏览器的自动化场景也可以设置 `CLAUDE_PRO_GATEWAY_API_KEY`。

项目、用户和本地配置文件仍按原来的优先级加载：

```bash
claude-pro config list
claude-pro config set CLAUDE_PRO_GATEWAY_MODEL sonnet
```

会话中用 `/config`、`/model`、`/effort` 修改。`--provider` 仅接受 `gateway`，其他 provider 已移除。

## 持久化系统提示词

可以把整个系统提示词保存到用户配置中，之后关闭并重新启动仍然使用：

```text
/prompt path/to/prompt.md       # 读取文件，并复制到 ~/.claude-pro/prompts/
/prompt "回答要简洁，先给结论"     # 也可以直接保存一段文字
/prompts                         # 选择已保存的提示词
/prompts default                 # 切回内置默认提示词
```

`/promt` 和 `/promits` 也作为常见拼写兼容。当前选择保存在 `~/.claude-pro/settings.json` 的 `prompts.active` 中，提示词内容保存在 `~/.claude-pro/prompts/`，不会依赖原始文件；`/status` 会显示当前选择。切换提示词会立即用于下一次请求，提示词缓存仍然有效时会先询问，因为下一次请求需要重新写入对话。命令行的 `--system-prompt` 和 `--system-prompt-file` 优先级更高，只覆盖本次启动。

## 提示词缓存：自动的，尽量少花钱

每次请求都要把整个对话发给模型，用 Anthropic 的提示词缓存，重复的历史按缓存价（十分之一）计费，不用配置：

- 网关对话用 1 小时缓存（停顿一会儿回来不用整段重写）；子 agent、压缩等用 5 分钟。改缓存时长、关闭缓存的设置见 `claude-pro config list`。
- 页脚的 `◷ 12m` 是缓存还能保留多久；变红表示已过期，下一条消息会把整个对话重新写入缓存。`/cost` 显示命中率和没命中的原因。
- 缓存还热时 `/model`、`/effort` 会先确认（切换会让缓存失效）；离开一个多小时回来时，清掉较早的工具结果，少重写一些。
- 人不在时自动保温（Claude 模型）：缓存到期前 5 分钟把上一个请求重发一次，只要 1 个输出 token。读缓存会让它再保留一小时，花费是整段重写的 1/40（Opus 上 15 万 token 的对话：约 $0.03，重写约 $1.20）。一次停顿最多保温 8 小时，`CLAUDE_PRO_CACHE_KEEPALIVE_HOURS` 可以改（0 关闭）。`/cost` 显示刷新次数和花费。GPT 模型不需要：网关上的 GPT 缓存停顿几个小时后通常还在。

（缓存标记放在哪、端点不认时怎么退、压缩如何复用缓存等细节见 ARCHITECTURE.md 6.5。）

## 运行时 Trace：用真实数据优化模型和工具

默认在每个会话写入独立的隐私保护 JSONL：`~/.claude-pro/projects/<项目>/traces/<session-id>.jsonl`。Trace 只保存 turn/request/tool/compaction/verification 的计数、耗时、token 数、缓存 fingerprint 和参数结构，不保存 API key、cookie、token、密码、完整 prompt、工具输入或工具输出。大输出只记录大小和是否落盘；单个文件默认 20 MB，超出后轮换为 `.1`。

```text
/trace       # 当前会话的请求、工具、缓存、压缩和验证汇总
/trace 20    # 另外显示最近 20 条结构化事件
```

可用配置：`CLAUDE_PRO_TRACE=0` 关闭，`CLAUDE_PRO_TRACE_DIR` 指定目录，`CLAUDE_PRO_TRACE_MAX_SIZE` 调整单文件上限。`/cost` 也会显示轻量工具成功率和验证次数。Trace 是 best-effort，写入失败不会影响 Agent 主循环。

## 限流：自动暂停，到点自动恢复

网关账户的 5 小时和每周限额用完时，不报错停下，而是暂停并显示倒计时（`✻ 5-hour limit reached · resumes at 23:41 (in 2h 13m)`，Esc 可取消），到重置时间原样重发同一个请求，任务接着做完。网关过载（529）同样先重试、再暂停等它恢复。最多等 6 小时（`CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS`，`0` = 不等直接报错）；重置时间更远（比如周限额还有几天）时直接报错，并写明几点重置。

## 终端标题、页脚与窗口缩放

- **终端标题**：标签/窗口标题显示 `✳ <会话标题> | <目录> · <模型> · <effort>`（会话标题是**当前话题**：每次发消息后，后台让小模型（haiku）判断是否换了话题，换了就生成一个简短标题；"继续"之类的消息不会改标题。话题记在会话文件里，`/resume`、重启后仍在，`/resume` 列表也显示它。旧会话没有话题时，恢复时按最近一条提问生成。还没生成时显示第一条提问。最多 40 字，保证模型和 effort 不被窄标签截掉。`CLAUDE_PRO_DISABLE_TOPIC_TITLE=1` 关闭，省掉每条消息一次的小请求）。忙碌时前缀在 `⠂`/`⠐` 之间闪动，限流暂停时变 `⏸`，退出时恢复进入前的标题。`/model`、`/effort`、`/clear`、`/resume` 后自动更新。**VS Code**(1.140 起)只对它认得的 AI 命令行(claude/codex/copilot/gemini)把程序设置的标题显示在标签上(`terminal.integrated.tabs.allowAgentCliTitle`,默认开),其余一律显示进程名 `node`;它在 Windows 上靠 `node.exe` 命令行里的 `\claude-code\` 路径段识别它,所以监督进程用 `bin\claude-code\..\claude-pro.js` 启动会话(目录不必存在,Node 自己化简 `..`)。不经过监督进程的启动方式(`CLAUDE_PRO_NO_SUPERVISOR=1`)或 Linux/macOS 上,要在 VS Code 设置里把 `terminal.integrated.tabs.title` 改成 `${sequence}` 才能看到标题。
- **用户的提问**：带一条深灰色背景（横跨整个窗口宽度），和回复一眼就能分开。背景条是用当前背景色清除行尾（`\x1b[K`）画出来的，不靠补空格，窗口变宽变窄都正好铺满。
- **页脚**：输入框下方右侧常驻当前模型和 effort（如 `sonnet-5-5 · high`）；没发送 effort（auto）或该模型不支持时只显示模型；窄窗口放不下时先让位给"上下文快满"等提示，再不行就不显示。模型前面是**当前对话累计花费**（如 `$1.23 · opus-5-5 · effort high`）：按官方价（和网关扣费同一张价目表，含 5 分钟/1 小时缓存写入、长上下文价）把每个请求算进去，子 agent、压缩、话题标题、WebFetch 都算，按 Esc 中断的请求按已读入的输入和估算的已输出部分算；记在会话文件里，重启、`/resume` 后接着累计，`/clear` 从零开始。`/cost` 第一行也显示它，`-p --output-format json` 的结果带本次运行的 `total_cost_usd`。不认识价格的模型（第三方端点的自定义模型）不计；网关上游分组倍率不是 1 的账户以网关流水为准。花费前面是**提示词缓存时钟**：`◷ 12m` 表示对话的缓存估计还能保留 12 分钟（按 5 分钟或 1 小时 TTL 倒数，每次用到缓存的回复重新开始计时）；倒数结束后分钟数消失、图标变红，直到下一次回复——这时发下一条消息会把整个对话重新写入缓存，更慢也更贵；压缩之后到下一次回复之前也是红色，因为压缩后的对话还没进缓存。时钟记在会话文件里，重启、`/resume` 后接着显示（压缩后关掉的会话恢复时是冷的）；还没有回复报告过缓存用量时不显示。窄窗口先省掉花费，再省掉时钟。
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

## 远程会话：浏览器只读查看

本地手动启动的交互式 claude-pro 会话登录网关后自动注册。远程连接只由终端向 `CLAUDE_PRO_GATEWAY_URL` 发出站请求，终端不监听端口；网页只通过网关查看本地终端会话。

- **自动上线**：`/login` 成功后当前会话立即注册；之后每个交互会话启动时自动注册，断线自动重连；`/logout` 后停止远程连接。`CLAUDE_PRO_ONLINE=0` 可以关闭远程发布。
- **网页能看到**：会话列表、在线/离线/结束状态、模型、目录、机器名、viewer 数、transcript、流式文本和 thinking、工具调用与输出、todos、后台任务、排队消息、问题文本和连接状态。
- **网页不能做**：网页没有输入框和控制写请求，不能发送消息、停止任务、回答问题、切换 model/effort、浏览目录、恢复/删除历史、打开终端、更新程序或管理电脑；这些操作只能在本地终端完成。
- **页面请求**：远程入口是 `/user#remote`；页面只使用 `GET /user/remote/sessions` 和 `GET /user/remote/sessions/:id/events`（SSE）。终端使用 `POST /v1/remote/sessions` 注册，`GET .../commands` 接收 viewer/snapshot/peer 帧，`POST .../events` 发布 snapshot/batch/status/bye。
- **快照与保留**：网关状态在内存中保存；网关重启后终端重新注册并补发 snapshot。每个账户最多 60 个会话，优先淘汰最久未活动的离线会话；事件缓冲最多 3000 个事件或 8 MB；结束会话保留 6 小时，未结束但离线保留 24 小时。
- **权限边界**：网页只能看到同一网关账户的会话；会话内容会经网关中转并暂存在内存。撤销建立终端流的 API key 后，终端连接会被断开。

## 会话之间互发任务（本机和其他电脑）

每个交互会话都有一个名字（默认是目录名，输入框右上角的 `@名字`），别的会话可以给它发任务，它做完后回答自动发回来。

- **本机**：同一台电脑上开着的会话直接互通（经 127.0.0.1，不经过网络）。
- **其他电脑**：同一个网关账户下在线的会话经网关互通。例如公司电脑上开着 claude-pro，在家里输入 `@公司 跑一下测试`，任务送到公司那台的会话，回答自动显示在家里这边。电脑名默认是主机名，用 `CLAUDE_PRO_MACHINE_NAME=公司` 改成好记的名字（支持中文）。
- **输入 `@`** 弹出文件和会话的混合补全（本机的和其他电脑在线的会话都会列出），选文件可引用它，选会话再写任务回车即可：
  - `@文件路径`：引用文件；带空格的路径使用 `@"文件路径"`；
  - `@名字 任务`：向本机或远程会话发送任务；
  - `@电脑名/名字 任务`：向其他电脑上的指定会话发送任务；那台电脑只开着一个会话时直接 `@电脑名 任务`。
  - 文件和会话同名时，行首 `@名字 任务` 按会话处理；要强制引用文件可写 `@./名字`。
- **`@` 可以写在句子中间**：输入时在空格后面打 `@` 也会弹出文件和会话列表；在发给当前 agent 的消息里提到 `@名字`，agent 会被告知那是哪个会话、怎么联系它。文件引用仍会展开为文件内容。输入法打出全角 `＆` 不再是会话语法。
- **`/rename 新名字`**：给当前会话改名（比如 `/rename web-server`），别的会话从此用 `@web-server` 找它；这个名字也成为对话标题（终端标签页、`/resume` 列表、网页），不再自动按话题改；`/resume` 这个对话时名字一起回来。
- **`/peers`**：列出本机和其他电脑上在线的会话。模型也能用 ListPeers / MessagePeer 工具自己找别的会话分派任务。
- 回答会在对方这一轮做完后自动发回；对方正忙时，任务排在它当前工作之后。网关替离线的会话暂存回答（24 小时；网关重启会丢失还没送达的消息）。
- **安全**：在线的会话能被同一网关账户执行任何任务。能登录这个账户、或持有它任一 API key 的人，都能在这些电脑上以完全权限执行命令。不需要时 `/logout`。

## 完全访问与安全网

- **没有权限系统**：没有确认弹窗，没有 allow/deny 规则，也没有 `/permissions`。旧参数 `--dangerously-skip-permissions`、`--permission-mode`、`--allowedTools`、`--disallowedTools` 仍被接受但会被忽略，`--plan` 也是；settings 里残留的 `permissions` 字段也会被忽略。
- **没有计划模式**：想先看方案再动手，直接在消息里说（例如"先给方案，我确认前不要改代码"）。
- **检查点与 `/rewind`（或在空输入框连按两次 `Esc`）**：每条提问都会建一个检查点，Write / Edit / NotebookEdit 修改文件前会先保存原样。菜单按时间列出这次会话的提问（最新的在最下面、默认选中），选一条后可以：**Restore code and conversation**（代码和对话都回到这条之前）、**Restore conversation**（只回退对话，文件不动）、**Restore code**（只恢复文件，对话不动）、**Summarize from here**（这条及之后的对话压缩成摘要，腾出上下文）、**Summarize up to here**（这条之前的压缩成摘要，之后的原样保留）、**Never mind**（回到列表）。回退对话或"Summarize from here"后，那条提问的原文（完整的，不截断）回填到输入框，可以改了再发，相当于删掉不想要的那段对话重新来。`/clear` 之后，菜单最上面多一项 `/resume <id> (previous session)`，可以回到 `/clear` 之前的对话（本进程内有效）。**Bash 命令造成的改动不会被记录**，所以模型被要求优先用文件工具改文件。
- **想要护栏时用 hooks**：`PreToolUse` 钩子仍然可以拦截任何工具调用，由你自己定规则（见下）。

**已经放开的限制**（都可以用环境变量改回去）：

| 项目 | 以前 | 现在 |
|---|---|---|
| 单次输出 `max_tokens` | 32000 | 48000（网关按它预扣余额）；如果网关允许的更少，会从报错里读出真实上限并自动降下来 |
| Bash 默认 / 最长超时 | 2 分钟 / 10 分钟 | 10 分钟 / 1 小时 |
| Bash 输出返回给模型的上限 | 30000 字符 | 60000 字符，超出部分的全文保存到文件 |
| 单个工具结果上限（超出落盘） | 50000 字符 | 100000 字符 |
| `Read` 一次最多 | 2000 行、每行 2000 字符、总共 12 万字符 | 10000 行、每行 20000 字符、总共 40 万字符；加 `allow_large: true`不限行数和长度，只要上下文在自动压缩之前还放得下（同一批并行读取共用这份余量），放不下就拒绝并写明差多少 |
| `Glob` / `Grep` 默认返回条数 | 100 / 250 | 1000 / 1000 |
| `WebFetch` | 只返回小模型的摘要（最多 4096 token），自动把 http 升成 https | `raw: true` 直接拿转换后的全文；摘要上限 16000 token、页面上限 40 万字符；按原样请求 URL，localhost 和内网也可以 |
| 子 agent | 不能再派子 agent | 嵌套到 2 层 |
| `Bash` 的标准输入 | 一律关闭 | 可以用 `stdin` 参数喂入文本（回答提示、给脚本传数据） |
| 提示词里的限制 | “尽量少输出”“除非必要不要建文件”“不要强推/改 git 配置/amend” | 回答长度按任务需要；需要就建文件（测试、脚本、配置）；用户要求时可以做上述 git 操作 |

**刻意保留的**：`Edit`/`Write` 必须先 `Read`（防止覆盖没看过的改动，这是正确性保护，不是能力限制；`Write` 覆盖已有文件要求读过完整内容，只读了一部分时用 `Edit`；`--resume` 恢复会话时会按记录重建读取状态，读过之后被改动的文件需要重读）、"没被要求就不提交"、做不可撤销且没被要求的外部操作（强推、发布包、给外部服务发消息或花钱）之前先说一声。

## 功能

**工具**：`Bash`（持久 cwd、超时、后台运行、可喂 stdin）、`BashOutput`、`KillShell`、`Read`（行号、图片、ipynb）、`Write`、`Edit`（old_string 必须与文件当前内容唯一匹配：没 Read 过、或读后被命令改过的文件也能直接改，结果里会注明；replace_all 和 `Write` 仍要先读、并检测外部修改；只是时间戳变了、内容没变不算修改；保留 CRLF/BOM 和文件编码：UTF-8、带 BOM 的 UTF-16、GBK）、`NotebookEdit`、`Glob`、`Grep`（有 ripgrep 用 rg，否则用内置 JS 搜索：异步不卡界面，遵循 `.gitignore`/`.ignore`、`!` 排除 glob、`^`/`$` 行锚点、多行匹配、上下文行；PATH 上没有 rg 时自动用 VS Code 自带的 rg.exe，也可用 `CLAUDE_PRO_RIPGREP_PATH` 指定；与 rg 不同的是它始终跳过 `node_modules` 等目录，除非 glob 里点名；模型误传的 `file_path` 当作 `path`，grep 的 `-l`/`-c` 当作输出模式）、`WebFetch`、`WebSearch`（DuckDuckGo/Bing）、`TodoWrite`、`Task`（子 agent）、`TaskOutput`、`TaskStop`、`Skill`、`AskUserQuestion`，以及 MCP 工具。

**交互**
- 流式 Markdown 渲染（代码高亮、表格、中文宽度对齐），思考过程折叠显示（`ctrl+o` 展开）
- `Esc` 中断；忙碌时输入的消息会排队并插入当前任务
- `!` Bash 模式、`#` 写入记忆（CLAUDE.md）、`\`+回车 或 `ctrl+j` 换行、粘贴大段文本折叠为 `[Pasted text #1 +42 lines]`
- **全屏模式（默认）**：程序画在终端的备用屏幕上（像 vim），输入框固定在窗口最底下，不随输出或终端滚动条移动；对话在程序里滚动：鼠标滚轮（每格 3 行）、`PgUp`/`PgDn`（半屏）、`Ctrl+Home`（对话开头）、`Ctrl+End`（回到最新）。往上翻时新输出不会把画面拉回底部，底部浮着 `Jump to bottom (ctrl+End) ↓ · N new lines`，**点它**或按 `Ctrl+End` 回到底部；发消息时自动回到底部。**选中文字直接用鼠标拖**（不用按 Shift），松开只保留反色选择，不会自动复制；双击选一个词，三击选一整行；拖到对话区上下边缘会跟着滚动。选中的部分反色显示，点一下别处、按 `Esc` 或任意键就消失；有选中时只有 `Ctrl+C` 会复制。`Ctrl+V` 粘贴剪贴板文字（剪贴板里只有图片时作为图片附加），`Alt+V` 优先附加剪贴板图片；右键不执行复制或粘贴。仍可按住 Shift 拖动用终端自己的选中。退出后终端回到启动前的样子（对话不留在终端滚动记录里）。`/tui default` 切回经典模式（对话写进终端自己的滚动记录，输入框在窗口底部、靠空行顶到底），`/tui fullscreen` 切回全屏，选择会记住（`CLAUDE_PRO_TUI`）
- `ctrl+c` 或连按两次 `Esc` 清掉的草稿不会丢：在空输入框按 `↑` 找回（连同粘贴的文本和图片），中间发过别的消息也可以
- `@` 同时补全文件和本机/远程会话：文件引用走 `Read` 工具，等于模型自己读了这个文件。最多带前 2000 行（被截断时会明确告诉模型，并把该文件记为"只读了一部分"，之后 `Write` 不会去覆盖没给它看过的行）；图片作为图片附加；二进制文件和超过 512KB 的文本会被跳过并提示原因；`@目录` 列出目录内容；行首 `@会话 任务` 把任务发给另一会话
- 上下文用量接近阈值时自动压缩（`CLAUDE_CODE_AUTO_COMPACT_WINDOW`），也可手动 `/compact`
- 会话自动保存到 `~/.claude-pro/projects/`，`claude-pro -c` 继续上次，`claude-pro -r` 选择历史会话

**`/cd <目录>`**：换工作目录，对话接着进行。目录可以是绝对路径、`~`、相对当前目录的路径；不存在或不是目录时报错（不会创建）。会话在新目录里重启一次（约一秒），新目录的项目设置、CLAUDE.md、记忆、git 状态、`@` 文件/会话补全、输入历史都换成新目录的；对话、模型、effort、待办、网页上的远程会话（同一个链接）不变。会话记录跟着搬到新目录下，在新目录里 `/resume` 能找到。用 `/rename` 或 `--name` 起过的名字保留，默认按目录取的名字换成新目录名。任务进行中不能切换。

**斜杠命令**：`/help` `/tui` `/cd` `/rename` `/peers` `/clear` `/compact` `/config` `/model` `/effort` `/status` `/cost` `/trace` `/context` `/init` `/review` `/memory` `/verify` `/tasks` `/rewind` `/skills` `/resume` `/todos` `/agents` `/mcp` `/bashes` `/verbose` `/export` `/doctor` `/exit`，以及 `.claude/commands/*.md`、`.claude-pro/commands/*.md`、`~/.claude-pro/commands/*.md` 中的自定义命令（支持 `$ARGUMENTS`、`$1`、`` !`cmd` ``）。

**记忆**：自动读取 `~/.claude-pro/CLAUDE.md`、项目各级目录的 `CLAUDE.md` / `.claude/CLAUDE.md` / `CLAUDE.local.md`；某一级目录没有 `CLAUDE.md` 时读它的 `AGENTS.md` 代替（两者都有时通常是同一份说明，不重复发送）。

**自动记忆（跨会话）**：每个项目有一个由 agent 自己维护的记忆目录 `~/.claude-pro/projects/<项目>/memory/`。它会把你的偏好、纠正过的做法、项目约束等写成一条条小文件，并在 `MEMORY.md` 里建索引；每次新会话开始时索引自动载入。直接说"记住……"或"忘掉……"即可；`/memory` 查看；`CLAUDE_PRO_DISABLE_AUTO_MEMORY=1` 关闭。

**Skills**：`<目录>/skills/<名字>/SKILL.md`，frontmatter 写 `name` 和 `description`，正文是指令。搜索 `~/.claude-pro/skills/`、`<项目>/.claude/skills/`、`<项目>/.claude-pro/skills/`（项目级覆盖用户级）。模型发现任务匹配某个 skill 的描述时会通过 `Skill` 工具自动加载它；你也可以直接用 `/<skill 名> [参数]` 调用，`/skills` 列出全部。

**子 agent**：内置 `general-purpose`、`Explore`、`Plan`；自定义 agent 放在 `.claude/agents/*.md` 或 `~/.claude-pro/agents/*.md`（frontmatter：`name`、`description`、`tools`、`model`、`effort`（low/medium/high/xhigh/max）、`autoCompactWindow`（这个 agent 自己的自动压缩窗口，token 数））。模型调用 `Task` 时也可以给单个子 agent 指定 `model`（sonnet/opus/haiku 或完整 id）和 `effort`，优先于 agent 定义里的，定义里的又优先于会话的。

**后台子 agent**：模型可以用 `Task` 的 `run_in_background: true` 把子 agent 放到后台，自己继续干别的。子 agent 完成后，结果会作为 `<task-notification>` 自动送回；如果当时主 agent 空闲，会自动开启新的一轮来处理结果。`TaskOutput` 用于提前等待结果，`TaskStop` 用于取消；`/tasks` 列出所有后台 agent，`/tasks kill agent_1` 停止其中一个。`-p` 模式会等所有后台 agent 结束后再退出。

**自动验证循环**：如果项目有明确的测试入口，claude-pro 会自动发现并使用 `package.json` 的 `test`/`check`/`verify`/`lint` 脚本，或 `pytest`、`cargo test`、`go test ./...`、`make test`。也可以显式设置验证命令（例如 `--verify "npm run check"`、会话中 `/verify npm run check`，或 `CLAUDE_PRO_VERIFY_COMMAND`）；显式配置优先，`/verify off` 可关闭自动发现。只要某一轮改过文件，模型结束前就会自动运行验证命令。失败的输出会发回给模型继续修复，直到通过，最多 3 轮。没有改文件的轮次不会触发验证。

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
| `ctrl+c` | 全屏有选中文字时复制；否则中断 / 清空输入 / 连按两次退出 |
| `ctrl+v` | 粘贴剪贴板文字（只有图片时附加图片） |
| `alt+v` | 附加剪贴板图片（没有图片时粘贴文字） |
| `ctrl+o` | 切换详细输出（思考过程、完整工具输出） |
| `ctrl+t` | 显示/隐藏 todo 列表 |
| `ctrl+l` | 清屏重绘 |
| `PgUp` / `PgDn`、滚轮、`Ctrl+Home` / `Ctrl+End` | 全屏模式下滚动对话 / 到开头 / 回到最新 |
| `ctrl+f` | 全屏模式下在对话里查找（像 VS Code）：输入框的位置换成查找框，边输入边高亮所有匹配（不分大小写，当前这个橙色、其余黄色），右上角显示"第几个/共几个"（`No results` 表示没有）。先跳到视图底部往上最近的一个；`Enter` 或 `↑` 跳到更早的一个，`Shift+Enter` 或 `↓` 跳到更新的一个，到头后绕回；`PgUp`/`PgDn`、滚轮照常滚动；`Esc` 关闭，画面停在当前位置（`Ctrl+End` 回到底部）。再按 `ctrl+f` 会带上上次的关键字（已选中，直接输入就替换）；先用鼠标选中文字再按，会搜选中的文字。查找时有新输出，匹配会跟着更新。经典模式（`/tui default`）的对话在终端自己的滚动缓冲里，请用终端自带的查找 |
| `↑` / `↓` | 在多行输入（包括自动折行的长文字）里上下移动光标；光标在第一行时 `↑` 先移到开头、再按才翻到上一条历史消息，`↓` 在最后一行同理 |
| `Tab` | 补全命令 / 文件 |

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
src/config.js         配置加载（.env / settings.json / 环境变量）与模型解析
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
src/remote.js         只读远程会话发布、对话事件模型和终端 peer messaging（applyEvent，网关页面里有同一份）
src/commands.js       斜杠命令
```

## 其他说明

WebSearch 通过抓取 DuckDuckGo/Bing 实现。检查点只覆盖文件工具的修改，不覆盖 Bash 命令造成的改动。

提示：全屏模式里的鼠标选择不会自动写入剪贴板；使用 `Ctrl+C` 复制、`Ctrl+V` 粘贴。按住 Shift 的终端原生选择行为由终端自身决定。

## 历史

旧名 ccc，最后一版保存在 git 标签 `ccc-last`。
