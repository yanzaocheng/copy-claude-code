# claude-pro 开发说明(给在本仓库工作的 agent)

本仓库就是 claude-pro 自身(Node 24 ESM,Windows + Git Bash 开发)。正在工作的会话运行的就是这份代码:改了 `src/` 或 `bin/` 后调用 Restart 工具让改动生效(它会先在临时进程里启动新代码检查),不要让用户手动重启。`bin/claude-pro.js` 和 `src/supervisor.js` 只有手动重新启动才生效。

## 验证改动:先做最便宜的检查

1. 每个改过的文件 `node --check <file>`(瞬间)。
2. `npm run check`:在假终端里把整个程序启动一遍(约 1 秒)。
3. 只跑改动所在领域的测试文件,如 `node --test --test-force-exit test/oauth.test.js`(几秒)。不确定是哪些文件就在 `test/` 里 grep 改动的函数名或命令名。
4. `npm test`(全部约 280 项,约 15 秒):只在一次改动的最后跑一次,条件是改了共享代码(`api.js`、`agent.js`、`config.js`、`runtime.js`、`ui/repl.js`、`ui/screen.js`、`tools/`、`utils/shell.js`)或改了很多文件;可以放到后台跑,同时写文档。只改文档,或小改动的相关测试已经通过,就不跑。

现有测试保留:它们很快,守着用户依赖的行为。改动有意改变行为时,改断言,不要为了通过而删测试。除非用户要求,或改动有风险(会丢数据、涉及凭据、会杀进程),否则不做变异检查、不开审查子 agent、不新增测试文件。

## 省时间的事实

- Git Bash 的 `/tmp` 不是 Node 的 `os.tmpdir()`:给 node 传临时路径用 `C:/Users/...` 形式。
- TUI 测试用无头 xterm 驱动真实 App(`test/tui-harness.js`),默认关掉话题标题请求。
- 测试绝不能碰真实的 `~/.claude-pro` 和 `~/.claude`:在 import `src/` 之前把 `CLAUDE_PRO_CONFIG_DIR` 和凭据路径指到临时目录;OAuth 测试把 `endpoint.url` 指向不存在的地址。
