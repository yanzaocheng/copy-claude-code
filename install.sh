#!/bin/sh
# claude-pro installer for Linux and macOS:
#
#   curl -fsSL https://7bit.fun/claude-pro/install.sh | sh
#
# With Node.js 22 or later already installed (and npm's global directory writable), it installs claude-pro with that
# npm. Otherwise it puts a portable Node.js 24 in ~/.claude-pro/runtime (checked against the official SHA256 list) for
# claude-pro alone, and only the claude-pro command goes on PATH: the system's node is left as it is. Run it again to
# update or repair. Where nodejs.org cannot be reached quickly (China), Node and the package come from npmmirror.
#
# Options, as environment variables:
#   CLAUDE_PRO_MIRROR=npmmirror|official   where to download from (default: decided by a quick probe)
#   CLAUDE_PRO_USE_RUNTIME=1               the portable Node even when a usable one is installed
#   CLAUDE_PRO_NO_MODIFY_PATH=1            do not add ~/.claude-pro/bin to the shell's startup files
#   CLAUDE_PRO_NO_SHORTCUT=1               no 「claude-pro 控制台」 in the app menu (Linux desktops)
#   CLAUDE_PRO_CONFIG_DIR=<dir>            instead of ~/.claude-pro (claude-pro reads it too)
#
# The source of this file is install.sh in https://github.com/yanzaocheng/copy-claude-code (7bit.fun serves a copy).
set -eu

PKG="@yanzc/claude-pro"
NODE_MAJOR=24
MIN_MAJOR=22
ROOT="${CLAUDE_PRO_CONFIG_DIR:-$HOME/.claude-pro}"
RUNTIME="$ROOT/runtime"
BIN_DIR="$ROOT/bin"
MARK="# added by the claude-pro installer"

if [ -t 1 ]; then BOLD=$(printf '\033[1m'); RED=$(printf '\033[31m'); DIM=$(printf '\033[2m'); RESET=$(printf '\033[0m'); else BOLD=; RED=; DIM=; RESET=; fi
step() { printf '%s==> %s%s\n' "$BOLD" "$*" "$RESET"; }
note() { printf '    %s\n' "$*"; }
die() { printf '%s错误：%s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

# fetch URL FILE: follows redirects (npmmirror answers with one), fails on HTTP errors
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 2 --connect-timeout 15 -o "$2" "$1"; }
  probe() { curl -fsS -o /dev/null --max-time 4 "$1" >/dev/null 2>&1; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
  probe() { wget -q -O /dev/null -T 4 -t 1 "$1" >/dev/null 2>&1; }
else
  die "需要 curl 或 wget 才能下载"
fi

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) die "不支持这个系统（$(uname -s)）。Windows 请在 PowerShell 里运行：irm https://7bit.fun/claude-pro/install.ps1 | iex" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "不支持这个处理器架构（$(uname -m)）" ;;
esac
# an Apple Silicon Mac in a shell running under Rosetta reports x86_64: the native build is the right one
if [ "$OS" = darwin ] && [ "$ARCH" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then ARCH=arm64; fi

case "${CLAUDE_PRO_MIRROR:-auto}" in
  npmmirror|cn|china) MIRROR=1 ;;
  official) MIRROR=0 ;;
  *) if probe https://www.google.com; then MIRROR=0; else MIRROR=1; fi ;;
esac
if [ "$MIRROR" = 1 ]; then
  NODE_BASE=https://npmmirror.com/mirrors/node
  REGISTRY=https://registry.npmmirror.com
else
  NODE_BASE=https://nodejs.org/dist
  REGISTRY=https://registry.npmjs.org
fi

if [ "$(id -u)" = 0 ]; then note "${DIM}提示：正在用 root 安装。claude-pro 能执行任何命令，在服务器上建议用一个专用的普通用户来装和运行。${RESET}"; fi

major_of() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
# npm can create the directory: the nearest one that exists is writable (a new prefix has no lib or bin yet)
writable_dir() {
  p=$1
  while [ ! -e "$p" ]; do p=$(dirname "$p"); done
  [ -d "$p" ] && [ -w "$p" ]
}

# ---------------------------------------------------------------- with the Node.js already installed
USE_SYSTEM=0
if [ "${CLAUDE_PRO_USE_RUNTIME:-0}" != 1 ] && command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  if [ "$(major_of node)" -ge "$MIN_MAJOR" ]; then
    PREFIX=$(npm prefix -g 2>/dev/null || true)
    if [ -n "$PREFIX" ] && writable_dir "$PREFIX/lib/node_modules" && writable_dir "$PREFIX/bin"; then USE_SYSTEM=1; fi
  fi
