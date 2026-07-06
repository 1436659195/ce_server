"""局域网一行连接(免费):起对外 jupyter + 终端打二维码。零常驻、用完即走(Ctrl+C 退出)。
复刻 ce 的 resolveJupyter 检测逻辑,但 --ip=0.0.0.0 对外监听,供手机扫码直连。"""
import json, os, socket, subprocess, sys, time, ipaddress
from urllib.parse import urlparse, parse_qs

DEFAULT_PORT = 8601
CONFIG_PATH = os.path.expanduser('~/.ce/lan.json')


def parse_server_list(output: str) -> list[dict]:
    """解析 `jupyter server list` 输出(复刻 ce jupyter-detect.parseServerList)。"""
    servers: list[dict] = []
    for raw in output.splitlines():
        line = raw.strip()
        if (not line or line.startswith('Currently running')
                or line.startswith('There are no running')):
            continue
        sep = line.find(' :: ')
        if sep == -1:
            continue
        left, root = line[:sep].strip(), line[sep + 4:].strip()
        try:
            u = urlparse(left)
        except Exception:
            continue
        if not u.scheme:
            continue
        token = parse_qs(u.query).get('token', [''])[0]
        servers.append({'url': f'{u.scheme}://{u.netloc}', 'token': token, 'root': root})
    return servers


def is_loopback_url(url: str) -> bool:
    host = (urlparse(url).hostname or '').lower()
    return host in ('localhost', '::1') or host.startswith('127.')


def lan_ip_candidates() -> list[str]:
    """枚举本机 IPv4,排除 loopback/link-local/multicast。多块网卡时多个,交上层让用户选。"""
    cands: list[str] = []
    # UDP "连"外部地址取本机所用 IP(不真发包),最稳拿到出口 IP
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        if not ipaddress.ip_address(ip).is_loopback:
            cands.append(ip)
    except Exception:
        pass
    # 补充:getaddrinfo(hostname) 列出的其它网卡
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            addr = ipaddress.ip_address(ip)
            if addr.is_loopback or addr.is_link_local or addr.is_multicast:
                continue
            if ip not in cands:
                cands.append(ip)
    except Exception:
        pass
    return cands


def build_qr_payload(url: str, token: str, name: str) -> str:
    """局域网卡 JSON:{u=serverUrl, t=token, n=hostname}。"""
    return json.dumps({'u': url, 't': token, 'n': name})


def render_qr_ansi(payload: str) -> str:
    """终端 ANSI block 二维码(▀▄█,2 module 合 1 行)。优先 import qrcode;
    无则 pip install --user(纯 python 小包,几秒);都失败返回 ''(上层 fallback 连接码)。"""
    try:
        import qrcode
    except ImportError:
        try:
            subprocess.run(
                [sys.executable, '-m', 'pip', 'install', '--user', '--quiet', 'qrcode'],
                check=True, timeout=90,
            )
            import qrcode
        except Exception:
            return ''
    qr = qrcode.QRCode()
    qr.add_data(payload)
    qr.make(fit=True)
    modules = qr.modules  # list[list[bool]],modules[y][x] = True 表示该 module 涂黑
    size = len(modules)
    lines: list[str] = []
    for y in range(0, size, 2):
        line = ''
        for x in range(size):
            top = bool(modules[y][x])
            bot = y + 1 < size and bool(modules[y + 1][x])
            line += '█' if top and bot else '▀' if top else '▄' if bot else ' '
        lines.append(line)
    return '\n'.join(lines)


def main() -> None:  # 下一个 Task 实现
    pass


if __name__ == '__main__':
    main()
