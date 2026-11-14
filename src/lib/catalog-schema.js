export function validateCatalog(value) {
  const fail = () => { throw new Error('Invalid diary catalog'); };
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const text = s => typeof s === 'string' && s.length > 0;
  if (!value || !finite(value.generatedAt) || value.timezone !== 'Asia/Shanghai' || !Array.isArray(value.recordings) || !value.recordings.length) fail();
  const files = new Set();
  for (const r of value.recordings) {
    if (!text(r.file) || !finite(r.start) || !(r.duration === null || (finite(r.duration) && r.duration > 0)) || !Array.isArray(r.segments) || !Array.isArray(r.clips)) fail();
    for (const s of r.segments) if (!finite(s.start) || !finite(s.end) || s.end <= s.start) fail();
    for (const c of r.clips) {
      if (!text(c.file) || files.has(c.file) || !text(c.title) || !finite(c.offsetStart) || c.offsetStart < 0 || !finite(c.offsetEnd) || c.offsetEnd <= c.offsetStart || !(c.seg === null || text(c.seg)) || !text(c.opus) || !/^(?:objects\/[a-f0-9]{64}\.opus|[^/\\]+\.opus)$/.test(c.opus) || c.opus.includes('..') || [...c.opus].some(x=>x.charCodeAt(0)<32)) fail();
      files.add(c.file);
      if (c.lyrics != null) {
        if (!Array.isArray(c.lyrics)) fail();
        let previous = -1;
        for (const l of c.lyrics) { if (!finite(l.t) || l.t < 0 || l.t < previous || !text(l.text)) fail(); previous = l.t; }
      }
    }
  }
  return value;
}
export function validatePointer(value) {
  if (!value || value.schemaVersion !== 1 || !/^catalogs\/[a-f0-9]{64}\.json$/.test(value.key)) throw new Error('Invalid catalog pointer');
  return value;
}