fi

if [ "$USE_SYSTEM" = 1 ]; then
  step "用已安装的 Node.js $(node -v) 安装 claude-pro"
  npm install -g "$PKG" --registry "$REGISTRY" --no-fund --no-audit --loglevel=error
  # a portable install from before would come first on PATH: this one replaces it
  if [ -f "$BIN_DIR/claude-pro" ] && grep -q "$MARK" "$BIN_DIR/claude-pro" 2>/dev/null; then rm -f "$BIN_DIR/claude-pro"; fi
  CMD=$(command -v claude-pro || echo "$PREFIX/bin/claude-pro")
else
  # ---------------------------------------------------------------- a portable Node.js for claude-pro alone
  if [ "$OS" = linux ] && { ldd --version 2>&1 | grep -qi musl || ls /lib/ld-musl-* >/dev/null 2>&1; }; then
    die "这个系统用的是 musl libc（如 Alpine），官方 Node.js 不能直接运行。请先装 Node.js $MIN_MAJOR 以上（Alpine：apk add nodejs npm），再运行这个脚本。"
  fi
  NODE_DIR="$RUNTIME/node"
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  trap 'exit 130' INT TERM
  if [ -x "$NODE_DIR/bin/node" ] && [ "$(major_of "$NODE_DIR/bin/node")" = "$NODE_MAJOR" ]; then
    step "使用已下载的 Node.js $("$NODE_DIR/bin/node" -v)（$NODE_DIR）"
  else
    step "下载 Node.js $NODE_MAJOR（$OS-$ARCH，来自 ${NODE_BASE%%/mirrors*}）"
    fetch "$NODE_BASE/index.json" "$TMP/index.json"
    VER=$(grep -o "\"version\": *\"v$NODE_MAJOR\.[0-9]*\.[0-9]*\"" "$TMP/index.json" | head -n 1 | sed 's/.*"\(v[0-9.]*\)"/\1/')
    [ -n "$VER" ] || die "在 $NODE_BASE/index.json 里没有找到 Node.js $NODE_MAJOR"
    FILE="node-$VER-$OS-$ARCH.tar.gz"
    fetch "$NODE_BASE/$VER/SHASUMS256.txt" "$TMP/SHASUMS256.txt"
    WANT=$(grep " $FILE\$" "$TMP/SHASUMS256.txt" | head -n 1 | cut -d ' ' -f 1)
    [ -n "$WANT" ] || die "SHASUMS256.txt 里没有 $FILE"
    note "$FILE"
    fetch "$NODE_BASE/$VER/$FILE" "$TMP/$FILE"
    if command -v sha256sum >/dev/null 2>&1; then GOT=$(sha256sum "$TMP/$FILE" | cut -d ' ' -f 1); else GOT=$(shasum -a 256 "$TMP/$FILE" | cut -d ' ' -f 1); fi
    [ "$GOT" = "$WANT" ] || die "下载的 $FILE 校验不通过（SHA256 不一致），请重试"
    tar -xzf "$TMP/$FILE" -C "$TMP"
    mkdir -p "$RUNTIME"
    rm -rf "$NODE_DIR.old"
    if [ -d "$NODE_DIR" ]; then mv "$NODE_DIR" "$NODE_DIR.old"; fi
    mv "$TMP/node-$VER-$OS-$ARCH" "$NODE_DIR"
    rm -rf "$NODE_DIR.old"
  fi
  # this Node's own npm settings (its built-in npmrc): the global directory is its own, the registry the one chosen;
  # /update uses them too. Nothing of the user's npm configuration is touched.
  printf 'prefix=%s\nregistry=%s/\nupdate-notifier=false\nfund=false\naudit=false\n' "$NODE_DIR" "$REGISTRY" > "$NODE_DIR/lib/node_modules/npm/npmrc"
  step "安装 claude-pro"
  PATH="$NODE_DIR/bin:$PATH" "$NODE_DIR/bin/npm" install -g "$PKG" --prefix "$NODE_DIR" --loglevel=error
  # (where the prefix puts it; not `npm root -g`, whose output npm masks where a path looks like a token)
  ENTRY="$NODE_DIR/lib/node_modules/$PKG/bin/claude-pro.js"
  [ -f "$ENTRY" ] || die "安装后没有找到 $ENTRY"
  # the command: this Node runs it (npm's own link would take the first node on PATH)
  mkdir -p "$BIN_DIR"
  cat > "$BIN_DIR/claude-pro" <<EOF
