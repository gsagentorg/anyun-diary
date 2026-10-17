#!/usr/bin/env python3
"""cdp-shot.py — CDP 截图: cdp-shot.py <urlMatch> <outfile> [fullPage=1]"""
import sys, base64, json
sys.path.insert(0, '/home/user/anyun-diary/scripts')
import importlib.util
spec = importlib.util.spec_from_file_location('cdp', '/home/user/anyun-diary/scripts/cdp.py')
# cdp.py 顶层会执行 main? 不会——main 在 __main__ guard 里，但 find_page/evaluate 在顶层定义，import 安全
cdp = importlib.util.module_from_spec(spec)
import struct, socket, os
def evaluate_shot(path, fullpage):
    key = base64.b64encode(os.urandom(16)).decode()
    s = socket.create_connection(('127.0.0.1', 18800), timeout=30)
    s.sendall((f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:18800\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    r = b''
    while b'\r\n\r\n' not in r: r += s.recv(4096)
    def send(p):
        d = json.dumps(p).encode(); f = bytearray([0x81]); n = len(d)
        if n < 126: f.append(0x80 | n)
        elif n < 65536: f.append(0x80 | 126); f += struct.pack('>H', n)
        else: f.append(0x80 | 127); f += struct.pack('>Q', n)
        m = os.urandom(4); f += m
        s.sendall(bytes(f) + bytes(b ^ m[i % 4] for i, b in enumerate(d)))
    def recv():
        h = s.recv(2); n = h[1] & 0x7F
        if n == 126: n = struct.unpack('>H', s.recv(2))[0]
        elif n == 127: n = struct.unpack('>Q', s.recv(8))[0]
        d = b''
        while len(d) < n: d += s.recv(n - len(d))
        return json.loads(d)
    send({'id': 1, 'method': 'Page.enable', 'params': {}}); recv()
    if fullpage:
        send({'id': 2, 'method': 'Emulation.setDeviceMetricsOverride',
              'params': {'width': 1400, 'height': 900, 'deviceScaleFactor': 1, 'mobile': False}}); recv()
    send({'id': 3, 'method': 'Page.captureScreenshot', 'params': {'format': 'png'}})
    while True:
        out = recv()
        if out.get('id') == 3: break
    data = out['result']['data']
    s.close()
    return data
target, outfile = sys.argv[1], sys.argv[2]
fullpage = len(sys.argv) > 3
tabs = json.loads(__import__('urllib.request', fromlist=['x']).urlopen('http://127.0.0.1:18800/json/list', timeout=10).read())
path = None
for t in tabs:
    if t.get('type') == 'page' and target in (t.get('url') or ''): path = '/' + t['webSocketDebuggerUrl'].split('/', 3)[-1]; break
if not path: print('no matching tab'); sys.exit(1)
b64 = evaluate_shot(path, fullpage)
open(outfile, 'wb').write(base64.b64decode(b64))
print('saved', outfile)
