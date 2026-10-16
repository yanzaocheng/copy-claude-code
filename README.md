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

> **认证**：只使用网关登录。`/login` 会在浏览器完成授权，再把本机专用 key 保存到 `~/.claude-pro/gateway.json`；模型请求和远程控制都只发往网关。

## 安装与运行

需要 Node.js 22+。Windows 上 Bash 工具使用 Git Bash，会自动查找，也可以用 `CLAUDE_CODE_GIT_BASH_PATH` 指定。

从 npm 安装（推荐）：

```bash
npm install -g @yanzc/claude-pro
claude-pro                 # 在任意项目目录里运行
```

自动更新：用 npm 全局安装的版本在启动时、以及运行中**每 5 分钟**查一次 npm 上的最新版（同一台电脑上的所有会话共用这个间隔，查到的新版本号也共享；查询绕过 npm 的 CDN 缓存）。
- **不打断工作**：发现新版后先记下，底部显示 `update x.y.z ready · installs when idle`；**等这个会话和这台电脑上其他开着的会话都空闲**（没有在执行任务、没有等待回答的问题、没有后台 agent/命令）才安装，有会话在忙就每 30 秒再看一次，本会话一轮结束时也会再试。
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

## 提示词缓存：自动的，尽量少花钱

每次请求都要把整个对话发给模型，用 Anthropic 的提示词缓存，重复的历史按缓存价（十分之一）计费，不用配置：

- 网关对话用 1 小时缓存（停顿一会儿回来不用整段重写）；子 agent、压缩等用 5 分钟。改缓存时长、关闭缓存的设置见 `claude-pro config list`。
- 页脚的 `◷ 12m` 是缓存还能保留多久；变红表示已过期，下一条消息会把整个对话重新写入缓存。`/cost` 显示命中率和没命中的原因。
- 缓存还热时 `/model`、`/effort` 会先确认（切换会让缓存失效）；离开一个多小时回来时，清掉较早的工具结果，少重写一些。

（缓存标记放在哪、端点不认时怎么退、压缩如何复用缓存等细节见 ARCHITECTURE.md 6.5。）

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

## 远程控制：在浏览器或手机上看执行过程、下发指令

可以在手机或另一台电脑上看着会话干活，并给它发指令，**不用任何命令或设置**。会话经**网关**（gw.predix.icu，即 `CLAUDE_PRO_GATEWAY_URL`）中转：claude-pro 只向网关发出站请求，**不监听任何端口，不走局域网**；在网关用户端登录后，左侧菜单"**远程控制**"里按电脑分组列出自己的会话，可以查看、操作，也可以在某台电脑上新建、结束、重启会话，恢复历史对话（见下面"网页管理电脑和后台会话"）。模型请求和远程控制都使用同一个网关登录。

