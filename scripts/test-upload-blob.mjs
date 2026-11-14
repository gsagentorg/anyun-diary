import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlobNotFoundError } from '@vercel/blob';
import { parseOptions, manifestFiles, uploadFiles } from './upload-blob.mjs';

const audio = Buffer.from('OggS\0example-header\0OpusHead\0audio');
const env = { SOURCE_AUDIO_BASE: 'https://old.example/prefix/', BLOB_READ_WRITE_TOKEN: 'secret' };
const options = () => parseOptions(['--from-remote', '--concurrency=2'], env);
function fixture(overrides = {}) {
  const logs = [], downloads = [], uploads = [], store = new Map();
  const deps = {
    BlobNotFoundError,
    log: (line) => logs.push(line),
    pause: async () => {},
    head: async (path) => {
      if (!store.has(path)) throw new BlobNotFoundError();
      return store.get(path);
    },
    put: async (path, bytes, config) => {
      uploads.push({ path, bytes, config });
      const blob = { size: bytes.length, url: `https://store.public.blob.vercel-storage.com/${path.split('/').map(encodeURIComponent).join('/')}` };
      store.set(path, blob);
      return blob;
    },
    fetch: async (url, config) => {
      downloads.push({ url, config });
      return new Response(audio, { headers: { 'content-type': 'audio/ogg', 'content-length': String(audio.length) } });
    },
    ...overrides,
  };
  return { deps, logs, downloads, uploads, store };
}

test('remote options prefer explicit source, then SOURCE_AUDIO_BASE, then PUBLIC_AUDIO_BASE', () => {
  assert.equal(options().sourceBase, 'https://old.example/prefix');
  assert.equal(parseOptions(['--from-remote'], { ...env, SOURCE_AUDIO_BASE: '', PUBLIC_AUDIO_BASE: 'https://fallback.example' }).sourceBase, 'https://fallback.example');
  assert.equal(parseOptions(['--source-base=https://explicit.example'], env).sourceBase, 'https://explicit.example');
  assert.throws(() => parseOptions(['--concurrency=0'], env));
  assert.throws(() => parseOptions(['--from-remote'], {}));
  assert.throws(() => parseOptions(['--source-base=https://user:pass@old.example'], env));
  assert.equal(parseOptions(['--from-remote', '--dry-run'], { PUBLIC_AUDIO_BASE: 'https://old.example' }).token, undefined);
});

test('manifest deduplicates files and rejects malformed names', () => {
  assert.deepEqual(manifestFiles({ recordings: [{}, { clips: null }, { clips: [{ opus: '歌.opus' }, { opus: '歌.opus' }] }] }), ['歌.opus']);
  for (const opus of ['../file.opus', undefined, 'a/b.opus']) {
    assert.throws(() => manifestFiles({ recordings: [{ clips: [{ opus }] }] }));
  }
});

test('migration encodes names, preserves bytes and path, and resumes without downloading again', async () => {
  const f = fixture();
  const name = '中文 #? 歌曲.opus';
  const result = await uploadFiles([name], options(), f.deps);
  assert.equal(result.uploaded, 1);
  assert.equal(f.downloads[0].url, `https://old.example/prefix/audio/${encodeURIComponent(name)}`);
  assert.equal(f.downloads[0].config.headers, undefined); // No Blob credential sent to source.
  assert.deepEqual(f.uploads[0].bytes, audio);
  assert.equal(f.uploads[0].path, `audio/${name}`);
  assert.equal(f.uploads[0].config.access, 'public');
  assert.equal(f.uploads[0].config.addRandomSuffix, false);
  assert.equal(f.uploads[0].config.allowOverwrite, false);
  const resumed = await uploadFiles([name], options(), f.deps);
  assert.equal(resumed.skipped, 1);
  assert.equal(f.downloads.length, 1);
  await uploadFiles([name], { ...options(), overwrite: true }, f.deps);
  assert.equal(f.downloads.length, 2);
  assert.equal(f.uploads[1].config.allowOverwrite, true);
});

test('transient download failure retries then succeeds', async () => {
  let attempts = 0;
  const f = fixture({ fetch: async () => ++attempts === 1 ? new Response('', { status: 503 }) : new Response(audio) });
  await uploadFiles(['a.opus'], options(), f.deps);
  assert.equal(attempts, 2);
  assert.equal(f.uploads.length, 1);
});

test('HTML, missing files, non-Opus and truncated downloads fail without printing a new base', async () => {
  const responses = [
    () => new Response('<html>not audio</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('', { status: 404 }),
    () => new Response('not opus'),
    () => new Response(audio, { headers: { 'content-length': String(audio.length + 10) } }),
  ];
  for (const response of responses) {
    const f = fixture({ fetch: async () => response() });
    await assert.rejects(uploadFiles(['a.opus'], options(), f.deps), /迁移未全部完成/);
    assert.equal(f.uploads.length, 0);
    assert.ok(!f.logs.some((line) => line.startsWith('PUBLIC_AUDIO_BASE=')));
  }
});

test('permission errors do not become missing blobs or leak SDK error details', async () => {
  const f = fixture({ head: async () => { throw new Error('secret signed URL'); } });
  await assert.rejects(uploadFiles(['a.opus'], options(), f.deps));
  assert.equal(f.downloads.length, 0);
  assert.equal(f.uploads.length, 0);
  assert.ok(!f.logs.join('\n').includes('secret'));
});

test('private stores and unexpected blob paths cannot produce a new audio base', async () => {
  for (const url of [
    'https://store.private.blob.vercel-storage.com/audio/a.opus',
    'https://store.public.blob.vercel-storage.com/audio/a-random.opus',
  ]) {
    const f = fixture({ head: async () => ({ url, size: 100 }) });
    await assert.rejects(uploadFiles(['a.opus'], options(), f.deps));
    assert.ok(!f.logs.some((line) => line.startsWith('PUBLIC_AUDIO_BASE=')));
  }
});
