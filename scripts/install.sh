#!/bin/sh
# ce 安装器(curl|sh,Ollama 式)。一行安装:
#   curl -fsSL http://<中继>:8606/install.sh | sh
# 中继地址由中继 serve 本脚本时注入 __RELAY_URL__ 占位符,用户无需填。
#
# 三层:
#   ① 探测平台 → 下对应二进制 → 装(本脚本)
#   ② ce 首跑时自探 jupyter server list(在 ce 里,不在此)
#   ③ 缺 Jupyter 则引导(在 ce 里)
set -e

RELAY='__RELAY_URL__'
DOWNLOAD_BASE=$(printf '%s' "$RELAY" | sed 's/^ws/http/')
INSTALL_DIR="${CE_INSTALL_DIR:-/usr/local/bin}"
FALLBACK_DIR="$HOME/.local/bin"
BINARY_NAME="ce"

# 探测平台:uname -s → linux;uname -m → x64/arm64
detect_platform() {
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  if [ "$os" != "linux" ]; then
    echo "[install] 只支持 Linux,当前系统: $os" >&2
    return 1
  fi
  arch_raw=$(uname -m)
  case "$arch_raw" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *)
      echo "[install] 不支持的架构: $arch_raw" >&2
      return 1
      ;;
  esac
  echo "${os}-${arch}"
}

PLATFORM=$(detect_platform) || exit 1
URL="${DOWNLOAD_BASE}/dl/${BINARY_NAME}-${PLATFORM}"
echo "[install] 平台 ${PLATFORM} → ${URL}"

# 检测 python3（软引导）
if ! command -v python3 >/dev/null 2>&1; then
  echo "[install] 未检测到 python3,请先安装:" >&2
  if command -v apt-get >/dev/null 2>&1; then
    echo "  sudo apt install python3 python3-pip" >&2
  elif command -v dnf >/dev/null 2>&1; then
    echo "  sudo dnf install python3 python3-pip" >&2
  else
    echo "  请用系统包管理器安装 python3 和 pip" >&2
  fi
  exit 1
fi

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

if ! curl -fsSL "$URL" -o "$TMP"; then
  echo "[install] 下载失败: $URL" >&2
  exit 1
fi
chmod +x "$TMP"

# 安装:优先 INSTALL_DIR 可写,否则回退 ~/.local/bin
TARGET_DIR=""
if mkdir -p "$INSTALL_DIR" 2>/dev/null && [ -w "$INSTALL_DIR" ]; then
  TARGET_DIR="$INSTALL_DIR"
else
  echo "[install] 无权限写 $INSTALL_DIR,改用 $FALLBACK_DIR" >&2
  TARGET_DIR="$FALLBACK_DIR"
  mkdir -p "$TARGET_DIR"
fi
TARGET="${TARGET_DIR}/${BINARY_NAME}"
cp "$TMP" "$TARGET"
chmod +x "$TARGET"

# 写 ~/.ce/config.json (relay)
CE_DIR="$HOME/.ce"
mkdir -p "$CE_DIR"
CONFIG="$CE_DIR/config.json"
printf '{"relay":"%s"}\n' "$RELAY" > "$CONFIG"
echo "[install] 已写入配置: $CONFIG"

# 提示 PATH
case ":$PATH:" in
  *":$TARGET_DIR:"*) ;;
  *) echo "[install] 请把 $TARGET_DIR 加进 PATH,或重启终端" ;;
esac

# 问开机自启(软引导,systemd 可用则装)
ASK_FROM_TTY() {
  sh -c 'read ans </dev/tty; echo "$ans"' || echo "n"
}
echo "[install] 是否开机自启?(systemd user service) [y/N]"
if [ "y" = "$(ASK_FROM_TTY | tr '[:upper:]' '[:lower:]')" ]; then
  if command -v systemctl >/dev/null 2>&1 && systemctl --user list-unit-files >/dev/null 2>&1; then
    SERVICE_DIR="$HOME/.config/systemd/user"
    mkdir -p "$SERVICE_DIR"
    SERVICE_FILE="$SERVICE_DIR/ce.service"
    cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Coding Everywhere CE (Relay Client)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$TARGET
Restart=always

[Install]
WantedBy=default.target
EOF
    echo "[install] 已写入服务: $SERVICE_FILE"
    systemctl --user enable ce.service 2>/dev/null && echo "[install] 已启用开机自启"
    if command -v loginctl >/dev/null 2>&1; then
      loginctl enable-linger "$(whoami)" 2>/dev/null && echo "[install] 已启用 linger (未登录时也跑)"
    fi
  else
    echo "[install] systemd 不可用,跳过开机自启" >&2
  fi
fi

# 启动 ce (前台,接回 tty)
echo "[install] 启动 ce..."
exec "$TARGET" </dev/tty
