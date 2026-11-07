#!/usr/bin/env node
/**
 * scripts/upload-blob.mjs — 把 static/audio/*.opus 与索引 src/lib/data.json 上传到 Vercel Blob。
 *
 * 前置：在 Vercel 项目里创建 Blob Store，拿到 BLOB_READ_WRITE_TOKEN。
 *   BLOB_READ_WRITE_TOKEN=vercel_blob_rw_xxx node scripts/upload-blob.mjs
 *
 * 上传后把打印出的 base 设为 PUBLIC_AUDIO_BASE（如 https://xxxx.public.blob.vercel-storage.com）。
 * 站点按 `${PUBLIC_AUDIO_BASE}/audio/<文件名>` 取音频，因此这里统一用 `audio/` 前缀。
 *
 * 可选参数：
 *   --dry-run        只列出将要上传的文件
 *   --concurrency=4  并发数（默认 4）
 *   --prefix=audio/  对象前缀（默认 audio/）
 *   --no-index       跳过索引 data.json 的上传
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const noIndex = args.includes('--no-index');
const concurrency = Number((args.find((a) => a.startsWith('--concurrency=')) ?? '').split('=')[1]) || 4;
const prefix = (args.find((a) => a.startsWith('--prefix=')) ?? '').split('=')[1] ?? 'audio/';
const DIR = join(process.cwd(), 'static/audio');
const INDEX_SRC = join(process.cwd(), 'src/lib/data.json');

const MIME = { '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg' };

if (!TOKEN && !dryRun) {
  console.error('缺少 BLOB_READ_WRITE_TOKEN。先在 Vercel 创建 Blob Store，再：');
  console.error('  BLOB_READ_WRITE_TOKEN=vercel_blob_rw_... node scripts/upload-blob.mjs');
  process.exit(1);
}

const files = (await readdir(DIR)).filter((f) => f in MIME || /\.(opus|m4a|ogg|mp3)$/i.test(f));
console.log(`待上传 ${files.length} 个文件 → 前缀 ${prefix}，并发 ${concurrency}${dryRun ? '（dry-run）' : ''}`);

let done = 0, failed = 0, base = null;

async function putObject(pathname, bytes, mime, label = pathname) {
  const res = await fetch('https://blob.vercel-storage.com/' + encodeURI(pathname), {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'x-api-version': '7',
      'x-content-type': mime,
      'x-add-random-suffix': '0',
      'x-allow-overwrite': '1',
    },
    body: bytes,
  });
  if (!res.ok) {
    failed++;
    console.error(`✗ ${label}: ${res.status} ${await res.text()}`);
    return;
  }
  const json = await res.json();
  if (!base && json.url) base = json.url.slice(0, json.url.length - encodeURI(pathname).length);
  done++;
}

async function uploadOne(name) {
  await putObject(
    prefix + name,
    await readFile(join(DIR, name)),
    MIME[name.slice(name.lastIndexOf('.'))] ?? 'application/octet-stream',
  );
  if (done % 20 === 0) console.log(`  …${done}/${files.length}`);
}

const queue = [...files];
async function worker() {
  while (queue.length) {
    const name = queue.shift();
    await uploadOne(name);
  }
}

if (dryRun) {
  console.log(files.slice(0, 5).join('\n') + (files.length > 5 ? `\n…（共 ${files.length}）` : ''));
} else {
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  // 索引一并上传到根 data.json：后端 = data.json + audio/*，App「后端地址」一个 URL 就够
  if (!noIndex) {
    try {
      console.log('上传索引 data.json …');
      await putObject('data.json', await readFile(INDEX_SRC), 'application/json');
    } catch (e) {
      failed++;
      console.error(`✗ data.json: ${e?.message ?? e}`);
    }
  }
  console.log(`\n完成：成功 ${done}，失败 ${failed}`);
  if (base) console.log(`PUBLIC_AUDIO_BASE=${base}`);
}
