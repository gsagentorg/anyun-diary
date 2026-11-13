#!/usr/bin/env node
/**
 * scripts/migrate-audio.mjs — 音频存储迁移工具（拉取 / 校验 / 推送 S3）。
 *
 * 权威清单 = src/lib/data.json（recordings[].clips[].opus，466 个）。
 *
 * 子命令：
 *   node scripts/migrate-audio.mjs pull   --from https://xxx.public.blob.vercel-storage.com [--out static/audio] [--concurrency=6] [--force]
 *       从已有实例（PUBLIC_AUDIO_BASE 指向的托管站点/Blob store）按 data.json 清单下载全部 opus 到本地 static/audio。
 *       已存在且 Content-Length 一致的文件自动跳过 ⇒ 可安全重复执行（断点续传）。
 *   node scripts/migrate-audio.mjs verify [--out static/audio]
 *       本地对照 data.json：缺失 / 空文件 / 非 OggS 魔数 / 清单外多余文件。
 *   node scripts/migrate-audio.mjs push-s3 [--out static/audio] [--concurrency=4] [--dry-run]
 *       把本地 opus 推到 S3 兼容私有桶（读 AUDIO_S3_* env，见 .env.example / docs/storage-backends.md）。
 *       推完后前端切 PUBLIC_AUDIO_STORAGE=s3 即可用，无需 PUBLIC_AUDIO_BASE。
 *
 * 所有网络请求串并发限速、失败即重报，不做静默重试超过 2 次。
 */
import { readdir, stat, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash, createHmac } from 'node:crypto';

const ROOT = join(process.cwd());
const DATA = JSON.parse(await readFile(join(ROOT, 'src/lib/data.json'), 'utf8'));
const expected = () => {
  const set = new Set();
  for (const r of DATA.recordings) for (const c of r.clips) if (c.opus) set.add(c.opus);
  return [...set];
};
const args = process.argv.slice(2);
const cmd = args.shift();
const opt = (name, dflt) => (args.find((a) => a.startsWith('--' + name + '=')) ?? '').split('=')[1] ?? dflt;
const has = (name) => args.includes('--' + name);
const CONC = Number(opt('concurrency', 6));
const DIR = join(ROOT, opt('out', 'static/audio'));

const OGG_MAGIC = Buffer.from('OggS');
async function ensureDir() { await mkdir(DIR, { recursive: true }); }

