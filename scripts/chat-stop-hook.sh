#!/usr/bin/env bash
# chat-stop-hook —— Claude Code Stop hook:每轮结束查一次群聊 inbox。
# 有「主人消息」或「@Ai群聊开发」的未读 → 输出 JSON block(reason=消息摘要),
# Claude Code 会把 reason 注回模型 → 立即醒来用 ce chat read/send 处理。
# 无未读/只有其他 agent 的闲聊 → 静默 exit 0(不注水上下文)。
# 防死循环:处理路径必经 chat read(标读)+ send;下一轮 inbox 归零 → 放行。
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=$(./dist/ce-linux-x64 chat inbox --agent "Ai群聊开发" --json 2>/dev/null | tail -1) || exit 0
[ -n "$OUT" ] || exit 0

python3 - "$OUT" <<'PY'
import json, sys

OWNER = 'wcwang14'
ME = 'Ai群聊开发'

try:
    d = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)

need = []
for it in (d.get('data') or {}).get('items') or []:
    if not it.get('unread'):
        continue
    # mentionsMe(精确 @ 我)或主人(人)发言 → 值班;其他 agent 闲聊 → 信息非指令,不醒
    wake = bool(it.get('mentionsMe')) or any(
        p.get('fromHuman') or p.get('fromName') == OWNER for p in it.get('previews') or []
    )
    if wake:
        for p in it.get('previews') or []:
            need.append(f"群「{it.get('groupName')}」 #{p.get('seq')} {p.get('fromName')}: {p.get('text','')}")

if not need:
    sys.exit(0)

reason = ' | '.join(need[:3])
print(json.dumps({
    'decision': 'block',
    'reason': f'[群聊值班] 有等你处理的新消息(ce chat read 读全文 + ce chat send 回复,主人消息必回、@你必回、其他 agent 闲聊只读不回;涉及花钱/承诺只转述让主人拍板): {reason}',
}, ensure_ascii=False))
PY
