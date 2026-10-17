#!/usr/bin/env python3
"""cdp-shot2.py <urlMatch> <outfile> <width> <height> [viewIndex] [fullPage=0|1]
单会话内完成 仿真→切视图→截屏（emulation 随会话断开重置，禁止重连后再截）。"""
import sys, base64, json, socket, os, struct, time, urllib.request
def session(path):
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
    def call(mid, method, params):
        send({'id': mid, 'method': method, 'params': params})
        while True:
            o = recv()
            if o.get('id') == mid:
                if 'error' in o: raise RuntimeError(f'{method}: ' + json.dumps(o['error'])[:200])
                return o.get('result', {})
    return s, call
target, outfile, width, height = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
view = int(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5] != 'none' else None
fullpage = len(sys.argv) > 6 and sys.argv[6] == '1'
tabs = json.loads(urllib.request.urlopen('http://127.0.0.1:18800/json/list', timeout=10).read())
path = None
for t in tabs:
    if t.get('type') == 'page' and target in (t.get('url') or ''):
        path = '/' + t['webSocketDebuggerUrl'].split('/', 3)[-1]; break
if not path: print('no matching tab'); sys.exit(1)
s, call = session(path)
try:
    call(1, 'Page.enable', {})
    call(2, 'Emulation.setDeviceMetricsOverride',
         {'width': width, 'height': height, 'deviceScaleFactor': 1, 'mobile': width < 700, 'screenWidth': width, 'screenHeight': height})
    if view is not None:
        call(3, 'Runtime.evaluate', {'expression': f"document.querySelectorAll('[role=tablist] button')[{view}].click()", 'returnByValue': True})
        time.sleep(0.8)
    res = call(4, 'Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': fullpage})
    open(outfile, 'wb').write(base64.b64decode(res['data']))
    print('saved', outfile, width, 'x', height, 'view', view)
finally:
    try: call(9, 'Emulation.clearDeviceMetricsOverride', {})
    except Exception: pass
    s.close()
