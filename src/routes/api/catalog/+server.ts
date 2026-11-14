import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';
import { readCatalog } from '$lib/server/catalog';
import { presignGet } from '$lib/server/s3-presign';
import { validateCatalog } from '$lib/catalog-schema.js';
import type { RequestHandler } from './$types';
export const prerender = false;
export const GET: RequestHandler = async () => {
  const headers = { 'cache-control': 'no-store, max-age=0' };
  try {
    // Legacy local/Blob deployments remain supported through an explicit bundled mode.
    if (!env.CATALOG_STORAGE || env.CATALOG_STORAGE === 'bundled') {
      const data = (await import('$lib/data.json')).default;
      return json({ ...data, recordings: data.recordings.map(r => ({ ...r, duration: r.duration ?? null, segments: r.segments ?? [], clips: r.clips ?? [] })) }, { headers });
    }
    if (env.CATALOG_STORAGE !== 's3') throw new Error('Unsupported catalog storage');
    const { AUDIO_S3_ENDPOINT: endpoint, AUDIO_S3_REGION: region, AUDIO_S3_BUCKET: bucket, AUDIO_S3_ACCESS_KEY_ID: accessKeyId, AUDIO_S3_SECRET_ACCESS_KEY: secretAccessKey } = env;
    if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) throw new Error('Missing storage configuration');
    const data = await readCatalog(key => fetch(presignGet({ endpoint, region, bucket, accessKeyId, secretAccessKey, key, pathStyle: env.AUDIO_S3_PATH_STYLE === '1', expiresSeconds: 60 }), { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) }));
    return json(validateCatalog(data), { headers });
  } catch {
    return json({ error: 'Catalog unavailable; retry later' }, { status: 503, headers });
  }
};
