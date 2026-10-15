import type { RequestHandler } from './$types';
import data from '$lib/data.json';
import { tracksInRange, dayStartOf, validRange, buildM3u, normalize } from '$lib/playlist-core';
import type { Recording } from '$lib/types';

const recordings = normalize(data.recordings as Recording[]);

/**
 * GET /api/playlist?from=YYYY-MM-DD&to=YYYY-MM-DD
 * 返回 m3u（Content-Type: audio/x-mpegurl, inline）——
 * 交给系统里注册的播放器（VLC 等）直接打开，而不是强制下载。
 */
export const GET: RequestHandler = ({ url }) => {
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';

  if (from && to && !validRange(from, to)) {
    return new Response('invalid range', { status: 400 });
  }

  const lo = from ? dayStartOf(from) : null;
  const hi = to ? (dayStartOf(to) ?? 0) + 86400 : null;
  const tracks = tracksInRange(recordings, lo ?? undefined, hi ?? undefined);
  const name = `安允日记 ${from || 'all'}~${to || 'all'}`;
  const body = buildM3u(tracks, url.origin, name);

  return new Response(body, {
    headers: {
      'content-type': 'audio/x-mpegurl; charset=utf-8',
      // inline：浏览器有注册的 m3u 处理器（如 VLC）时直接交给它，否则才下载
      'content-disposition': 'inline; filename="anyun-diary.m3u"',
      'cache-control': 'no-store',
    },
  });
};
