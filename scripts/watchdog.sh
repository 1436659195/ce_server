#!/usr/bin/env bash
# ce-relay 存活看门狗(由 systemd timer 每分钟拉起,也可手动跑)。
# 设计(与 ce-relay.service 的 Restart=always 互补,专治它管不了的三种死法):
#   1) unit 挂了/failed(如 StartLimit 用尽、启动即崩)→ 直接 systemctl start
#   2) 进程活着但不服务(挂死/卡 accept,unit 显示 active)→ 连续 3 次探测失败才 restart,防网络抖动误杀
#   3) 探测 OK → 清零失败计数
# 告警:journald(logger)+ 追加 ./watchdog.log。要推到手机,在 alert() 里加一条 curl webhook 即可。
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=".env"
[ -f "$ENV_FILE" ] && { set -a; . "./$ENV_FILE"; set +a; }
PORT="${RELAY_PORT:-8606}"
FAIL_FILE="/tmp/ce-relay-watchdog.fails"

alert() {
  logger -t ce-relay-watchdog -p user.err "$1"
  echo "$(date '+%F %T') $1" >> watchdog.log
}

# 探测:本地拉一次 install.sh 静态路由(不依赖公网/外部服务,只验证 relay 进程真的在服务)
if curl -fsS -m 5 -o /dev/null "http://127.0.0.1:${PORT}/install.sh"; then
  echo 0 > "$FAIL_FILE"
  exit 0
fi

# 探测失败 → 看是"死了"还是"活着但挂死"
if ! systemctl is-active --quiet ce-relay; then
  alert "探测失败且 ce-relay 非 active(崩溃/未启动)→ systemctl start ce-relay"
  systemctl start ce-relay
  exit 0
fi

n=$(( $(cat "$FAIL_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$FAIL_FILE"
if [ "$n" -ge 3 ]; then
  echo 0 > "$FAIL_FILE"
  alert "连续 ${n} 次探测失败但 unit 显示 active(疑似挂死)→ systemctl restart ce-relay"
  systemctl restart ce-relay
fi
