#!/usr/bin/env bash
# ============================================================================
# ce 切换到 wss —— 从阿里云控制台执行(不是在手机 ce 对话里跑!)
#
# 作用:把 ce 的中继地址从 ws://<旧明文中继IP>:8606 改成 wss://ce.coding-everywhere.xyz,
#       然后重启 ce daemon 让它用 wss 重连。
#
# ⚠️ 副作用:重启 ce 会连带停掉 ce spawn 的 Jupyter、终端、以及跑在里面的 claude
#          —— 即终止当前(手机上的) claude 对话。这是预期行为,无法避免。
#          切完用新 claude 会话(在 wss 上)继续。
#
# 保险:若新 ce 60 秒内没起来,自动回滚 config 到明文 ws 并重启 ce,保住连通。
#
# 用法(在阿里云控制台 / SSH 里):
#   bash /root/ce_server/switch-to-wss.sh
# ============================================================================
set -u

NEW_RELAY='wss://ce.coding-everywhere.xyz'
OLD_RELAY='ws://<旧明文中继IP>:8606'
LOG=/tmp/ce-switch.log
CE_BIN=/usr/local/bin/ce

echo "=== [1/5] 改 ce config -> wss ==="
mkdir -p ~/.ce
printf '{"relay":"%s"}\n' "$NEW_RELAY" > ~/.ce/config.json
cat ~/.ce/config.json

echo
echo "=== [2/5] 停当前 ce daemon(连带停 jupyter/claude/当前对话) ==="
if pkill -f "ce --daemon" 2>/dev/null; then echo "已发停止信号"; else echo "(没找到 ce --daemon 进程)"; fi
sleep 3
if pgrep -f "ce --daemon" >/dev/null; then
  echo "还在,强杀..."
  pkill -9 -f "ce --daemon" 2>/dev/null; sleep 1
fi

echo
echo "=== [3/5] 启动新 ce daemon(读 wss config) ==="
: > "$LOG"
setsid "$CE_BIN" --daemon </dev/null >>"$LOG" 2>&1 &
echo "等待 ce 起来(最多 60 秒)..."
UP=""
for i in $(seq 1 12); do
  if pgrep -f "ce --daemon" >/dev/null; then UP=1; echo "✓ ce 进程已起(第 $((i*5)) 秒)"; break; fi
  sleep 5
done

if [ -z "$UP" ]; then
  echo
  echo "✗✗ ce 没起来!自动回滚到明文 ws 保连通 ✗✗"
  echo "--- ce 日志(排查用) ---"; tail -30 "$LOG" 2>/dev/null
  printf '{"relay":"%s"}\n' "$OLD_RELAY" > ~/.ce/config.json
  setsid "$CE_BIN" --daemon </dev/null >>"$LOG" 2>&1 &
  sleep 6
  if pgrep -f "ce --daemon" >/dev/null; then
    echo "✓ 已回滚到明文,手机用【旧】连接码(旧明文中继地址)可恢复"
  else
    echo "✗ 回滚也失败!手动排查:看 $LOG,或重装: curl -fsSL http://<旧明文中继IP>:8606/install.sh | sh"
  fi
  exit 1
fi

echo
echo "=== [4/5] 验证 ce 连到 wss(443),不再连 8606 ==="
sleep 3
echo "-- ce 的网络连接(应见 :443,不应见 :8606) --"
ss -tnp 2>/dev/null | grep -i ce | head || echo "(暂时看不到,稍等几秒再看: ss -tnp | grep ce)"
echo "-- 新连接码(r 应为 $NEW_RELAY) --"
cat ~/.ce/connection-code.json 2>/dev/null || echo "(connection-code.json 还没生成,稍等)"
echo "-- ce 启动日志尾部 --"
tail -15 "$LOG" 2>/dev/null

echo
echo "=== [5/5] 完成 ==="
cat <<TIP
✓ ce 已切到 wss。接下来:
  1) 手机用【新】连接码重新连接(地址已是 wss://ce.coding-everywhere.xyz):
     把上面 connection-code.json 整行内容粘到手机 App,或在 ce 窗口扫新二维码。
     (sid/token 不变,不用重新输 PIN)
  2) 手机连上、能正常用后,在阿里云安全组【关闭入方向 TCP 8606】—— 收口明文。
  3) 关 8606 后,明文 ws 彻底不可达,全链路 wss,完工。
TIP
