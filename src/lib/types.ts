export interface LyricLine { t: number; text: string }
export interface Audio { id: string; file: string; opus: string; title: string; startAt: number; duration: number | null; lyrics: LyricLine[]; monthId: string }
/** Native legacy snapshots have no known calendar identity. */
export type PlaybackAudio = Omit<Audio, 'startAt' | 'monthId'> & { startAt?: number; monthId?: string; legacyNative?: true };
export interface Track { queueEntryId: string; nativeQueueId?: string; audio: PlaybackAudio }
export interface MonthEntry { id: string; startAt: number; endAt: number; count: number; revision: string; key: string; available: boolean }
export interface MonthManifest { schemaVersion: 2; timezone: 'Asia/Shanghai'; generatedAt: number; revision: string; months: MonthEntry[] }
export interface AudioMonth { schemaVersion: 2; id: string; revision: string; audios: Audio[] }
export function createTrack(audio: Audio, queueEntryId: string): Track { return { queueEntryId, audio: { ...audio, lyrics: audio.lyrics.map(l => ({ ...l })) } }; }

export const fmtOffset = (s: number) => {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

export const fmtClock = (epoch: number) =>
  new Date(epoch * 1000).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  });

export const fmtDay = (epoch: number) =>
  new Date(epoch * 1000).toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
  });

/** 日期卡片：「10/02 周五」+「15:57 开播」 */
export function dateCard(epoch: number) {
  const d = new Date(epoch * 1000);
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    md: `${get('month')}/${get('day')}`,
    wd: get('weekday'),
    hm: `${get('hour')}:${get('minute')}`,
  };
}

export const fmtDur = (s: number) => {
  if (!Number.isFinite(s) || s <= 0) return '--:--';
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = s / 60;
  return m < 60 ? `${m.toFixed(1)}min` : `${(m / 60).toFixed(1)}h`;
};

/** mm:ss（播放进度/时长用） */
export const fmtClockShort = (s: number) => {
  if (!Number.isFinite(s) || s < 0) return '--:--';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

/** 按 title 哈希出稳定 hue */
export function hueOf(title: string): number {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** 切片音频基础地址：默认同源 /audio；Vercel 等静态托管不带宽音频时用 PUBLIC_AUDIO_BASE 指向外部 */
import { backend, isNativeApp } from './backend.svelte';
import { nativeAudioSrc } from './native-cache';
import { env as _env } from '$env/dynamic/public';
export const AUDIO_BASE = ((_env && _env.PUBLIC_AUDIO_BASE) as string | undefined ?? '').replace(/\/+$/, '');
/** Audio keys use the same route on web and the runtime-selected native backend.
 * 原生壳内再换一次地址：`anyun-cache://` 由原生磁盘缓存提供（命中即刻播放），web 原样返回。 */
export function audioUrl(opus: string): string {
  if (/^https?:\/\//.test(opus)) return opus;
  const base = isNativeApp() ? backend.base : '';
  return nativeAudioSrc(base + '/api/' + opus.split('/').map(encodeURIComponent).join('/'));
}
