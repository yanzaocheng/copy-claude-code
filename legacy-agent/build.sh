#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

: "${LEGACY_GO:?请将 LEGACY_GO 设置为 go-legacy-win7 的 go.exe 路径}"
read -r version < VERSION
version=${version%$'\r'}
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf 'VERSION 必须为 X.Y.Z\n' >&2
  exit 1
fi

mkdir -p dist
artifact="dist/claude-pro-lite-v${version}.exe"
GOTOOLCHAIN=local CGO_ENABLED=0 GOOS=windows GOARCH=amd64 GOAMD64=v1 \
  "$LEGACY_GO" build -trimpath -buildvcs=false -ldflags='-s -w' -o "$artifact" .
cp -- "$artifact" dist/claude-pro-lite.exe
printf '%s\n' "$artifact" dist/claude-pro-lite.exe
