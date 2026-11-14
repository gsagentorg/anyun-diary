import assert from 'node:assert/strict';
import { presignGet, isValidAudioFile } from '../src/lib/server/s3-presign.ts';
let checks = 0;
function ok(value, message) { assert.ok(value, message); checks++; }

const base = {
  endpoint: 'https://s3.eu-central-003.backblazeb2.com',
  region: 'eu-central-003',
  bucket: 'anyun-audio',
  key: 'audio/安允 2023 (01).opus',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/example',
};

const now = new Date('2026-11-10T12:00:00Z');
const a = presignGet({ ...base, now });
const b = presignGet({ ...base, now });

// 确定性：同输入同签名
ok(a === b, 'deterministic');

// URL 结构：virtual-host、路径编码、必需查询参数齐全且有序
ok(a.startsWith('https://anyun-audio.s3.eu-central-003.backblazeb2.com/audio/'), 'virtual host + prefix path');
ok(a.includes('%20') || a.includes('%28'), 'uri-encoded filename');
for (const p of ['X-Amz-Algorithm=AWS4-HMAC-SHA256', 'X-Amz-Credential=', 'X-Amz-Date=20261110T120000Z', 'X-Amz-Expires=3600', 'X-Amz-SignedHeaders=host', 'X-Amz-Signature=']) {
  ok(a.includes(p), `param ${p}`);
}
const sig = a.split('X-Amz-Signature=')[1];
ok(sig && /^[0-9a-f]{64}$/.test(sig), 'signature is 64 hex chars');
const canonicalPart = a.split('&X-Amz-Signature=')[0].split('?')[1];
const query = canonicalPart.split('&').map((s) => s.split('=')[0]);
ok(JSON.stringify(query) === JSON.stringify([...query].sort()), 'query keys sorted');
ok(new Set(query).size === query.length, 'no duplicate params');

// 时间变化 → 签名变化；TTL 进查询参数
const c = presignGet({ ...base, now: new Date('2026-11-10T12:01:00Z') });
ok(c !== a, 'signature changes with time');
ok(presignGet({ ...base, now, expiresSeconds: 60 }).includes('X-Amz-Expires=60'), 'ttl honored');

// path-style：bucket 在路径，host 不带 bucket
const d = presignGet({ ...base, now, pathStyle: true });
ok(d.startsWith('https://s3.eu-central-003.backblazeb2.com/anyun-audio/'), 'path style');

// 自定义端点（MinIO 类）：http scheme 保留
const e2 = presignGet({ ...base, endpoint: 'http://127.0.0.1:9000', now, pathStyle: true });
ok(e2.startsWith('http://127.0.0.1:9000/anyun-audio/'), 'custom endpoint scheme kept');

// 文件名白名单
ok(isValidAudioFile('安允 2023 (01).opus'), 'accepts cjk/spaces/parens');
ok(isValidAudioFile("don't-stop.opus"), 'accepts apostrophe');
for (const bad of ['../etc/opus', 'a/b.opus', 'a\\b.opus', 'no-ext', '.opus', 'x.opus.exe', 'x.m4a', 'a..b.opus', '.opus'.padStart(210, 'x')]) {
  ok(!isValidAudioFile(bad), `rejects ${bad.slice(0, 16)}`);
}

console.log(`SESSION-TESTS storage pass=${checks} fail=0`);
