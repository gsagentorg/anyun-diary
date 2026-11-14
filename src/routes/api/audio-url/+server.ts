import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { isValidAudioFile, presignGet } from '$lib/server/s3-presign';

/** GET /api/audio-url?f=<opus 文件名>
 *  s3 兼容档：校验文件名 → SigV4 预签 → 302 到限时私有 URL。
 *  未配置或校验失败：404/503，不带存储细节。 */
export const GET: RequestHandler = async ({ url, setHeaders }) => {
  const file = url.searchParams.get('f') ?? '';
  if (!isValidAudioFile(file)) return new Response(null, { status: 404 });

  const { AUDIO_S3_ENDPOINT, AUDIO_S3_REGION, AUDIO_S3_BUCKET, AUDIO_S3_ACCESS_KEY_ID, AUDIO_S3_SECRET_ACCESS_KEY } = env;
  const prefix = (env.AUDIO_S3_KEY_PREFIX ?? 'audio/').replace(/^\/+/, '');
  if (!AUDIO_S3_ENDPOINT || !AUDIO_S3_REGION || !AUDIO_S3_BUCKET || !AUDIO_S3_ACCESS_KEY_ID || !AUDIO_S3_SECRET_ACCESS_KEY) {
    return new Response(null, { status: 503 });
  }

  const ttl = Number(env.AUDIO_S3_URL_TTL_SECONDS ?? 3600);
  const target = presignGet({
    endpoint: AUDIO_S3_ENDPOINT,
    region: AUDIO_S3_REGION,
    bucket: AUDIO_S3_BUCKET,
    key: prefix + file,
    accessKeyId: AUDIO_S3_ACCESS_KEY_ID,
    secretAccessKey: AUDIO_S3_SECRET_ACCESS_KEY,
    expiresSeconds: Number.isFinite(ttl) ? ttl : 3600,
    pathStyle: env.AUDIO_S3_PATH_STYLE === '1',
  });

  setHeaders({ 'cache-control': 'no-store' });
  return new Response(null, { status: 302, headers: { location: target } });
};
