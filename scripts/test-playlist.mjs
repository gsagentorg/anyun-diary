import { tracksInRange, dayStartOf, validRange, buildM3u } from '../src/lib/playlist.svelte.ts';
import data from '../src/lib/data.json';

const recs = data.recordings;
const lo = dayStartOf('2026-10-04');
const hi = dayStartOf('2026-10-05') + 86400;
if (lo == null || hi == null) throw new Error('dayStartOf failed');

const tracks = tracksInRange(recs, lo, hi);
console.log('tracks:', tracks.length);

const sorted = tracks.every(
  (t, i) =>
    i === 0 ||
    tracks[i - 1].rec.start + tracks[i - 1].clip.offsetStart <= t.rec.start + t.clip.offsetStart,
);
console.log('sorted?', sorted);

console.log('all in range?', tracks.every((t) => t.rec.start >= lo && t.rec.start < hi));
console.log('invalid range rejected?', !validRange('2026-10-05', '2026-10-04'));

const m3u = buildM3u(tracks, 'http://127.0.0.1:4173', 'test');
const lines = m3u.split('\n');
console.log('m3u lines:', lines.length, 'first track:', lines[3]);
console.log('audio path encoded ok?', /\/audio\/20\d{2}/.test(lines[4] ?? ''));

console.log('empty range = 0?', tracksInRange(recs, dayStartOf('2026-11-01'), dayStartOf('2026-11-02')).length === 0);
