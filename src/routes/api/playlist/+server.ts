import type { RequestHandler } from './$types';
import data from '$lib/data.json';
import { tracksInRange, dayStartOf, validRange, buildM3u, buildXspf, buildPls, normalize } from '$lib/playlist-core';
import { env } from '$env/dynamic/public';
import type { Recording } from '$lib/types';

const recordings = normalize(data.recordings as Recording[]);

/**
 * 音频基址解析（优先级）：
 * 1) PUBLIC_AUDIO_BASE 环境变量（外部托管）
 * 2) 调用方显式传入的 base（面板传 location.origin，保证协议正确，如 https://）
 * 3) X-Forwarded-Proto + X-Forwarded-Host（代理转发场景）
 * 4) 回退本站 origin
 */
function audioBase(u: URL, req: Request): string {
  const ext = (env.PUBLIC_AUDIO_BASE ?? '').replace(/\/+$/, '');
  if (ext) return ext;

  const given = u.searchParams.get('base') ?? '';
  if (/^https?:\/\//i.test(given)) return given.replace(/\/+$/, '');

  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const host = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || u.host;
  if (proto === 'http' || proto === 'https') return `${proto}://${host}`;

  return u.origin;
}

const FORMATS = {
  // 默认 xspf：显式曲目列表，播放器不会当成 HLS 分片
  xspf: { type: 'application/xspf+xml; charset=utf-8', ext: 'xspf' },
  pls: { type: 'audio/x-scpls; charset=utf-8', ext: 'pls' },
  m3u: { type: 'audio/x-mpegurl; charset=utf-8', ext: 'm3u' },
} as const;

type Fmt = keyof typeof FORMATS;

/**
 * GET /api/playlist?from=YYYY-MM-DD&to=YYYY-MM-DD[&format=xspf|pls|m3u][&download=1]
 * 返回歌单（默认 xspf），inline 交给系统里注册的播放器，而非强制下载。
 */
export const GET: RequestHandler = ({ url, request }) => {
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';
  const fmt = (url.searchParams.get('format') ?? 'xspf') as Fmt;
  const download = url.searchParams.get('download') === '1';

  if (from && to && !validRange(from, to)) {
    return new Response('invalid range', { status: 400 });
  }
  if (!(fmt in FORMATS)) {
    return new Response('unsupported format', { status: 400 });
  }

  const lo = from ? dayStartOf(from) : null;
  const hi = to ? (dayStartOf(to) ?? 0) + 86400 : null;
  const tracks = tracksInRange(recordings, lo ?? undefined, hi ?? undefined);
  const base = audioBase(url, request);
  const name = `安允日记 ${from || 'all'}~${to || 'all'}`;

  const body =
    fmt === 'm3u' ? buildM3u(tracks, base, name)
    : fmt === 'pls' ? buildPls(tracks, base, name)
    : buildXspf(tracks, base, name);

  const { type, ext } = FORMATS[fmt];
  return new Response(body, {
    headers: {
      'content-type': type,
      // inline：浏览器有注册处理器（如 VLC）时直接交给它；download=1 时才强制下载
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename="anyun-diary.${ext}"`,
      'cache-control': 'no-store',
    },
  });
};
