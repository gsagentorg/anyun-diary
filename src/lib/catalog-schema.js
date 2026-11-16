import { monthBounds, monthIdAt } from './month.js';
const finite = n => typeof n === 'number' && Number.isFinite(n);
const text = s => typeof s === 'string' && s.length > 0;
const fail = label => { throw new Error('Invalid '+label); };
const safeKey = s => text(s) && !s.startsWith('/') && !s.includes(String.fromCharCode(92)) && !s.split('/').some(p=>p==='..'||p==='.') && ![...s].some(c=>c.charCodeAt(0)<32) && !/^[a-z]+:/i.test(s);
function validAudioUrl(value) { try { const u=new URL(value); return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash; } catch { return false; } }
export function validateAudio(a) {
  if (!a||!text(a.id)||!text(a.file)||!(safeKey(a.opus)||validAudioUrl(a.opus))||!text(a.title)||!finite(a.startAt)||!(a.duration===null||(finite(a.duration)&&a.duration>0))||a.monthId!==monthIdAt(a.startAt)||!Array.isArray(a.lyrics)) fail('audio');
  let previous=-1;
  for(const l of a.lyrics) { if(!l||!finite(l.t)||l.t<0||l.t<previous||typeof l.text!=='string') fail('lyrics'); previous=l.t; }
  return a;
}
export function validateManifest(v) {
  if(!v||v.schemaVersion!==2||v.timezone!=='Asia/Shanghai'||!finite(v.generatedAt)||!text(v.revision)||!Array.isArray(v.months)) fail('manifest');
  const ids=new Set();
  for(const m of v.months) {
    if(!m||typeof m.id!=='string') fail('month entry');
    const b=monthBounds(m.id);
    if(ids.has(m.id)||m.startAt!==b.startAt||m.endAt!==b.endAt||!Number.isSafeInteger(m.count)||m.count<0||!text(m.revision)||!safeKey(m.key)||typeof m.available!=='boolean') fail('month entry');
    ids.add(m.id);
  }
  return v;
}
export function validateMonth(v,expected) {
  if(!v||v.schemaVersion!==2||!text(v.revision)||!Array.isArray(v.audios)) fail('month');
  monthBounds(v.id);
  if(expected&&(v.id!==expected.id||v.revision!==expected.revision||v.audios.length!==expected.count)) fail('month revision/count');
  const ids=new Set();
  for(const a of v.audios) { validateAudio(a); if(a.monthId!==v.id||ids.has(a.id)) fail('month audio'); ids.add(a.id); }
  return v;
}
export const validateCatalog = validateMonth;
export function validatePointer(v) { if(!v||v.schemaVersion!==2||!safeKey(v.key)) fail('pointer'); return v; }