- **默认在线**：这台电脑登录了网关（`/login`）以后，每个交互会话启动时自动连上网关（不阻塞启动，断开后自动重连），网页上能看到这台电脑上所有开着的会话，别的电脑也能给它们发任务（见下一节）。`/login` 登录成功后当前会话**马上上线**（不用重启），并打印它的链接；`/logout` 后马上下线；在别的窗口登录或退出，这个窗口几秒内跟上。模型请求和远程控制共用这个网关登录。
- **在网页上找到会话**：网关用户端的"远程控制"（`/user#remote`）按电脑列出所有会话，点开即可。`/status` 显示这个会话的远程状态（在线、连接中、没登录、key 被拒…）。在线时输入框右上角显示 `⇄ &名字`，有网页在看时页脚显示 `⇄ N watching`。
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
- **历史对话**：网页列出这台电脑上保存的对话（可搜索），点一下就在原来的目录里恢复成后台会话；已经开着的直接打开那个会话。也可以删除：这台电脑上这段对话的记录（会话文件、存成文件的工具结果、它的 /rewind 检查点、跑过它的后台会话的日志）全部删掉，之后不能再恢复；项目的记忆、CLAUDE.md、输入历史不动，网关后台的记录也不动。对话正开在后台会话里时，选"结束并删除记录"会先结束那个会话；正开在终端里的会话不会被代为关闭，要先在那台电脑上 `/exit`。
- **后台会话的管理**：网页上可以结束（等于 `/exit`，忙时先中断，10 秒不退就强制结束）、重启（等于 `/restart`，对话保留）、看日志、展开某个工具调用的完整输出。会话意外退出时自动拉起（同一段对话、同一个网页链接；10 分钟内最多 3 次，之后标为失败并显示日志最后几行，可以在网页上重启）。电脑重启后，电脑服务会重新打开之前的后台会话（只恢复对话，不自动继续被中断的任务）；用结束或 `/exit` 关掉的不再打开。
- **把后台会话叫到前台**：网页上点"在电脑上打开窗口"，那台电脑上就弹出一个终端窗口接上这个会话（正在执行任务时也可以，任务不中断：窗口里能看到到目前为止的对话和正在进行的这一轮，之后实时跟着走），可以直接在窗口里输入、排队消息、Esc 停止、回答提问，网页同时照常可用。关掉窗口（包括直接点右上角的 X）只是断开，会话回到后台继续运行，仍由电脑服务管理（重启后恢复、网页上结束和重启都照旧）。每点一次开一个新窗口；网页卡片上显示当前接着几个窗口。没有桌面的 Linux 上是开一个 tmux 会话。
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
- **`&` 可以写在句子中间**：输入时在空格后面打 `&` 也会弹出会话列表；在发给当前 agent 的消息里提到 `&名字`，agent 会被告知那是哪个会话、怎么联系它。输入法打出全角 `＆` 也可以。
- **`/rename 新名字`**：给当前会话改名（比如 `/rename web-server`），别的会话从此用 `&web-server` 找它；这个名字也成为对话标题（终端标签页、`/resume` 列表、网页），不再自动按话题改；`/resume` 这个对话时名字一起回来。
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

**工具**：`Bash`（持久 cwd、超时、后台运行、可喂 stdin）、`BashOutput`、`KillShell`、`Read`（行号、图片、ipynb）、`Write`、`Edit`（必须先读后改、检测外部修改、保留 CRLF/BOM）、`NotebookEdit`、`Glob`、`Grep`（有 ripgrep 用 rg，否则用内置 JS 搜索：异步不卡界面，遵循 `.gitignore`/`.ignore`、`!` 排除 glob、`^`/`$` 行锚点、多行匹配、上下文行；找不到 rg 时可用 `CLAUDE_PRO_RIPGREP_PATH` 指定；与 rg 不同的是它始终跳过 `node_modules` 等目录，除非 glob 里点名；模型误传的 `file_path` 当作 `path`，grep 的 `-l`/`-c` 当作输出模式）、`WebFetch`、`WebSearch`（DuckDuckGo/Bing）、`TodoWrite`、`Task`（子 agent）、`TaskOutput`、`TaskStop`、`Skill`、`AskUserQuestion`，以及 MCP 工具。

