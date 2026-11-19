# claude-pro-lite（Windows x64）

面向 Windows Server 2008 R2 SP1 x64 的免安装试用版。在新机器编译，只把 `claude-pro-lite.exe` 拷到服务器；服务器不需要安装 Go、Node、Python 或 .NET。这个程序不依赖原版 `claude-pro`，也不读写原版的登录文件。可将带版本号的 EXE 改名为 `claude-pro-lite.exe` 后使用；运行 `claude-pro-lite.exe --version` 查看内置版本。

## 在服务器用 `cmd.exe` 测试

1. 先验证服务器能连到网关，首次使用时粘贴网关发给你的普通 API Key：

   ```bat
   claude-pro-lite.exe -check
   ```

   旧版 `cmd.exe` 可以用窗口菜单的「编辑 → 粘贴」。交互式控制台只显示较长 Key 的首尾和长度（重定向输出只显示长度），通过免费的 `GET /v1/models` 验证后，将 Key 加密保存到 EXE 同目录的 `claude-pro-lite.key`。同一个 Windows 用户、同一网关地址下，下次启动自动读取，无需再输入。更换 Key 时运行 `claude-pro-lite.exe -set-key`。不要复制或分享 Key 文件；如果 EXE 同目录不可写，请把 EXE 移到可写目录。真实模型请求按网关用量计费。

2. 选一个仅含测试文件的工作目录，启动后在 `你>` 后面输入任务，例如“看看 app.log 最后有什么报错”：

   ```bat
   claude-pro-lite.exe -dir "C:\agent-test"
   ```

   如果要测试改文件，额外加 `-edit`，并在程序显示新旧片段之后输入 `y` 才会写入。`-edit` 只支持交互式 Windows 控制台。请用副本测试：修改以同目录临时文件替换原文件，可能不保留文件单独设置的 NTFS 权限、备用数据流等元数据。

   ```bat
   claude-pro-lite.exe -dir "C:\agent-test" -edit
   ```

默认网关 `https://7bit.fun`，默认模型 `claude-sonnet-5-5`；用 `-gateway` 和 `-model` 覆盖。用 `/exit` 退出、`/new` 清空内存中的对话。用 `-p "任务"` 运行一次。非交互方式可由调用进程传入 `CLAUDE_PRO_GATEWAY_KEY`；该变量优先于已保存的 Key，且其值不会写入磁盘。不要把 Key 写在命令历史或批处理文件里；程序不接受明文 Key 参数。模型请求直接往 `/v1/messages` 发送 `Authorization: Bearer …`，没有登录步骤。

- 默认只读，模型可自行列目录、读取文本和日志末尾。单次读取最多 24 KiB，支持 UTF-8 和带 BOM 的 UTF-16；不识别 GBK 等旧编码。编辑功能只支持现有 UTF-8 文本文件，没有任意 Shell、文件删除或后台服务。
- **工具读到的文本会发送给你选择的网关。** 只指定不含敏感信息的工作目录，常见凭据文件名的过滤并不等于内容脱敏。
- 客户端使用 Go TLS 和 Windows 的证书信任配置。不关闭证书校验、不跟随重定向。如果 `-check` 报证书错误，检查系统时间、信任链和代理；401/403 则检查 API Key。

## 构建与验证（开发机）

普通最新版 Go 不支持 Windows Server 2008 R2。此版本用第三方 [`go-legacy-win7` v1.27.4-1](https://github.com/thongtech/go-legacy-win7/releases/tag/v1.27.4-1) 构建；安装或解压只发生在开发机。Windows x64 编译器 ZIP 的发布 SHA-256 为 `f8718d445d4a65590027cca434f164d665a04ee2dde96d7a3dc0abad840b6c2d`。

每次出新版本先更新本目录的 `VERSION`，再运行以下命令（Git Bash，`LEGACY_GO` 为已解压的 `go.exe` 路径）。构建会同时生成 `dist/claude-pro-lite-vX.Y.Z.exe` 和同版本的 `dist/claude-pro-lite.exe`；保留旧的带版本号产物，便于区分。

```bash
GOTOOLCHAIN=local CGO_ENABLED=0 "$LEGACY_GO" test ./...
LEGACY_GO="$LEGACY_GO" bash build.sh
```

测试使用本地模拟网关和临时文件，不需要真实 API Key。编译成功和在新版 Windows 运行不等于已通过 2008 R2 实机验收。
