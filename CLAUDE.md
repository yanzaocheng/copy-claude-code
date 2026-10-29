# claude-pro 开发说明(给在本仓库工作的 agent)

本仓库就是 claude-pro 自身(Node 24 ESM,Windows + Git Bash 开发)。claude-pro 在这里工作时,运行的就是这份代码。例外:`bin/claude-pro.js` 和 `src/supervisor.js` 属于正在运行的监督进程,改了它们,Restart 和自动重启都不会加载,只有用户手动重新启动才生效。

## 验证

不设固定的测试流程。根据改动风险和用户目标自行决定是否运行检查或测试，避免把测试作为每次修改的必经步骤。

## 改完就提交(用户的要求,2026-10-12)

每完成一项改动、检查通过后,马上 `git commit`,只提交到本地,不必等用户说"提交"。原因是别的程序(例如官方 Claude Code 的 `/rewind` 恢复代码)可能改动文件,每次都提交了,`git status` / `git diff` 就能一眼看出是谁改的。`git status` 里有不是自己改的改动,不要一起提交,先查清来源并告诉用户。`git push` 和 `npm publish` 仍然要等用户说"发布"。

## 省时间的事实

- Node 把 `/tmp/x` 解析成当前盘的 `D:\tmp\x`(Git Bash 的 `/tmp` 其实是 `os.tmpdir()`):给 node 脚本传临时路径用 `C:/Users/...` 形式。claude-pro 自己的工具(Read、Edit、Grep 等)按 Git Bash 的挂载表转换 `/tmp`、`/usr` 这类路径。
- 没有测试套件(2026-10-20 移除)。要在假终端里驱动真实 App,照 `src/selfcheck.js` 的做法:PassThrough 当 stdin、Writable 当 stdout,`new App({..., selfCheck: true})`。
- 临时测试脚本绝不能碰真实的 `~/.claude-pro`:在 import `src/` 之前把 `CLAUDE_PRO_CONFIG_DIR` 指到临时目录;用到网关时把 `CLAUDE_PRO_GATEWAY_URL` 指向不存在的地址(或本地的假网关),并在那个临时目录里写一个 `gateway.json`(`{"url": 和 CLAUDE_PRO_GATEWAY_URL 相同, "apiKey": "test"}`;key 只从这里读,没有环境变量),或者替换 `globalThis.fetch`。
- 改系统提示词(`src/prompts.js`、`src/context.js`)或任何工具说明,重启后整段对话都要重写一次提示词缓存。几处这类改动尽量攒到一次重启。
