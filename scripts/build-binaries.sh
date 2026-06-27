#!/bin/sh
# 编译 ce 的四个平台单文件二进制(Bun --compile,无运行时依赖)。
# 产物在 ce-server/dist/ce-{linux,darwin}-{x64,arm64}(gitignored;部署时上传到中继 /dl/)。
# 参考 Ollama 分发模型:一个文件、无运行时,curl|sh 即用。
set -e
cd "$(dirname "$0")/.." # → ce-server/

mkdir -p dist
ENTRY="src/cli/main.ts"

for target in bun-linux-x64 bun-linux-arm64 bun-darwin-x64 bun-darwin-arm64; do
  name="ce-${target#bun-}" # bun-linux-x64 → ce-linux-x64
  echo "[build] $target → dist/$name"
  bun build "$ENTRY" --compile --target="$target" --outfile="dist/$name"
done

echo "[build] 完成:"
ls -lh dist/
