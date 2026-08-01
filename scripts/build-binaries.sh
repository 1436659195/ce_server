#!/bin/sh
# 编译 ce 的四个平台单文件二进制(Bun --compile,无运行时依赖)。
# 产物在 ce-server/dist/ce-{linux,darwin,windows}-{x64,arm64}[.exe](gitignored;部署时上传到中继 /dl/)。
# 参考 Ollama 分发模型:一个文件、无运行时,curl|sh 即用。
set -e
cd "$(dirname "$0")/.." # → ce-server/

mkdir -p dist
ENTRY="src/cli/main.ts"
# 版本号(注入 binary,控制台「查版本」用):取 package.json version,失败回退 dev。
VERSION="v$(sed -n 's/.*"version"[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -1)"
[ -z "$VERSION" ] && VERSION="vdev"

for target in bun-linux-x64 bun-linux-arm64 bun-darwin-x64 bun-darwin-arm64 bun-windows-x64; do
  name="ce-${target#bun-}" # bun-linux-x64 → ce-linux-x64
  case "$target" in bun-windows-*) name="$name.exe" ;; esac # Windows 要 .exe
  echo "[build] $target → dist/$name"
  bun build "$ENTRY" --compile --target="$target" --outfile="dist/$name" --define "CE_VERSION=\"$VERSION\""
done

# 聚合 sha256 清单(install.sh/ps1 据此判更新,比 size 可靠:同 size 不同内容也检出)。
# sha256sum 标准格式 "<hash>  <filename>";install 用 awk/正则按平台名取对应 hash。
( cd dist && sha256sum ce-linux-x64 ce-linux-arm64 ce-darwin-x64 ce-darwin-arm64 ce-windows-x64.exe ) > dist/sha256.txt
echo "[build] sha256 清单 → dist/sha256.txt"

echo "[build] 完成:"
ls -lh dist/
