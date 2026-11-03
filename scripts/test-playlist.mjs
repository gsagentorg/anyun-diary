import assert from 'node:assert/strict';
import { tracksInRange, dayStartOf, validRange, buildM3u } from '../src/lib/playlist-core.ts';

// Synthetic fixtures stay stable as real recordings are imported; no NAS/audio required.
const lo = dayStartOf('2026-01-02');
const hi = dayStartOf('2026-01-04');
assert.equal(lo, Date.parse('2026-01-02T00:00:00+08:00') / 1000, 'Shanghai midnight');
assert.equal(hi - lo, 2 * 86400, 'two-day interval');
const recording = (start, names) => ({
  file: 'fixture-' + start + '.mp4', start, duration: 600, segments: [],
  clips: names.map((title, index) => ({
    title, file: title + '.m4a', opus: '2026-01-02 ' + title + ' #' + index + '%?.opus',
    offsetStart: index * 60, offsetEnd: index * 60 + 30.4, seg: null,
  })),
});
const first = recording(lo, ['测试 A', '测试 B']);
const second = recording(lo + 86400, ['测试 C']);
// Deliberately unsorted, including both excluded range boundaries.
const recs = [recording(hi, ['excluded upper']), second, recording(lo - 1, ['excluded lower']), first];
const originalOrder = recs.slice();
const tracks = tracksInRange(recs, lo, hi);
assert.equal(tracks.length, 3, 'nonempty range has exactly three tracks');
assert.deepEqual(tracks.map((t) => t.clip.title), ['测试 A', '测试 B', '测试 C'], 'recordings sorted; clip order preserved');
assert.ok(tracks.every((t) => t.rec.start >= lo && t.rec.start < hi), 'range is [lo, hi) by recording start');
assert.deepEqual(recs, originalOrder, 'input recording order is not mutated');
assert.equal(tracksInRange(recs).length, 5, 'unbounded range');
assert.deepEqual(tracksInRange(recs, hi + 1, hi + 86400), [], 'empty range');
assert.equal(validRange('2026-01-04', '2026-01-02'), false, 'reversed dates rejected');
assert.equal(validRange('2026-01-02', '2026-01-02'), true, 'same-day dates accepted');
assert.equal(validRange('not-a-date', '2026-01-02'), false, 'malformed dates rejected');
assert.equal(dayStartOf('not-a-date'), null, 'invalid date parser result');

const base = 'http://127.0.0.1:4173';
const lines = buildM3u(tracks, base, 'test').split('\n');
assert.deepEqual(lines.slice(0, 2), ['#EXTM3U', '#PLAYLIST:test'], 'M3U headers');
assert.equal(lines.length, 2 + 2 * tracks.length + 1, 'two lines per track plus final newline');
assert.equal(lines.at(-1), '', 'M3U ends in newline');
for (const [index, track] of tracks.entries()) {
  assert.equal(lines[2 + index * 2], '#EXTINF:30,' + track.clip.title, 'duration and title');
  // First URL is lines[3], not lines[4] (which is the next EXTINF).
  const url = lines[3 + index * 2];
  assert.equal(url, base + '/audio/' + encodeURIComponent(track.clip.opus), 'encoded audio URL ' + index);
  assert.equal(decodeURIComponent(new URL(url).pathname.slice('/audio/'.length)), track.clip.opus, 'filename roundtrip');
  assert.equal(new URL(url).search + new URL(url).hash, '', 'filename cannot become query or fragment');
}
assert.equal(buildM3u([], base, 'empty'), '#EXTM3U\n#PLAYLIST:empty\n', 'empty M3U');
console.log('playlist: range, ordering, dates and encoded M3U assertions passed');
