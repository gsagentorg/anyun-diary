#!/usr/bin/env python3
"""cdp-shot2.py <urlMatch> <outfile> <width> <height> [viewIndex] [fullPage=0|1]"""
import sys, base64, json, socket, os, struct, urllib.request
def evaluate(path, msgs):
    key = base64.b64encode(os.urandom(16)).decode()
    s = socket.create_connection(('127.0.0.1', 18800), timeout=30)
    s.sendall((f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:18800\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    r = b''
    while b'\r\n\r\n' not in r: r += s.recv(4096)
    mid = [0]
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
    results = {}
    for i, msg in enumerate(msgs):
        send({'id': 10 + i, 'method': msg[0], 'params': msg[1]})
        while True:
            out = recv()
            if out.get('id') == 10 + i:
                results[i] = out.get('result', {})
                break
    s.close()
    return results
target, outfile, width, height = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
view = int(sys.argv[5]) if len(sys.argv) > 5 else None
fullpage = len(sys.argv) > 6 and sys.argv[6] == '1'
tabs = json.loads(urllib.request.urlopen('http://127.0.0.1:18800/json/list', timeout=10).read())
path = None
for t in tabs:
    if t.get('type') == 'page' and target in (t.get('url') or ''):
        path = '/' + t['webSocketDebuggerUrl'].split('/', 3)[-1]; break
if not path: print('no matching tab'); sys.exit(1)
msgs = [('Emulation.setDeviceMetricsOverride', {'width': width, 'height': height, 'deviceScaleFactor': 1, 'mobile': width < 700})]
if view is not None:
    msgs.append(('Runtime.evaluate', {'expression': f"document.querySelectorAll('nav button')[{view}].click()", 'returnByValue': True}))
    import time
msgs.append(('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': fullpage}))
res = evaluate(path, msgs)
if view is not None:
    import time; time.sleep(0.6)
    # re-capture after render settle
    res2 = evaluate(path, [('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': fullpage})])
    data = res2[0]['data']
else:
    data = res[len(msgs)-1]['data']
open(outfile, 'wb').write(base64.b64decode(data))
print('saved', outfile, width, 'x', height, 'view', view)
