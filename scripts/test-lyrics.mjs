import assert from 'node:assert/strict';
import { lyricIndexAt, lyricDisplayIndexAt, sameTimeGroupBounds, hasLyrics, lyricsFingerprint } from '../src/lib/lyrics.ts';

const lines = [
  { t: 10, text: 'a' },
  { t: 20, text: 'b' },
  { t: 30, text: 'c1' },
  { t: 30, text: 'c2' },
  { t: 30, text: 'c3' },
  { t: 40, text: 'd' },
];
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.log('FAIL:', name); } };

ok(lyricIndexAt(null, 5) === -1, 'null lyrics -> -1');
ok(lyricIndexAt(lines, NaN) === -1, 'NaN pos -> -1');
ok(lyricIndexAt(lines, 5) === -1, 'before first -> -1');
ok(lyricIndexAt(lines, 10) === 0, 'exactly first');
ok(lyricIndexAt(lines, 25) === 1, 'between lines');
ok(lyricIndexAt(lines, 30) === 4, 'at duplicate group returns last index');
ok(lyricIndexAt(lines, 35) === 4, 'just after group returns last index');
ok(lyricIndexAt(lines, 999) === 5, 'after end returns last');

ok(sameTimeGroupBounds(lines, -1) === null, 'idx -1 -> null');
ok(sameTimeGroupBounds(lines, 6) === null, 'idx out of range -> null');
ok(sameTimeGroupBounds(null, 0) === null, 'null lyrics -> null');
ok(JSON.stringify(sameTimeGroupBounds(lines, 0)) === '[0,0]', 'singleton bounds');
ok(JSON.stringify(sameTimeGroupBounds(lines, 3)) === '[2,4]', 'duplicate group bounds from middle');
ok(JSON.stringify(sameTimeGroupBounds(lines, 2)) === '[2,4]', 'duplicate group bounds from start');
ok(JSON.stringify(sameTimeGroupBounds(lines, 4)) === '[2,4]', 'duplicate group bounds from end');
ok(JSON.stringify(sameTimeGroupBounds(lines, 5)) === '[5,5]', 'last singleton bounds');

// Metadata mapping: playback idx (last of same-t group) anchors to the FIRST line.
const idx = lyricIndexAt(lines, 33);
const group = sameTimeGroupBounds(lines, idx);
ok(!!group && group[0] === 2, 'metadata anchors to first line of same-t group');

ok(hasLyrics({ lyrics: lines }) === true, 'hasLyrics with lines');
ok(hasLyrics({ lyrics: [] }) === false, 'hasLyrics empty');
ok(hasLyrics(null) === false, 'hasLyrics null clip');

const fp1 = lyricsFingerprint({ lyrics: [{ t: 1, text: ' hello  world ' }] });
const fp2 = lyricsFingerprint({ lyrics: [{ t: 9, text: 'hello world' }] });
ok(fp1 === fp2, 'fingerprint normalizes whitespace');

// Presentation layer (owner 2026-11-07): data keeps original times; trailing
// lines past the clip end collapse to the audio end at display time only.
const DUR = 35.7;
const tail = [
  { t: 10, text: 'a' },
  { t: 34.4, text: 'in-range' },
  { t: 36.0, text: 'trail1' },
  { t: 36.9, text: 'trail2' },
];
ok(lyricIndexAt(tail, 35.7) === 1, 'data layer: unclamped search never reaches past-end lines');
ok(lyricDisplayIndexAt(tail, 34.4, DUR) === 1, 'display: in-range line lights normally');
ok(lyricDisplayIndexAt(tail, 34.9, DUR) === 1, 'display: trailing lines inactive before end');
ok(lyricDisplayIndexAt(tail, 35.7, DUR) === 3, 'display: trailing lines active at audio end');
ok(lyricDisplayIndexAt(tail, 999, DUR) === 3, 'display: end-clamped search stays bounded');
const tg = sameTimeGroupBounds(tail, 3, DUR);
ok(!!tg && tg[0] === 2 && tg[1] === 3, 'trailing lines collapse into one end group');
ok(!!tg && sameTimeGroupBounds(tail, 2, DUR)[0] === 2, 'end group first line feeds metadata');
ok(lyricDisplayIndexAt(tail, 5, Infinity) === -1, 'no duration behaves like source-time search');

console.log(`lyrics: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
