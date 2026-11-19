# claude-pro-lite（Windows x64）

面向 Windows Server 2008 R2 SP1 / Windows 7 x64 的免安装简易 Agent。只需一个 EXE：服务器不需要安装 Go、Node、Python 或 .NET。不依赖原版 `claude-pro`。构建产物带版本号（`claude-pro-lite-vX.Y.Z.exe`），可改名为 `claude-pro-lite.exe` 使用；启动时第一行显示版本，`--version` 也可查看。

## 使用

1. 把 EXE 放到一个可写的目录，双击运行（或在 `cmd.exe` 中运行）。
2. 首次启动会在 EXE 同级目录生成配置文件 `claude-pro-lite.json`，并显示它的完整路径。
3. 按提示粘贴网关 API Key（输入可见）。程序先用免费的 `GET /v1/models` 验证；输错了会提示原因并让你重新输入，不会退出。验证通过后 Key 保存到配置文件，下次启动直接使用。
4. 在 `你>` 后输入任务，例如“看看 app.log 最后有什么报错”“查一下 3306 端口被哪个进程占用”。

配置文件（JSON，可用记事本修改）：

```json
{
  "gateway": "https://7bit.fun",
  "model": "claude-sonnet-5-5",
  "apiKey": "",
  "workDir": "",
  "readOnly": false,
  "confirm": false,
  "noThinking": false
}
```

- `apiKey` 以明文保存，不要分享该文件。也可以直接在这里粘贴 Key；如果 Key 不能用，启动时会提示重新输入并覆盖。
- `workDir`：工作目录，空表示当前目录（双击时就是 EXE 所在目录）。
- `readOnly`：设为 `true` 后只能列目录、读文件，不能改文件或执行命令。
- `noThinking`：默认 `false`，程序会向模型请求思考过程，并以「〔思考〕」开头显示出来。设为 `true`（或加 `-no-thinking`）则不请求、不显示。
- `confirm`：默认 `false`，改文件和执行命令都直接做，不再询问。设为 `true` 则每次修改和命令都先显示内容，输入 `y` 才执行。

命令行参数会覆盖配置文件：`-gateway`、`-model`、`-dir`、`-read-only`、`-confirm`、`-config 路径`；`-check` 只检查 Key 和网络；`-set-key` 重新输入 Key；`-p "任务"` 执行一次。环境变量 `CLAUDE_PRO_GATEWAY_KEY` 的值优先于配置文件，且不写入磁盘。

网关限流（HTTP 429）、上游过载或连接失败时，程序会按 `Retry-After` 或逐步加长的间隔（1、2、4、8 秒）自动重试，最多 4 次，并显示“自动重试”提示；键无效或余额不足不会重试。

对话中的命令：`/help`、`/new` 清空对话、`/model 模型ID` 切换并保存模型、`/models` 列出可用模型、`/config` 显示配置文件位置、`/prompt` 查看实际发送的系统提示词、`/exit` 退出。按 Ctrl+C 只停止当前回答，不会退出程序。

## Agent 能做什么

- 列目录、读文件（单次最多 24 KiB，可读日志末尾；支持 UTF-8、带 BOM 的 UTF-16，以及系统 ANSI 编码，中文系统即 GBK）。
- 新建文件（LF 转为 CRLF），修改已有文件中的一段文字（UTF-8 或 GBK 文件，保持原编码）。
- 通过 `cmd.exe` 执行命令：在工作目录中运行，标准输入为空，默认 120 秒超时（最多 600 秒）。超时或按 Ctrl+C 会结束整个进程树。命令输出按 UTF-8、UTF-16 或控制台代码页（GBK）解码。

默认自动执行：模型想改文件或运行命令时，程序先显示要做什么，然后直接做，不再停下来问（把配置里的 `confirm` 设为 `true` 可恢复询问；询问时输入 `a` 表示本次运行都不再问，且只有坐在控制台前的人能确认）。

**注意：**文件读取限制在工作目录内，但命令可以访问整台电脑，确认前请看清命令。读到的文件内容和命令输出都会发给网关；模型调用按网关用量计费。

## 旧系统兼容

- 用第三方 `go-legacy-win7` 工具链构建，EXE 的最低系统版本标记为 6.1（Windows 7 / Server 2008 R2）。
- HTTPS 先用 Windows 的证书库验证。未更新根证书的旧系统验证失败时，再用内置的 Let's Encrypt ISRG Root X1/X2 根证书（`roots.pem`，已核对官方 SHA-256 指纹）验证网关证书。证书校验始终开启，不跟随重定向。
- 配置文件和新建文件使用 CRLF 换行，旧版记事本能正常显示。读取配置文件时兼容记事本保存的 UTF-8 BOM。
- 双击运行时，如果遇到无法继续的错误，窗口会停留并显示错误，按回车后关闭。

## 系统提示词

内置的系统提示词（运行环境、工具规则、纯文本输出）写在程序里。自己的要求写在配置文件同目录的 `claude-pro-lite-prompt.txt`：第一次启动时自动生成一个带说明的模板，启动时显示它的路径和是否生效。其中的内容追加在内置提示词后面，并优先于内置的默认做法；以 `#` 开头的行是注释，不发送。文件每次提问都重新读取，保存后下一条消息生效，不用重启。记事本存成 ANSI（GBK）、UTF-8 或 Unicode 都可以。

## 构建与验证（开发机）

普通最新版 Go 不支持 Windows Server 2008 R2。本程序使用第三方 [`go-legacy-win7` v1.27.4-1](https://github.com/thongtech/go-legacy-win7/releases/tag/v1.27.4-1) 构建，只需在开发机安装。Windows x64 编译器 ZIP 的发布 SHA-256 为 `f8718d445d4a65590027cca434f164d665a04ee2dde96d7a3dc0abad840b6c2d`。

每次出新版本前，先更新本目录的 `VERSION`，再运行以下命令（Git Bash；`LEGACY_GO` 为已解压的 `go.exe` 路径）。构建会生成 `dist/claude-pro-lite-vX.Y.Z.exe`，以及内容相同的 `dist/claude-pro-lite.exe`。

```bash
GOTOOLCHAIN=local CGO_ENABLED=0 "$LEGACY_GO" test ./...
LEGACY_GO="$LEGACY_GO" bash build.sh
```

测试使用本地模拟网关和临时文件，不需要真实 API Key。GBK 相关测试只在中文 Windows 上运行。在新版 Windows 上通过测试，不等于已在 2008 R2 实机上验收。
