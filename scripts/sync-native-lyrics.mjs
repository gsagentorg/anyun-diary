import { readFile, writeFile } from 'node:fs/promises';

// Native restoration must not depend on JS having rebuilt the full playlist.
const data = JSON.parse(await readFile(new URL('../src/lib/data.json', import.meta.url), 'utf8'));
const catalog = {};
for (const recording of data.recordings) {
  for (const clip of recording.clips ?? []) {
    if (clip.lyrics?.length) catalog[clip.file] = clip.lyrics;
  }
}
await writeFile(new URL('../static/native-lyrics.json', import.meta.url), JSON.stringify(catalog));
console.log(`Native lyric catalog: ${Object.keys(catalog).length} tracks`);