**交互**
- 流式 Markdown 渲染（代码高亮、表格、中文宽度对齐），思考过程折叠显示（`ctrl+o` 展开）
- `Esc` 中断；忙碌时输入的消息会排队并插入当前任务
- `!` Bash 模式、`#` 写入记忆（CLAUDE.md）、`\`+回车 或 `ctrl+j` 换行、粘贴大段文本折叠为 `[Pasted text #1 +42 lines]`
- **全屏模式（默认）**：程序画在终端的备用屏幕上（像 vim），输入框固定在窗口最底下，不随输出或终端滚动条移动；对话在程序里滚动：鼠标滚轮（每格 3 行）、`PgUp`/`PgDn`（半屏）、`Ctrl+Home`（对话开头）、`Ctrl+End`（回到最新）。往上翻时新输出不会把画面拉回底部，底部浮着 `Jump to bottom (ctrl+End) ↓ · N new lines`，**点它**或按 `Ctrl+End` 回到底部；发消息时自动回到底部。**选中文字直接用鼠标拖**（不用按 Shift），松开就复制到剪贴板；双击选一个词，三击选一整行；拖到对话区上下边缘会跟着滚动。选中的部分反色显示，点一下别处、按 `Esc` 或任意键就消失；有选中时 `Ctrl+C` 是复制（不会中断任务）。**右键**和在终端里一样：有选中时复制，没有时把剪贴板的文字粘贴进输入框（和 `Ctrl+V` 相同）。仍可按住 Shift 拖动用终端自己的选中。退出后终端回到启动前的样子（对话不留在终端滚动记录里）。`/tui default` 切回经典模式（对话写进终端自己的滚动记录，输入框在窗口底部、靠空行顶到底），`/tui fullscreen` 切回全屏，选择会记住（`CLAUDE_PRO_TUI`）
- `ctrl+c` 或连按两次 `Esc` 清掉的草稿不会丢：在空输入框按 `↑` 找回（连同粘贴的文本和图片），中间发过别的消息也可以
- `@文件` 补全并附加内容：走的就是 `Read` 工具，等于模型自己读了这个文件。最多带前 2000 行（被截断时会明确告诉模型，并把该文件记为"只读了一部分"，之后 `Write` 不会去覆盖没给它看过的行）；图片作为图片附加；二进制文件和超过 512KB 的文本会被跳过并提示原因；`@目录` 列出目录内容
- `alt+v` 粘贴剪贴板里的图片（截图用 `Win+Shift+S`），输入框里显示为 `[Image #1]`；超过 1568px 的图会自动缩小，超过 512 KB 的 PNG（3D 画面、照片类截图）改用 JPEG 发送，通常只有原来的 1/10（每次请求都带着整个对话，图片太重会让请求超过 32 MB 的上限）。把图片文件拖进终端（或粘贴图片路径）也会作为图片附加
- 上下文用量接近阈值时自动压缩（`CLAUDE_CODE_AUTO_COMPACT_WINDOW`），也可手动 `/compact`
- 会话自动保存到 `~/.claude-pro/projects/`，`claude-pro -c` 继续上次，`claude-pro -r` 选择历史会话

**`/cd <目录>`**：换工作目录，对话接着进行。目录可以是绝对路径、`~`、相对当前目录的路径；不存在或不是目录时报错（不会创建）。会话在新目录里重启一次（约一秒），新目录的项目设置、CLAUDE.md、记忆、git 状态、`@` 文件补全、输入历史都换成新目录的；对话、模型、effort、待办、网页上的远程会话（同一个链接）不变。会话记录跟着搬到新目录下，在新目录里 `/resume` 能找到。用 `/rename` 或 `--name` 起过的名字保留，默认按目录取的名字换成新目录名。任务进行中不能切换。

**斜杠命令**：`/help` `/tui` `/cd` `/rename` `/peers` `/clear` `/compact` `/config` `/model` `/effort` `/status` `/cost` `/context` `/init` `/review` `/memory` `/verify` `/tasks` `/rewind` `/skills` `/resume` `/todos` `/agents` `/mcp` `/bashes` `/verbose` `/export` `/doctor` `/exit`，以及 `.claude/commands/*.md`、`.claude-pro/commands/*.md`、`~/.claude-pro/commands/*.md` 中的自定义命令（支持 `$ARGUMENTS`、`$1`、`` !`cmd` ``）。

**记忆**：自动读取 `~/.claude-pro/CLAUDE.md`、项目各级目录的 `CLAUDE.md` / `.claude/CLAUDE.md` / `CLAUDE.local.md`；某一级目录没有 `CLAUDE.md` 时读它的 `AGENTS.md` 代替（两者都有时通常是同一份说明，不重复发送）。

**自动记忆（跨会话）**：每个项目有一个由 agent 自己维护的记忆目录 `~/.claude-pro/projects/<项目>/memory/`。它会把你的偏好、纠正过的做法、项目约束等写成一条条小文件，并在 `MEMORY.md` 里建索引；每次新会话开始时索引自动载入。直接说"记住……"或"忘掉……"即可；`/memory` 查看；`CLAUDE_PRO_DISABLE_AUTO_MEMORY=1` 关闭。

**Skills**：`<目录>/skills/<名字>/SKILL.md`，frontmatter 写 `name` 和 `description`，正文是指令。搜索 `~/.claude-pro/skills/`、`<项目>/.claude/skills/`、`<项目>/.claude-pro/skills/`（项目级覆盖用户级）。模型发现任务匹配某个 skill 的描述时会通过 `Skill` 工具自动加载它；你也可以直接用 `/<skill 名> [参数]` 调用，`/skills` 列出全部。

**子 agent**：内置 `general-purpose`、`Explore`、`Plan`；自定义 agent 放在 `.claude/agents/*.md` 或 `~/.claude-pro/agents/*.md`（frontmatter：`name`、`description`、`tools`、`model`、`effort`（low/medium/high/xhigh/max）、`autoCompactWindow`（这个 agent 自己的自动压缩窗口，token 数））。模型调用 `Task` 时也可以给单个子 agent 指定 `model`（sonnet/opus/haiku 或完整 id）和 `effort`，优先于 agent 定义里的，定义里的又优先于会话的。

**后台子 agent**：模型可以用 `Task` 的 `run_in_background: true` 把子 agent 放到后台，自己继续干别的。子 agent 完成后，结果会作为 `<task-notification>` 自动送回；如果当时主 agent 空闲，会自动开启新的一轮来处理结果。`TaskOutput` 用于提前等待结果，`TaskStop` 用于取消；`/tasks` 列出所有后台 agent，`/tasks kill agent_1` 停止其中一个。`-p` 模式会等所有后台 agent 结束后再退出。

**自动验证循环**：如果项目有明确的测试入口，claude-pro 会自动发现并使用 `package.json` 的 `test`/`check`/`verify`/`lint` 脚本，或 `pytest`、`cargo test`、`go test ./...`、`make test`。也可以显式设置验证命令（`--verify "npm test"`、会话中 `/verify npm test`，或 `CLAUDE_PRO_VERIFY_COMMAND`）；显式配置优先，`/verify off` 可关闭自动发现。只要某一轮改过文件，模型结束前就会自动运行验证命令。失败的输出会发回给模型继续修复，直到通过，最多 3 轮。没有改文件的轮次不会触发验证。

**大输出落盘**：工具结果超过 10 万字符时，全文会保存到 `~/.claude-pro/projects/<项目>/tool-results/`，只把预览和文件路径发给模型，模型可以再用 `Read`/`Grep` 按需查看。Bash 输出被截断时同样会保存全文。超过 7 天的旧文件在启动时自动清理。

**Hooks**：`settings.json` 里的 `hooks`：`PreToolUse`、`PostToolUse`、`UserPromptSubmit`、`Stop`。事件内容以 JSON 从 **stdin** 传给脚本（同时放在环境变量 `CLAUDE_PRO_HOOK_INPUT`，另有 `CLAUDE_PROJECT_DIR`）；退出码 0 = 通过（stdout 作为附加上下文），2 = 拦截（stderr 反馈给模型；`Stop` 则让模型继续干活），其他 = 仅警告。当护栏用的 hook 加上 `"onFailure": "block"`：启动不了、超时或以其他退出码结束时按拦截处理，而不是放行。hook 输出里的 `<system-reminder>` 标签会被转义，冒充不了系统提示。

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
src/commands.js       斜杠命令
```

## 其他说明

WebSearch 通过抓取 DuckDuckGo/Bing 实现。检查点只覆盖文件工具的修改，不覆盖 Bash 命令造成的改动。

提示：选中文字自动复制是终端的功能。Windows Terminal 在设置里打开“选择时自动复制”（settings.json 里的 `"copyOnSelect": true`）即可。

## 历史

旧名 ccc，最后一版保存在 git 标签 `ccc-last`。