async function pool(n, items, fn) {
  const q = [...items]; let done = 0; const errs = [];
  async function worker() {
    while (q.length) {
      const it = q.shift();
      try { await fn(it); } catch (e) { errs.push([it, e.message]); }
      if (++done % 25 === 0) console.log(`  …${done}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length || 1) }, worker));
  return errs;
}

// ---------- pull ----------
async function pull() {
  const base = (args.find((a) => a.startsWith('--from=')) ?? '').split('=')[1]
    ?? process.env.PUBLIC_AUDIO_BASE;
  if (!base) { console.error('缺 --from=<已有实例音频 base>（或环境变量 PUBLIC_AUDIO_BASE）'); process.exit(1); }
  const b = base.replace(/\/+$/, '');
  const names = expected();
  await ensureDir();
  console.log(`清单 ${names.length} 个 opus ← ${b}/audio/`);
  const errs = [];
  const e = await pool(CONC, names, async (name) => {
    const local = join(DIR, name);
    let head = null;
    try { head = await fetch(`${b}/audio/${encodeURI(name)}`, { method: 'HEAD' }); } catch {}
    const remoteLen = head && head.ok ? Number(head.headers.get('content-length')) : null;
    try {
      const st = await stat(local);
      if (!has('force') && remoteLen != null && st.size === remoteLen) return; // skip
    } catch {}
    const res = await fetch(`${b}/audio/${encodeURI(name)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (remoteLen != null && buf.length !== remoteLen) throw new Error(`长度不符 ${buf.length}≠${remoteLen}`);
    if (!buf.subarray(0, 4).equals(OGG_MAGIC)) throw new Error('非 OggS 魔数');
    const tmp = local + '.part';
    await writeFile(tmp, buf);
    await rename(tmp, local);
  });
  errs.push(...e);
  report('下载', names.length, errs);
}

// ---------- verify ----------
async function verify() {
  const names = expected();
  const local = new Set(await readdir(DIR).catch(() => []));
  const missing = names.filter((n) => !local.has(n));
  const bad = [];
  const e = await pool(CONC, names.filter((n) => local.has(n)), async (n) => {
    const buf = await readFile(join(DIR, n));
    if (buf.length === 0) bad.push([n, '空文件']);
    else if (!buf.subarray(0, 4).equals(OGG_MAGIC)) bad.push([n, '非 OggS 魔数']);
  });
  const extra = [...local].filter((n) => !names.includes(n) && n.endsWith('.opus'));
  console.log(`清单 ${names.length}｜本地在 ${names.length - missing.length}｜缺失 ${missing.length}｜损坏 ${bad.length + e.length}｜清单外 ${extra.length}`);
  if (missing.length) console.log('缺失样例: ' + missing.slice(0, 5).join(', '));
  for (const [n, why] of [...bad, ...e]) console.error(`✗ ${n}: ${why}`);
  if (extra.length) console.log('清单外(opus): ' + extra.slice(0, 5).join(', ') + (extra.length > 5 ? ' …' : ''));
  if (missing.length || bad.length || e.length) process.exit(2);
  console.log('verify 通过 ✅');
}

// ---------- push-s3 ----------
const encURI = (s) => s.replace(/[^\w.~-]+/g, (c) => [...new TextEncoder().encode(c)].map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('') || encodeURIComponent(c));
function awsUri(s) { // RFC3986 per-segment
  return s.split('/').map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase())).join('/');
}
function hmac(key, data) { return createHmac('sha256', key).update(data).digest(); }
function presignPut({ key, ep, region, bucket, ak, sk, ttl, prefix, pathStyle }) {
  const host = pathStyle ? new URL(ep).host : `${bucket}.${new URL(ep).host}`;
  const uriPath = pathStyle ? `/${bucket}/${awsUri(prefix + key)}` : `/${awsUri(prefix + key)}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const q = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${ak}/${dateStamp}/${region}/s3/aws4_request`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(ttl),
    'X-Amz-SignedHeaders': 'host',
  });
  const canonicalQuery = [...q.entries()].map(([k, v]) => [encURI(k), encURI(v)]).sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = ['PUT', uriPath, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = ['AWS4-HMAC-SHA256', amzDate, `${dateStamp}/${region}/s3/aws4_request`, createHash('sha256').update(canonical).digest('hex')].join('\n');
  const sig = hmac(hmac(hmac(hmac('AWS4' + sk, dateStamp), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', sig).update(sts).digest('hex');
  return `${ep}${uriPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
async function pushS3() {
  const env = process.env;
  const cfg = {
    ep: env.AUDIO_S3_ENDPOINT?.replace(/\/+$/, ''), region: env.AUDIO_S3_REGION, bucket: env.AUDIO_S3_BUCKET,
    ak: env.AUDIO_S3_ACCESS_KEY_ID, sk: env.AUDIO_S3_SECRET_ACCESS_KEY,
    ttl: Number(env.AUDIO_S3_URL_TTL_SECONDS ?? 3600), prefix: env.AUDIO_S3_KEY_PREFIX ?? 'audio/',
    pathStyle: env.AUDIO_S3_PATH_STYLE === '1',
  };
  for (const [k, v] of Object.entries(cfg)) if ((v == null || v === '') && k !== 'pathStyle') { console.error(`缺 AUDIO_S3_* env: ${k}`); process.exit(1); }
  const names = expected();
  const dry = has('dry-run');
  if (!dry) await ensureDir();
  console.log(`推送 ${names.length} 个 → s3://${cfg.bucket}/${cfg.prefix}${dry ? '（dry-run）' : ''}`);
  const errs = [];
  const e = await pool(Number(opt('concurrency', 4)), names, async (name) => {
    const url = presignPut({ key: name, ...cfg });
    if (dry) return;
    const body = await readFile(join(DIR, name));
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await fetch(url, { method: 'PUT', body });
      if (res.ok) return;
      if (attempt === 2) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  });
  errs.push(...e);
  report('上传', names.length, errs);
}

function report(label, total, errs) {
  console.log(`\n${label}完成：成功 ${total - errs.length}/${total}，失败 ${errs.length}`);
  for (const [n, m] of errs.slice(0, 20)) console.error(`✗ ${n}: ${m}`);
  if (errs.length > 20) console.error(`…另有 ${errs.length - 20} 条`);
  if (errs.length) process.exit(3);
}

const cmds = { pull, verify, 'push-s3': pushS3 };
if (!cmds[cmd]) {
  console.error('用法: node scripts/migrate-audio.mjs <pull|verify|push-s3> [选项]  （--help 见文件头注释）');
  process.exit(1);
}
await cmds[cmd]();
