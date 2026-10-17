export interface Clip {
  file: string;
  opus: string;
  offsetStart: number;
  offsetEnd: number;
  seg: string;
  title: string;
}

export interface Segment {
  start: number;
  end: number;
}

export interface Recording {
  file: string;
  start: number; // epoch s (Asia/Shanghai)
  duration: number | null;
  segments: Segment[];
  clips: Clip[];
}

export interface DiaryData {
  generatedAt: number;
  timezone: string;
  recordings: Recording[];
}

/** 播放列表成员：切片 + 所属录像上下文 */
export interface Track {
  clip: Clip;
  rec: Recording;
  /** 与播放列表的关系：同一录像内的切片序号 */
  index: number;
}

/** 生成一个录像内的所有轨道（保持切片顺序） */
export function buildRecTracks(rec: Recording): Track[] {
  return (rec.clips ?? []).map((clip, index) => ({ clip, rec, index }));
}

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
import { env as _env } from '$env/dynamic/public';
export const AUDIO_BASE = ((_env && _env.PUBLIC_AUDIO_BASE) as string | undefined ?? '').replace(/\/+$/, '');

/** 切片音频 URL（文件名含空格/中文，需编码） */
export function audioUrl(opus: string): string {
  return `${AUDIO_BASE}/audio/` + encodeURIComponent(opus);
}
