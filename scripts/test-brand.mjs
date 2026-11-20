import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BRAND_FILES,
  brandAssetUrl,
  brandAttemptSrc,
  brandExhausted,
  BRAND_MAX_ATTEMPTS,
  normalizeBrandBase,
  resolveBrandBase,
} from '../src/lib/brand.ts';
import { BRAND_CONTENT_TYPES, brandKey, brandResponse } from '../src/lib/server/brand.mjs';
import { localStore, validKey } from '../src/lib/server/storage.mjs';
import { publishBrand, digest } from '../scripts/publish-brand.mjs';

let checks = 0;
async function ck(name, fn) {
  try {
    await fn();
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
  checks++;
  console.log(`PASS ${name}`);
}

// ---------- 基址规范化 ----------
await ck('normalize 绝对 URL 补尾斜杠', () => assert.equal(normalizeBrandBase('https://cdn.example.com/anyun/brand'), 'https://cdn.example.com/anyun/brand/'));
await ck('normalize 保留已是尾斜杠的绝对 URL', () => assert.equal(normalizeBrandBase('https://cdn.example.com/brand/'), 'https://cdn.example.com/brand/'));
await ck('normalize 同源路径补尾斜杠', () => assert.equal(normalizeBrandBase('/assets/brand'), '/assets/brand/'));
await ck('normalize 空值返回 null', () => {
  assert.equal(normalizeBrandBase(''), null);
  assert.equal(normalizeBrandBase('   '), null);
  assert.equal(normalizeBrandBase(null), null);
  assert.equal(normalizeBrandBase(undefined), null);
});
await ck('normalize 拒绝非法基址', () => {
  for (const value of ['//evil.example.com/brand', 'brand/', './brand', 'javascript:alert(1)', 'ftp://cdn/brand', 'https://cdn/brand?x=1', 'https://cdn/brand#h', 'https://user:pw@cdn/brand', '/brand?a=1', '/brand#x'])
    assert.equal(normalizeBrandBase(value), null, `应拒绝 ${value}`);
});

// ---------- 优先级：显式 > 数据后端同源 > 同源兜底 ----------
await ck('显式 PUBLIC_BRAND_BASE 优先于数据后端', () => assert.equal(resolveBrandBase('https://cdn.example.com/brand', 'https://api.example.com'), 'https://cdn.example.com/brand/'));
await ck('无显式时用数据后端同源 /brand/', () => assert.equal(resolveBrandBase('', 'https://api.example.com'), 'https://api.example.com/brand/'));
await ck('数据后端带尾斜杠', () => assert.equal(resolveBrandBase(undefined, 'https://api.example.com/'), 'https://api.example.com/brand/'));
await ck('两者皆空 → 同源兜底 /brand/', () => {
  assert.equal(resolveBrandBase(undefined, ''), '/brand/');
  assert.equal(resolveBrandBase(null, null), '/brand/');
});
await ck('显式非法时回落到数据后端（不抛错）', () => assert.equal(resolveBrandBase('//evil.example.com', 'https://api.example.com'), 'https://api.example.com/brand/'));

// ---------- URL 拼接 ----------
await ck('brandAssetUrl 拼接白名单文件', () => {
  assert.equal(brandAssetUrl('/brand/', 'avatar.png'), '/brand/avatar.png');
  assert.equal(brandAssetUrl('https://cdn.example.com/b', 'cover.jpg'), 'https://cdn.example.com/b/cover.jpg');
  assert.deepEqual([...BRAND_FILES], ['avatar.png', 'cover.jpg']);
});
await ck('brandAssetUrl 拒绝未知文件（防路径注入）', () => {
  for (const file of ['../secret', 'avatar.jpg', 'avatar.png?x=1', '', 'AVATAR.PNG']) assert.throws(() => brandAssetUrl('/brand/', file), /Unknown brand asset/);
});

// ---------- 失败降级：重试一次后占位 ----------
await ck('首次请求用原地址', () => assert.equal(brandAttemptSrc('/brand/avatar.png', 0), '/brand/avatar.png'));
await ck('重试附加一次性参数（绕开负缓存）', () => assert.equal(brandAttemptSrc('/brand/avatar.png', 1), '/brand/avatar.png?retry=1'));
await ck('已有查询串时用 & 连接', () => assert.equal(brandAttemptSrc('/brand/avatar.png?v=2', 1), '/brand/avatar.png?v=2&retry=1'));
await ck('尝试上限 = 2，达到即占位', () => {
  assert.equal(BRAND_MAX_ATTEMPTS, 2);
  assert.equal(brandExhausted(0), false);
  assert.equal(brandExhausted(1), false);
  assert.equal(brandExhausted(2), true);
});

// ---------- 存储键与同源端点 ----------
await ck('brand/ 键进入存储白名单，其余仍被拒', () => {
  assert.equal(validKey('brand/avatar.png'), 'brand/avatar.png');
  assert.equal(validKey('brand/cover.jpg'), 'brand/cover.jpg');
  for (const key of ['brand/', 'brand/other.png', 'brand/../current.json', 'brand/avatar.jpg']) assert.throws(() => validKey(key), /Invalid storage key/);
});
await ck('brandKey 白名单与内容类型', () => {
  assert.equal(brandKey('avatar.png'), 'brand/avatar.png');
  assert.throws(() => brandKey('logo.svg'), /Invalid brand asset/);
  assert.deepEqual(BRAND_CONTENT_TYPES, { 'avatar.png': 'image/png', 'cover.jpg': 'image/jpeg' });
});

const dir = await mkdtemp(join(tmpdir(), 'brand-test-'));
const store = localStore(dir);
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(24, 7)]);
const png2 = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(24, 8)]);
const jpeg = Buffer.concat([Buffer.from('ffd8ff', 'hex'), Buffer.alloc(24, 9)]);
const readKey = async (key) => Buffer.from(await (await store.read(key)).arrayBuffer());

