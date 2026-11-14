#!/usr/bin/env node
// Local upload or manifest-based migration. No uploads run during the site build.
import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIME = { '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg' };
const MAX_BYTES = 128 * 1024 * 1024;

export function parseOptions(args, env = process.env) {
  const options = { dryRun: false, overwrite: false, remote: false, concurrency: 4 };
  let source;
  for (const arg of args) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--overwrite') options.overwrite = true;
    else if (arg === '--from-remote') options.remote = true;
    else if (arg.startsWith('--source-base=')) {
      source = arg.slice('--source-base='.length);
      options.remote = true;
    } else if (arg.startsWith('--concurrency=')) options.concurrency = Number(arg.split('=')[1]);
    else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) {
    throw new Error('--concurrency 必须为 1–16 的整数');
  }
  if (options.remote) {
    source ??= env.SOURCE_AUDIO_BASE || env.PUBLIC_AUDIO_BASE;
    if (!source) throw new Error('请设置 SOURCE_AUDIO_BASE（旧音频地址），或 PUBLIC_AUDIO_BASE');
    const url = new URL(source);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('旧音频地址必须是无凭据、查询参数或片段的 HTTP(S) 基础地址');
    }
    options.sourceBase = url.href.replace(/\/+$/, '');
  }
  options.token = env.BLOB_READ_WRITE_TOKEN;
  if (!options.dryRun && !options.token) throw new Error('缺少 BLOB_READ_WRITE_TOKEN，请先创建 Public Blob Store');
  return options;
}

export function manifestFiles(data) {
  if (!Array.isArray(data.recordings)) throw new Error('data.json 缺少 recordings');
  const files = [...new Set(data.recordings.flatMap((rec) => {
    // Recordings without identified songs legitimately omit clips.
    if (rec.clips == null) return [];
    if (!Array.isArray(rec.clips)) throw new Error('data.json 缺少 clips');
    return rec.clips.map((clip) => clip.opus);
  }))];
  for (const name of files) {
    if (typeof name !== 'string' || !name.endsWith('.opus') || /[/\\\x00-\x1f]/.test(name)) {
      throw new Error('data.json 含无效的 opus 文件名');
    }
  }
  if (!files.length) throw new Error('没有待迁移的音频');
  return files;
}

async function download(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`音频下载 HTTP ${response.status}`);
  }
  const type = response.headers.get('content-type') ?? '';
  if (/text\/|json|xml/i.test(type)) {
    await response.body?.cancel();
    throw new Error('旧地址返回了文本/HTML，而非音频');
  }
  const length = response.headers.get('content-length');
  if (length && Number(length) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('单个音频超过 128 MiB 限制');
  }
  const chunks = [];
  let size = 0;
  if (!response.body) throw new Error('下载响应为空');
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('单个音频超过 128 MiB 限制');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  if (length && !response.headers.get('content-encoding') && size !== Number(length)) {
    throw new Error('下载不完整：大小与 Content-Length 不符');
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.subarray(0, 4).toString() !== 'OggS' || !bytes.subarray(0, 512).includes(Buffer.from('OpusHead'))) {
    throw new Error('下载内容不是有效的 Ogg Opus 文件');
  }
  return bytes;
}

// Dependencies can be injected for offline verification; tokens never go to the source host.
export async function uploadFiles(files, options, deps) {
  const { head, put, BlobNotFoundError } = deps;
  const log = deps.log ?? console.log;
  const pause = deps.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let uploaded = 0, skipped = 0, failed = 0;
  const origins = new Set();
  const queue = [...files];
  async function transfer(name) {
    const pathname = `audio/${name}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        let blob;
        if (!options.overwrite) {
          try {
            blob = await head(pathname, { token: options.token, abortSignal: AbortSignal.timeout(120_000) });
            if (!(blob.size > 0)) throw new Error('目标 Blob 文件为空，需用 --overwrite 修复');
          } catch (error) {
            if (!(error instanceof BlobNotFoundError)) throw error;
          }
        }
        const existed = Boolean(blob);
        if (!blob) {
          const bytes = options.remote
            ? await download(`${options.sourceBase}/audio/${encodeURIComponent(name)}`, deps.fetch ?? fetch)
            : await readFile(join('static/audio', name));
          if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('音频为空或超过 128 MiB');
          blob = await put(pathname, bytes, {
            token: options.token,
            access: 'public',
            addRandomSuffix: false,
            allowOverwrite: options.overwrite,
            contentType: MIME[extname(name).toLowerCase()],
            abortSignal: AbortSignal.timeout(120_000),
          });
        }
        const url = new URL(blob.url);
        if (url.protocol !== 'https:' || !url.hostname.endsWith('.public.blob.vercel-storage.com') ||
            decodeURIComponent(url.pathname) !== `/${pathname}`) {
          throw new Error('目标不是保持原路径的 Public Blob URL');
        }
        origins.add(url.origin);
        if (existed) skipped++;
        else uploaded++;
        log(`✓ ${name}`);
        return;
      } catch (error) {
        // Avoid printing SDK errors that may contain credentials or signed URLs.
        if (attempt < 3) {
          log(`重试 ${attempt}/2：${name}`);
          await pause(500 * 2 ** (attempt - 1));
        } else {
          failed++;
          log(`✗ ${name}（${error?.name ?? 'Error'}；请检查源文件、网络或 Blob 权限）`);
        }
      }
    }
  }
  async function worker() {
    while (queue.length) await transfer(queue.shift());
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, files.length) }, worker));
  log(`完成：上传 ${uploaded}，跳过 ${skipped}，失败 ${failed}`);
  if (failed || origins.size !== 1) throw new Error('迁移未全部完成，保留旧 PUBLIC_AUDIO_BASE，修复后重跑');
  const base = [...origins][0];
  log(`PUBLIC_AUDIO_BASE=${base}`);
  return { uploaded, skipped, base };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseOptions(args, env);
  const files = options.remote
    ? manifestFiles(JSON.parse(await readFile('src/lib/data.json', 'utf8')))
    : (await readdir('static/audio')).filter((name) => extname(name).toLowerCase() in MIME);
  if (!files.length) throw new Error('没有待上传音频');
  console.log(`待${options.remote ? '迁移' : '上传'} ${files.length} 个文件，并发 ${options.concurrency}`);
  if (options.dryRun) {
    for (const name of files) console.log(`audio/${name}`);
    console.log('dry-run：未下载或上传文件');
    return;
  }
  await uploadFiles(files, options, await import('@vercel/blob'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