#!/bin/sh
$MARK: claude-pro with the Node.js in $NODE_DIR
exec "$NODE_DIR/bin/node" "$ENTRY" "\$@"
EOF
  chmod +x "$BIN_DIR/claude-pro"
  CMD="$BIN_DIR/claude-pro"

  # ~/.claude-pro/bin on PATH: in the startup files of the shells the user has, once
  if [ "${CLAUDE_PRO_NO_MODIFY_PATH:-0}" != 1 ]; then
    LINE="export PATH=\"$BIN_DIR:\$PATH\" $MARK"
    add_line() {
      if [ -f "$1" ] && grep -qF "$MARK" "$1" 2>/dev/null; then return 0; fi
      printf '\n%s\n' "$LINE" >> "$1"
      CHANGED="$CHANGED $1"
    }
    CHANGED=""
    for rc in "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
      if [ -f "$rc" ]; then add_line "$rc"; fi
    done
    case "${SHELL:-}" in
      */zsh) add_line "$HOME/.zshrc" ;;
      */bash) if [ "$OS" = darwin ]; then add_line "$HOME/.bash_profile"; else add_line "$HOME/.bashrc"; fi ;;
      */fish) mkdir -p "$HOME/.config/fish/conf.d"; printf 'fish_add_path %s %s\n' "$BIN_DIR" "$MARK" > "$HOME/.config/fish/conf.d/claude-pro.fish"; CHANGED="$CHANGED ~/.config/fish/conf.d/claude-pro.fish" ;;
      *) add_line "$HOME/.profile" ;;
    esac
    if [ -n "$CHANGED" ]; then note "已把 $BIN_DIR 加进 PATH：$CHANGED"; fi
  fi
fi

VERSION=$("$CMD" --version 2>/dev/null || true)
[ -n "$VERSION" ] || die "claude-pro 装好了但运行不起来：$CMD --version 没有输出"

# 「claude-pro 控制台」 in the app menu of a Linux desktop (not on a server: no display): `claude-pro web --app` starts the
# web console when it is not running and opens it in a window of its own. On macOS the browser installs it (安装).
SHORTCUT=""
if [ "$OS" = linux ] && [ "${CLAUDE_PRO_NO_SHORTCUT:-0}" != 1 ] && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  if [ "$USE_SYSTEM" = 1 ]; then PKG_DIR="$PREFIX/lib/node_modules/$PKG"; else PKG_DIR="$NODE_DIR/lib/node_modules/$PKG"; fi
  APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$APPS"
  cat > "$APPS/claude-pro.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=claude-pro 控制台
Comment=claude-pro 的网页控制台
Exec="$CMD" web --app
Icon=$PKG_DIR/src/web/icon-512.png
Terminal=false
Categories=Development;
EOF
  SHORTCUT="$APPS/claude-pro.desktop"
fi

if ! command -v git >/dev/null 2>&1; then note "提示：没有找到 git，建议装上（Linux：apt install git，macOS：xcode-select --install）"; fi
if ! command -v rg >/dev/null 2>&1; then note "${DIM}提示：装上 ripgrep 后搜索代码会快很多（apt install ripgrep / brew install ripgrep）${RESET}"; fi

printf '\n%sclaude-pro %s 已安装%s\n' "$BOLD" "$VERSION" "$RESET"
case ":$PATH:" in
  *":$(dirname "$CMD"):"*) note "1. 进入你的项目目录，运行：claude-pro" ;;
  *) note "1. 重新打开终端（让 PATH 生效），进入项目目录运行：claude-pro"
     note "   （不想重开也可以直接运行 $CMD）" ;;
esac
note "2. 第一次启动会打开 /connect：选择 7bit.fun，粘贴在 https://7bit.fun/user 创建的 API Key"
if [ -n "$SHORTCUT" ]; then
  note "3. 网页控制台：应用菜单里的「claude-pro 控制台」，或在 claude-pro 里输入 /web"
elif [ "$OS" = darwin ]; then
  note "3. 网页控制台：运行 claude-pro web；在 Chrome / Edge 里点地址栏的「安装」，就能放进程序坞、像应用一样打开"
else
  note "3. 想用网页控制台：在 claude-pro 里输入 /web，或运行 claude-pro web"
fi