try {
  await ck('缺对象时端点返回 404 且不缓存', async () => {
    const response = await brandResponse(store, 'avatar.png');
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  await publishBrand(store, { 'avatar.png': png, 'cover.jpg': jpeg });

  await ck('发布后端点返回字节 + 正确内容类型', async () => {
    const avatar = await brandResponse(store, 'avatar.png');
    assert.equal(avatar.status, 200);
    assert.equal(avatar.headers.get('content-type'), 'image/png');
    assert.equal(avatar.headers.get('content-length'), String(png.length));
    assert.match(avatar.headers.get('cache-control') ?? '', /max-age=600/);
    assert.deepEqual(Buffer.from(await avatar.arrayBuffer()), png);
    const cover = await brandResponse(store, 'cover.jpg');
    assert.equal(cover.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await cover.arrayBuffer()), jpeg);
  });

  await ck('未知文件名端点直接 404（不触存储）', async () => {
    assert.equal((await brandResponse(store, 'logo.svg')).status, 404);
  });

  await ck('非法字节拒绝发布（PNG/JPEG magic）', async () => {
    await assert.rejects(publishBrand(store, { 'avatar.png': Buffer.from('not an image'), 'cover.jpg': jpeg }), /Invalid brand image bytes/);
  });

  const before = digest(await readKey('brand/avatar.png'));
  await publishBrand(store, { 'avatar.png': png, 'cover.jpg': jpeg });
  const after = digest(await readKey('brand/avatar.png'));
  await ck('内容未变时重复发布幂等', () => assert.equal(before, after));

  await publishBrand(store, { 'avatar.png': png2, 'cover.jpg': jpeg });
  const replaced = await readKey('brand/avatar.png');
  await ck('内容变化时覆盖写入', () => assert.deepEqual(replaced, png2));

  await ck('存储异常向上抛错（端点据此回 503，不回显内部信息）', async () => {
    const failing = { read: async () => { throw new Error('S3 read failed: secret-endpoint'); } };
    await assert.rejects(brandResponse(failing, 'avatar.png'), /S3 read failed/);
  });
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`brand tests passed (${checks} checks): base precedence, URL join, retry-once degradation, storage allowlist, publish/verify`);