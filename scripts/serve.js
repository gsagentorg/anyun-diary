import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = '/home/user/anyun-diary/build';
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendRange(req, res, f, size) {
  const range = req.headers.range;
  const type = mime[path.extname(f)] || 'application/octet-stream';
  if (!range) {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(f).pipe(res);
    return;
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }
  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null && end === null) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }
  if (start === null) {
    // suffix range: last N bytes
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }
  if (start > end || start >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }
  res.writeHead(206, {
    'Content-Type': type,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Accept-Ranges': 'bytes'
  });
  fs.createReadStream(f, { start, end }).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.method === 'HEAD') {
    let hp;
    try { hp = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); res.end(); return; }
    if (hp === '/') hp = '/index.html';
    const hf = path.normalize(path.join(root, hp));
    if (!hf.startsWith(root) || !fs.existsSync(hf) || !fs.statSync(hf).isFile()) {
      res.writeHead(404); res.end(); return;
    }
    const st = fs.statSync(hf);
    res.writeHead(200, {
      'Content-Type': mime[path.extname(hf)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Accept-Ranges': 'bytes'
    });
    res.end();
    return;
  }
  let p;
  try {
    p = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400); res.end('bad'); return;
  }
  if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(root, p));
  if (!f.startsWith(root) || !fs.existsSync(f) || !fs.statSync(f).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  const size = fs.statSync(f).size;
  sendRange(req, res, f, size);
});

server.listen(4173, '0.0.0.0', () => console.log('static server on 0.0.0.0:4173 (range-capable)'));
