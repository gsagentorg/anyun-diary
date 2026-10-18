import type { RequestHandler } from './$types';
import * as publicEnv from '$env/static/public';

const rawRoomId = (publicEnv as unknown as Record<string, string | undefined>)['PUBLIC_LIVE_ROOM_ID'];
const ROOM_ID = rawRoomId && /^\d+$/.test(rawRoomId) ? Number(rawRoomId) : 0;
const TTL = 60_000;

type LiveInfo = {
  live: boolean | null;
  title: string | null;
  area: string | null;
  cover: string | null;
  checkedAt: string;
};

let cache: { at: number; data: LiveInfo } | null = null;

const json = (data: LiveInfo) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

export const GET: RequestHandler = async () => {
  if (!ROOM_ID) {
    // 未配置 PUBLIC_LIVE_ROOM_ID：优雅降级
    return json({
      live: null,
      title: null,
      area: null,
      cover: null,
      checkedAt: new Date().toISOString(),
    });
  }

  const now = Date.now();
  if (cache && now - cache.at < TTL) return json(cache.data);

  let data: LiveInfo = {
    live: null,
    title: null,
    area: null,
    cover: null,
    checkedAt: new Date().toISOString(),
  };

  try {
    const res = await fetch(
      `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${ROOM_ID}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://live.bilibili.com/',
        },
        signal: AbortSignal.timeout(5000),
      },
    );
    const payload = (await res.json()) as {
      code?: number;
      data?: {
        live_status?: number;
        title?: string;
        area_name?: string;
        parent_area_name?: string;
      };
    };

    if (res.ok && payload.code === 0 && payload.data) {
      const d = payload.data;
      const area = [d.parent_area_name, d.area_name].filter(Boolean).join(' · ') || null;
      data = {
        live: d.live_status === 1,
        title: d.title ?? null,
        area,
        cover: '/brand/cover.jpg',
        checkedAt: new Date().toISOString(),
      };
    }
  } catch {
    data = { live: null, title: null, area: null, cover: null, checkedAt: new Date().toISOString() };
  }

  cache = { at: now, data };
  return json(data);
};
