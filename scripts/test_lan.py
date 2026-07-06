import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lan import parse_server_list, is_loopback_url, lan_ip_candidates, build_qr_payload

def test_parse_server_list_extracts_token_and_root():
    out = ("Currently running servers:\n"
           "http://localhost:8888/?token=abc :: /home/user\n"
           "https://10.0.0.1:9999/lab?token=yyy :: /data\n")
    s = parse_server_list(out)
    assert s == [
        {'url': 'http://localhost:8888', 'token': 'abc', 'root': '/home/user'},
        {'url': 'https://10.0.0.1:9999', 'token': 'yyy', 'root': '/data'},
    ]

def test_parse_ignores_non_url_lines():
    assert parse_server_list("noisy line\nhttp://x:1/?token=t :: r\n") == [
        {'url': 'http://x:1', 'token': 't', 'root': 'r'}]

def test_loopback_detection():
    assert is_loopback_url('http://localhost:8888')
    assert is_loopback_url('http://127.0.0.1:8888')
    assert is_loopback_url('http://127.1.2.3:8888')
    assert not is_loopback_url('http://192.168.1.5:8888')
    assert not is_loopback_url('http://10.0.0.1:8888')

def test_qr_payload_shape():
    p = json.loads(build_qr_payload('http://1.2.3.4:8601', 'tok', 'myhost'))
    assert p == {'u': 'http://1.2.3.4:8601', 't': 'tok', 'n': 'myhost'}

def test_lan_ip_candidates_excludes_loopback():
    ips = lan_ip_candidates()
    assert all(not ip.startswith('127.') for ip in ips)
