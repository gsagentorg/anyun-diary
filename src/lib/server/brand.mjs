// 品牌图是运行时数据，不属于源码/构建产物：由发布脚本写入各环境存储的 brand/ 前缀，
// 同源 `/brand/<file>` 路由按配置的存储适配器读取（local / blob / s3 共用同一协议）。
// 与音频不同，这里由服务端读字节回给浏览器：dev 的对象服务只允许签名读，
// 品牌图需匿名可用，因此不把存储地址暴露给前端。
export const BRAND_CONTENT_TYPES = { 'avatar.png': 'image/png', 'cover.jpg': 'image/jpeg' };

export function brandKey(file) {
  if (!Object.prototype.hasOwnProperty.call(BRAND_CONTENT_TYPES, file)) throw new Error('Invalid brand asset');
  return 'brand/' + file;
}

const noStore = { 'cache-control': 'no-store' };

export async function brandResponse(store, file, { signal } = {}) {
  const type = BRAND_CONTENT_TYPES[file];
  if (!type) return new Response('Not found', { status: 404, headers: noStore });
  const object = await store.read(brandKey(file), { signal });
  if (!object.ok) return new Response(null, { status: object.status === 404 ? 404 : 503, headers: noStore });
  const bytes = await object.arrayBuffer();
  if (!bytes.byteLength) return new Response(null, { status: 503, headers: noStore });
  const headers = new Headers({
    'content-type': type,
    'content-length': String(bytes.byteLength),
    'cache-control': 'public, max-age=600, must-revalidate',
    'x-content-type-options': 'nosniff',
  });
  const etag = object.headers.get('etag');
  if (etag) headers.set('etag', etag);
  return new Response(bytes, { status: 200, headers });
}