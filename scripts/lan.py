"""局域网一行连接(免费):起对外 jupyter + 终端打二维码。零常驻、用完即走(Ctrl+C 退出)。
复刻 ce 的 resolveJupyter 检测逻辑,但 --ip=0.0.0.0 对外监听,供手机扫码直连。"""
import json, os, signal, socket, subprocess, sys, time, ipaddress
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


def is_alive(url: str, token: str, timeout: float = 3.0) -> bool:
    """任意 HTTP 响应(含 401)= 活;拒连/超时 = 死。复刻 ce jupyter-detect.isAlive。"""
    import urllib.request
    try:
        req = urllib.request.Request(f'{url}/api/status',
                                     headers={'Authorization': f'Token {token}'})
        urllib.request.urlopen(req, timeout=timeout)
        return True
    except Exception:
        return False


def detect_servers() -> list[dict]:
    """跑 jupyter server list(回退 notebook list),逐个验活,返回活着的。"""
    for sub in (['-m', 'jupyter_server', 'list'], ['-m', 'notebook', 'list']):
        try:
            r = subprocess.run([sys.executable] + sub, capture_output=True,
                               text=True, timeout=10, shell=False)
            live = [s for s in parse_server_list(r.stdout) if is_alive(s['url'], s['token'])]
            if live:
                return live
        except Exception:
            continue
    return []


def has_jupyter() -> bool:
    try:
        subprocess.run([sys.executable, '-m', 'pip', 'show', 'jupyterlab'],
                       capture_output=True, check=True)
        return True
    except Exception:
        return False


def ensure_python_or_exit() -> None:
    try:
        subprocess.run([sys.executable, '--version'], check=True, capture_output=True)
    except Exception:
        print('[lan] 未检测到 Python。请先装 Python 3 后重跑一行命令。')
        sys.exit(1)


def load_or_make_token() -> str:
    """固定 token 存 ~/.ce/lan.json,手机扫一次长期有效。"""
    cfg: dict = {}
    if os.path.exists(CONFIG_PATH):
        try:
            cfg = json.load(open(CONFIG_PATH, 'r'))
        except Exception:
            cfg = {}
    tok = cfg.get('token')
    if not tok:
        import secrets
        tok = secrets.token_urlsafe(16)
        os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
        json.dump({'token': tok}, open(CONFIG_PATH, 'w'))
    return tok


def choose_ip(ips: list[str]) -> str:
    if len(ips) <= 1:
        return ips[0] if ips else '127.0.0.1'
    print('[lan] 检测到多个网卡 IP,选一个(手机与该网段同 WiFi):')
    for i, ip in enumerate(ips):
        print(f'  [{i}] {ip}')
    while True:
        a = input('输入序号: ').strip()
        if a.isdigit() and 0 <= int(a) < len(ips):
            return ips[int(a)]


def launch_external_jupyter(port: int, token: str):
    """起一个对外 jupyter(--ip=0.0.0.0),返回 Popen。不动用户已有的 loopback 实例。"""
    args = [sys.executable, '-m', 'jupyterlab', '--no-browser',
            f'--ip=0.0.0.0', f'--port={port}', f'--ServerApp.token={token}',
            '--ServerApp.allow_origin=*']
    try:
        if os.geteuid() == 0:  # Linux root
            args.append('--ServerApp.allow_root=True')
    except AttributeError:
        pass  # Windows 无 geteuid
    proc = subprocess.Popen(args)
    for _ in range(60):  # 等 30s 内起来
        if is_alive(f'http://127.0.0.1:{port}', token):
            return proc
        if proc.poll() is not None:
            raise RuntimeError('Jupyter 启动后立即退出,请手动 `python -m jupyterlab` 排查')
        time.sleep(0.5)
    raise RuntimeError(f'Jupyter 启动超时(30s 内 {port} 未响应)')


def resolve_jupyter(port: int, token: str):
    """返回 (base_url, token, proc_or_None)。proc 非 None = 我们起的,退出时要杀。"""
    external = [s for s in detect_servers() if not is_loopback_url(s['url'])]
    if external:  # 已有对外实例 → 复用,不开新进程
        s = external[0]
        print(f'[lan] 复用已有 Jupyter: {s["url"]}')
        return s['url'].replace('0.0.0.0', '127.0.0.1'), s['token'], None
    if not has_jupyter():
        print('[lan] 未检测到 Jupyter。先装:pip install jupyterlab '
              '-i https://pypi.tuna.tsinghua.edu.cn/simple')
        sys.exit(1)
    print('[lan] 启动对外 Jupyter(0.0.0.0)...')
    proc = launch_external_jupyter(port, token)
    return f'http://127.0.0.1:{port}', token, proc


def main() -> None:
    ensure_python_or_exit()
    port = DEFAULT_PORT
    token = load_or_make_token()
    base_url, tok, proc = resolve_jupyter(port, token)
    ip = choose_ip(lan_ip_candidates())
    display_url = base_url.replace('127.0.0.1', ip)
    name = socket.gethostname()
    payload = build_qr_payload(display_url, tok, name)

    print('\n[lan] 用 App「扫码连接」扫下方二维码(同 WiFi):\n')
    qr = render_qr_ansi(payload)
    if qr:
        print(qr)
    else:
        print('(终端二维码依赖 qrcode 包不可用,请用下方连接码在 App 手动粘贴)\n')
    print(f'\n连接码(手动粘贴): {payload}')
    print(f'\n局域网地址: {display_url}   (Ctrl+C 退出 → 关闭即停,不留任何服务)\n')

    def _stop(*_):
        if proc:
            proc.terminate()
        sys.exit(0)
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    while True:
        time.sleep(1)


if __name__ == '__main__':
    main()
