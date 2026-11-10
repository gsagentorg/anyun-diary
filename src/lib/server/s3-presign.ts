import crypto from 'node:crypto';

/** AWS SigV4 query 预签（GET / UNSIGNED-PAYLOAD / 只签 host），零依赖。
 * 适用于任意 S3 兼容存储（Backblaze B2、Cloudflare R2、MinIO、AWS S3）。 */

export interface PresignInput {
  endpoint: string; // 例 https://s3.eu-central-003.backblazeb2.com
  region: string;
  bucket: string;
  key: string; // 对象键，含前缀
  accessKeyId: string;
  secretAccessKey: string;
  expiresSeconds?: number;
  pathStyle?: boolean;
  now?: Date;
}

/** AWS URI 编码：RFC3986 保留字全编码，紧跟 AWS 规范（比 encodeURIComponent 多编码 !'()*） */
function awsUri(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function hmac(key: crypto.BinaryLike | crypto.KeyObject, text: string): Buffer {
  return crypto.createHmac('sha256', key).update(text).digest();
}

/** 切片音频文件名白名单：中英文/数字/常见标点 + .opus 后缀；拒绝路径分隔、..、控制字符 */
export function isValidAudioFile(name: string): boolean {
  if (!name.endsWith('.opus') || name.length > 200) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  return /^[\w\u4e00-\u9fff\-. ()'（）·、，！？!?\[\]]+\.opus$/u.test(name);
}

export function presignGet(input: PresignInput): string {
  const expires = Math.min(Math.max(input.expiresSeconds ?? 3600, 1), 604800);
  const url = new URL(input.endpoint);
  const host = input.pathStyle ? url.host : `${input.bucket}.${url.host}`;
  const encodedKey = input.key.split('/').map(awsUri).join('/');
  const path = input.pathStyle ? `/${awsUri(input.bucket)}/${encodedKey}` : `/${encodedKey}`;

  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;

  // canonical query：按 key 排序、逐项 awsUri
  const params: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${input.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expires)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  params.sort(([a], [b]) => (a < b ? -1 : 1));
  const canonicalQuery = params.map(([k, v]) => `${awsUri(k)}=${awsUri(v)}`).join('&');

  const canonicalRequest = [
    'GET',
    path,
    canonicalQuery,
    `host:${host}`,
    '',
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return `${url.protocol}//${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
