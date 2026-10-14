#!/usr/bin/env python3
"""cdp.py — 通过 CDP 在浏览器标签里执行 JS。用法: cdp.py <tabPathOrUrl> <expr>"""
import socket, base64, os, json, struct, sys, urllib.request

def find_page(match):
    tabs = json.loads(urllib.request.urlopen('http://127.0.0.1:18800/json/list', timeout=10).read())
    for t in tabs:
        if t.get('type') == 'page' and match in (t.get('url') or ''):
            return t['webSocketDebuggerUrl'].split('/devtools/')[-1] if False else '/' + t['webSocketDebuggerUrl'].split('/', 3)[-1]
    return None

def evaluate(path, expr, timeout=15):
    key = base64.b64encode(os.urandom(16)).decode()
    req = (f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:18800\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
    s = socket.create_connection(('127.0.0.1', 18800), timeout=timeout)
    s.sendall(req.encode())
    r = b''
    while b'\r\n\r\n' not in r:
        r += s.recv(4096)
    def send(p):
        d = json.dumps(p).encode()
        f = bytearray([0x81]); n = len(d)
        if n < 126: f.append(0x80 | n)
        else: f.append(0x80 | 126); f += struct.pack('>H', n)
        m = os.urandom(4); f += m
        s.sendall(bytes(f) + bytes(b ^ m[i % 4] for i, b in enumerate(d)))
    def recv():
        h = s.recv(2); n = h[1] & 0x7F
        if n == 126: n = struct.unpack('>H', s.recv(2))[0]
        d = b''
        while len(d) < n:
            d += s.recv(n - len(d))
        return json.loads(d)
    send({'id': 1, 'method': 'Runtime.evaluate', 'params': {'expression': expr, 'returnByValue': True, 'awaitPromise': True}})
    out = recv()
    s.close()
    res = out.get('result', {})
    if 'exceptionDetails' in res:
        return 'EXCEPTION: ' + json.dumps(res['exceptionDetails'], ensure_ascii=False)[:400]
    return res.get('result', {}).get('value')

if __name__ == '__main__':
    target, expr = sys.argv[1], sys.argv[2]
    path = target if target.startswith('/devtools/') else find_page(target)
    if not path:
        print('no matching tab'); sys.exit(1)
    print(evaluate(path, expr))
