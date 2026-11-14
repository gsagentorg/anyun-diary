#!/usr/bin/env node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { presign } from './migrate-audio.mjs';
import { validateCatalog } from '../src/lib/catalog-schema.js';
const execute = promisify(execFile);
export const digest = b => createHash('sha256').update(b).digest('hex');
export function storageConfig(env) {
  for (const k of ['ENDPOINT','REGION','BUCKET','ACCESS_KEY_ID','SECRET_ACCESS_KEY']) if (!env['AUDIO_S3_'+k]) throw Error('Missing AUDIO_S3_'+k);
  const endpoint = new URL(env.AUDIO_S3_ENDPOINT);
  if (!['https:','http:'].includes(endpoint.protocol) || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw Error('Invalid S3 endpoint');
  return {ep:endpoint.origin,region:env.AUDIO_S3_REGION,bucket:env.AUDIO_S3_BUCKET,ak:env.AUDIO_S3_ACCESS_KEY_ID,sk:env.AUDIO_S3_SECRET_ACCESS_KEY,pathStyle:env.AUDIO_S3_PATH_STYLE==='1',prefix:''};
}
export function objectStore(cfg, fetcher=fetch) {
  return async (method,key,body,type='application/json',immutable=false) => {
    const response = await fetcher(presign({...cfg,method,key}), {method,body,redirect:'error',signal:AbortSignal.timeout(120000),headers:body?{'content-type':type,'cache-control':immutable?'public, max-age=31536000, immutable':'no-store'}:{'cache-control':'no-cache'}});
    if (!response.ok) { await response.body?.cancel(); throw Error('Object request failed: HTTP '+response.status); }
    return response;
  };
}
export async function prepareAudio(data, sources, temp, executeMedia=execute) {
  const audio = new Map(); let index = 0;
  for (const r of data.recordings) for (const c of r.clips) {
    const original = sources[c.file.slice(0,c.file.lastIndexOf('.'))];
    if (original.toLowerCase().endsWith('.opus')) { audio.set(c.file,original); continue; }
    const target = join(temp,String(index++)+'.opus');
    await executeMedia('ffmpeg',['-nostdin','-v','error','-i',original,'-vn','-c:a','libopus','-b:a','96k',target],{maxBuffer:1024*1024});
    audio.set(c.file,target);
  }
  return audio;
}
export async function publish(data, audio, request) {
  for (const r of data.recordings) for (const c of r.clips) {
    const path = audio.get(c.file);
    const bytes = path ? await readFile(path) : null;
    if (!bytes || bytes.subarray(0,4).toString() !== 'OggS') throw Error('Invalid Opus media');
    c.opus = 'objects/'+digest(bytes)+'.opus';
  }
  validateCatalog(data);
  const sent = new Set();
  for (const r of data.recordings) for (const c of r.clips) {
    if (sent.has(c.opus)) continue;
    const bytes = await readFile(audio.get(c.file));
    if (c.opus !== 'objects/'+digest(bytes)+'.opus') throw Error('Audio source changed during publication');
    await (await request('PUT',c.opus,bytes,'audio/ogg',true)).body?.cancel();
    const check = await request('GET',c.opus);
    const hash = createHash('sha256');
    for await (const chunk of check.body) hash.update(chunk);
    if (hash.digest('hex') !== digest(bytes)) throw Error('Audio integrity mismatch');
    sent.add(c.opus);
  }
  const payload = Buffer.from(JSON.stringify(data));
  const key = 'catalogs/'+digest(payload)+'.json';
  await (await request('PUT',key,payload,'application/json',true)).body?.cancel();
  const check = await request('GET',key);
  if (digest(Buffer.from(await check.arrayBuffer())) !== digest(payload)) throw Error('Catalog integrity mismatch');
  await (await request('PUT','catalog/current.json',Buffer.from(JSON.stringify({schemaVersion:1,key})))).body?.cancel();
  const pointer = await (await request('GET','catalog/current.json')).json();
  if (pointer.schemaVersion !== 1 || pointer.key !== key) throw Error('Published pointer read-back mismatch');
  return {key, clips:audio.size};
}
export async function run(args=process.argv.slice(2),env=process.env) {
  const options = {};
  for (let i=0;i<args.length;i++) {
    if (!['--audio-dir','--lrc-dir'].includes(args[i]) || !args[i+1] || args[i+1].startsWith('--')) throw Error('Usage: --audio-dir DIRECTORY --lrc-dir DIRECTORY');
    const key=args[i]; options[key]=args[++i];
  }
  if (!options['--audio-dir'] || !options['--lrc-dir']) throw Error('Audio and LRC directories are required');
  const cfg = storageConfig(env);
  let result;
  try { result = await execute('python3',[join(dirname(fileURLToPath(import.meta.url)),'derive-catalog.py'),options['--audio-dir'],options['--lrc-dir']],{env,maxBuffer:64*1024*1024}); }
  catch (error) {
    const reason = ['audio filename does not encode recording date and segment offsets','duplicate audio stem; provide one format per clip','non-positive clip span','audio title tag missing or ffprobe unavailable; cannot infer title','lyrics start beyond clip end','no segment audio found'].find(x=>error.stderr?.includes(x));
    throw Error('Input validation failed: '+(reason ?? 'missing/unreadable LRC or unsupported lyric syntax; verify same-stem UTF-8 LRC files'));
  }
  const {data,sources,warnings} = JSON.parse(result.stdout);
  warnings.forEach(x=>console.warn(x));
  const temp = await mkdtemp(join(tmpdir(),'diary-publish-'));
  try {
    const audio = await prepareAudio(data,sources,temp);
    console.log(JSON.stringify(await publish(data,audio,objectStore(cfg))));
  } finally { await rm(temp,{recursive:true,force:true}); }
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) run().catch(e=>{console.error((e.message?.startsWith('Usage:') || e.message === 'Audio and LRC directories are required' || e.message?.startsWith('Missing AUDIO_') || e.message?.startsWith('Input validation failed:'))?e.message:'Publication failed; inspect input names, tags, Python/ffmpeg and storage configuration. Private error details suppressed. A final pointer PUT timeout has indeterminate outcome; read current before retrying.');process.exitCode=1;});
