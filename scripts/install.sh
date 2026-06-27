#!/bin/sh
# ce 安装器(curl|sh,Ollama 式)。一行安装:
#   curl -fsSL https://你的中继/install.sh | sh
# 自定义下载源/安装目录(测试或自建中继时):
#   CE_DOWNLOAD_BASE=http://host:port CE_INSTALL_DIR=/tmp/x sh install.sh
#
# 三层(见设计 §7):
#   ① 探测 OS/架构 → 下对应单文件二进制 → 装(本脚本)
#   ② ce 首跑时自探 `jupyter server list`(在 ce 里,不在此)
#   ③ 缺 Jupyter 则引导(在 ce 里)
set -e

DOWNLOAD_BASE="${CE_DOWNLOAD_BASE:-https://relay.example.com/dl}"
INSTALL_DIR="${CE_INSTALL_DIR:-/usr/local/bin}"
BINARY_NAME="ce"

# 探测平台:uname -s → linux/darwin;uname -m → x64/arm64
detect_platform() {
  os=$(uname -s | tr '[:upper:]' '[:lower:]') # Linux→linux, Darwin→darwin
  arch_raw=$(uname -m)
  case "$arch_raw" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) echo "[install] 不支持的架构: $arch_raw" >&2; return 1 ;;
  esac
  echo "${os}-${arch}"
}

PLATFORM=$(detect_platform)
if [ -z "$PLATFORM" ]; then exit 1; fi
URL="${DOWNLOAD_BASE}/${BINARY_NAME}-${PLATFORM}"
echo "[install] 平台 ${PLATFORM} → ${URL}"

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

if ! curl -fsSL "$URL" -o "$TMP"; then
  echo "[install] 下载失败: $URL" >&2
  exit 1
fi
chmod +x "$TMP"

# 装:INSTALL_DIR 可写则用;否则回退 ~/.local/bin
if ! (mkdir -p "$INSTALL_DIR" 2>/dev/null && [ -w "$INSTALL_DIR" ]); then
  echo "[install] 无权限写 $INSTALL_DIR,改用 ~/.local/bin(请确保它在 PATH)" >&2
  INSTALL_DIR="$HOME/.local/bin"
  mkdir -p "$INSTALL_DIR"
fi
TARGET="${INSTALL_DIR}/${BINARY_NAME}"
cp "$TMP" "$TARGET"
chmod +x "$TARGET"

echo "[install] 已安装: $TARGET"
echo "运行: ${BINARY_NAME} --relay=ws://your-relay"
