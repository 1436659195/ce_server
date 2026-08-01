#!/usr/bin/env bash
# ce-server relay 一键启动脚本。
#
# 配置读 ./.env(从 .env.example 复制后填写);日志追加到 ./relay.log;PID 记 ./.relay.pid。
# 用法:
#   ./start.sh           启动(后台运行)
#   ./start.sh stop      停止(优雅退出,等不到再强杀)
#   ./start.sh restart   重启
#   ./start.sh status    看是否在跑
#   ./start.sh logs      跟踪日志(Ctrl+C 退出跟踪,不影响 relay)
set -euo pipefail

# 切到脚本所在目录(=仓库根),保证 relay-state.json 落在固定位置(与 docs/ops.md 约定一致)。
cd "$(dirname "$0")"

ENV_FILE=".env"
PID_FILE=".relay.pid"
LOG_FILE="relay.log"

# ---- 读取配置 ----
if [ ! -f "$ENV_FILE" ]; then
  echo "✗ 找不到配置文件 $ENV_FILE。"
  echo "  请先复制模板并填写:  cp .env.example .env  &&  vi .env"
  exit 1
fi
set -a; . "./$ENV_FILE"; set +a   # 把 .env 里的变量 export 出去(含 RELAY_STATE_KEY)

: "${RELAY_PORT:?请在 .env 设置 RELAY_PORT}"
: "${RELAY_PUBLIC_URL:?请在 .env 设置 RELAY_PUBLIC_URL(对外 ws 地址)}"
: "${RELAY_STATE_KEY:?请在 .env 设置 RELAY_STATE_KEY(state 加密密钥)}"

# ---- 派生启动参数 ----
ARGS=(--port="$RELAY_PORT" --public-url="$RELAY_PUBLIC_URL")
if [ -n "${RELAY_STATE:-}" ]; then
  ARGS+=(--state="$RELAY_STATE")   # 可选 state 路径;不配 → main.ts 默认 ./relay-state.json
fi
if [ -n "${RELAY_TLS_CERT:-}" ] && [ -n "${RELAY_TLS_KEY:-}" ]; then
  ARGS+=(--tls-cert="$RELAY_TLS_CERT" --tls-key="$RELAY_TLS_KEY")
  SCHEME=wss
else
  SCHEME=ws
fi

# ---- 进程存活检查 ----
is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

CMD="${1:-start}"
case "$CMD" in
  start)
    if is_running; then
      echo "relay 已在运行(pid $(cat "$PID_FILE"))。如需重启:./start.sh restart"
      exit 0
    fi
    [ "$SCHEME" = ws ] && echo "⚠ 未配 TLS 证书,将以明文 ws 启动(生产建议配证书或上反代,见 docs/ops.md)"
    echo "启动 relay ..."
    echo "===== $(date '+%F %T') 启动 relay =====" >> "$LOG_FILE"
    nohup bun run src/relay/main.ts "${ARGS[@]}" >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 1
    if is_running; then
      echo "✓ relay 已启动(pid $(cat "$PID_FILE")),$SCHEME 端口 :${RELAY_PORT}"
      echo "  日志:./start.sh logs    停止:./start.sh stop    状态:./start.sh status"
    else
      echo "✗ 启动失败,看日志排查:tail -50 $LOG_FILE"
      rm -f "$PID_FILE"
      exit 1
    fi
    ;;
  stop)
    if ! is_running; then
      echo "relay 未在运行。"
      rm -f "$PID_FILE"
      exit 0
    fi
    PID="$(cat "$PID_FILE")"
    echo "停止 relay(pid $PID,发 SIGINT 优雅退出)..."
    kill -INT "$PID" 2>/dev/null || true
    # 最多等约 8 秒优雅退出;仍不死则强杀(SIGINT handler 可能因异常未及时退出)。
    for _ in $(seq 1 40); do is_running || break; sleep 0.2; done
    if is_running; then
      echo "  优雅退出超时,强杀(pid $PID)。"
      kill -9 "$PID" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    echo "✓ 已停止。"
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  status)
    if is_running; then
      echo "✓ relay 运行中(pid $(cat "$PID_FILE"))。"
    else
      echo "✗ relay 未运行。"
      exit 1
    fi
    ;;
  logs)
    tail -f "$LOG_FILE"
    ;;
  *)
    echo "用法:$0 [start|stop|restart|status|logs]"
    exit 1
    ;;
esac
