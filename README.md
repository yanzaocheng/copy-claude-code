# claude-pro

`claude-pro` 是一个启动器：它运行官方的 `claude` 命令（Claude Code），由官方 CLI 自己使用本机已登录的订阅账号。本项目**不读取、不保存**任何登录凭据。

在官方 Claude Code 之上，它加了这些默认设置：

- **不再逐个确认权限**：自动加上 `--dangerously-skip-permissions`。加 `--safe` 可以恢复确认。
- **追加 pro 系统提示**：让模型更自主地把任务做完，先验证再汇报（见 `src/pro-prompt.js`）。你的个人补充写在 `~/.claude-pro.md`，会自动追加在后面。
- **只走订阅登录**：从子进程环境里去掉 `ANTHROPIC_BASE_URL`、API key、模型覆盖等变量，避免误走第三方端点或按量计费的 key。加 `--keep-env` 可以保留这些变量。

其余参数原样传给 `claude`，所以官方的所有功能（子 agent、MCP、hooks、skills、`/rewind` 等）都可以直接用。

## 安装

需要 Node.js 18+，并且已经安装官方 Claude Code、在 `claude` 里登录过一次。

```bash
npm i -g @anthropic-ai/claude-code   # 如果还没装
claude                               # 第一次运行时用订阅账号登录
cd D:\d\node\copy-claude-code
npm link                             # 注册全局命令 claude-pro
```

本项目没有任何 npm 依赖，只用 Node 内置模块。

## 使用

```bash
claude-pro                    # 交互模式
claude-pro -c                 # 继续上一次会话
claude-pro -p "解释一下 src/launcher.js"
claude-pro --safe             # 保留权限确认
claude-pro --which            # 查看实际调用的 claude 可执行文件
claude-pro --pro-help         # claude-pro 自己的参数说明
```

| claude-pro 参数 | 作用 |
|---|---|
| `--safe` | 不加 `--dangerously-skip-permissions`，保留权限确认 |
| `--keep-env` | 不清理 `ANTHROPIC_*` 端点、key、模型相关的环境变量 |
| `--no-prompt` | 不追加 pro 系统提示 |
| `--which` | 打印实际使用的 `claude` 路径后退出 |
| `--pro-help` | 显示帮助 |

如果你自己传了 `--permission-mode`、`--system-prompt` 或 `--append-system-prompt`，就以你的为准，不再加对应的默认值。

找不到 `claude` 时，可以用环境变量 `CLAUDE_PRO_BIN` 指定官方可执行文件的路径。

## 开发

```bash
npm test
```

```
bin/claude-pro.js     入口
src/launcher.js       参数处理、环境清理、查找并启动官方 claude
src/pro-prompt.js     追加的 pro 系统提示
test/                 测试（node:test）
```

## 历史

这个仓库原本是 `ccc`：一个自己实现的 Claude Code 风格 agent，接 DeepSeek 等兼容 Anthropic 的 API。它已经移除，最后的版本保存在 git 标签 `ccc-last`：

```bash
git checkout ccc-last          # 查看当时的完整代码
```
