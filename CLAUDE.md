# claude-pro 开发说明(给在本仓库工作的 agent)

本仓库就是 claude-pro 自身(Node 24 ESM,Windows + Git Bash 开发)。claude-pro 在这里工作时,运行的就是这份代码。例外:`bin/claude-pro.js` 和 `src/supervisor.js` 属于正在运行的监督进程,改了它们,Restart 和自动重启都不会加载,只有用户手动重新启动才生效。

## 验证命令(由便宜到贵)

1. `node --check <file>`:瞬间。
2. `npm run check`:在假终端里把整个程序启动一遍,约 1 秒。Restart 前也会自动跑同样的检查。
3. 相关测试文件,如 `node --test --test-force-exit --test-reporter=dot test/oauth.test.js`,几秒。要用 dot 报告器:它只在失败时打印细节,而默认的 TAP 输出全量约 1.5 万 token,读进上下文后每轮都要重读。不确定是哪些文件,就在 `test/` 里 grep 改动的函数名或命令名。
4. `npm test`:全部约 280 项,约 15 秒,已经用 dot 报告器。共享代码指 `api.js`、`agent.js`、`config.js`、`runtime.js`、`ui/repl.js`、`ui/screen.js`、`tools/`、`utils/shell.js`。

## 改完就提交(用户的要求,2026-10-12)

每完成一项改动、检查通过后,马上 `git commit`,只提交到本地,不必等用户说"提交"。原因是别的程序(例如官方 Claude Code 的 `/rewind` 恢复代码)可能改动文件,每次都提交了,`git status` / `git diff` 就能一眼看出是谁改的。`git status` 里有不是自己改的改动,不要一起提交,先查清来源并告诉用户。`git push` 和 `npm publish` 仍然要等用户说"发布"。

## 省时间的事实

- Git Bash 的 `/tmp` 不是 Node 的 `os.tmpdir()`:给 node 传临时路径用 `C:/Users/...` 形式。
- TUI 测试用无头 xterm 驱动真实 App(`test/tui-harness.js`),默认关掉话题标题请求。
- 测试绝不能碰真实的 `~/.claude-pro` 和 `~/.claude`:在 import `src/` 之前把 `CLAUDE_PRO_CONFIG_DIR` 和凭据路径指到临时目录;OAuth 测试把 `endpoint.url` 指向不存在的地址。
- 改系统提示词(`src/prompts.js`、`src/context.js`)或任何工具说明,重启后整段对话都要重写一次提示词缓存。几处这类改动尽量攒到一次重启。
