import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audioUrl } from '../src/lib/types.ts';
import { presignGet } from '../src/lib/server/s3-presign.ts';
import { publish, prepareAudio, run } from './publish-data.mjs';
import { readCatalog } from '../src/lib/server/catalog.ts';
import { validateCatalog, validatePointer } from '../src/lib/catalog-schema.js';
const objects = new Map(), writes = [];
let fail = false;
const request = async (method,key,body) => {
  if (method === 'PUT') {
    if (fail && key.startsWith('catalogs/')) throw Error('simulated failure');
    objects.set(key,Buffer.from(body)); writes.push(key);
    return new Response(null);
  }
  return new Response(objects.get(key) ?? null,{status:objects.has(key)?200:404});
};
const fixture = title => ({generatedAt:1,timezone:'Asia/Shanghai',recordings:[{file:'YOUR-RECORDING-HERE',start:1,duration:null,segments:[],clips:[{file:'YOUR-CLIP-HERE.ogg',opus:'YOUR-CLIP-HERE.opus',offsetStart:0,offsetEnd:10,seg:null,title,lyrics:[{t:0,text:'YOUR-LYRIC-HERE'}]}]}]});
const temp = await mkdtemp(join(tmpdir(),'diary-test-'));
try {
const path = join(temp,'source.opus');
await writeFile(path,Buffer.from('OggS YOUR-MOCK-MEDIA-HERE'));
const audio = await prepareAudio(fixture('TITLE'),{'YOUR-CLIP-HERE':path},temp,async()=>{throw Error('Opus must not be transcoded');});
assert.equal(audio.get('YOUR-CLIP-HERE.ogg'),path);
assert([...audio.values()].every(x=>typeof x==='string'));
let conversions=0;
const converted = await prepareAudio(fixture('TITLE'),{'YOUR-CLIP-HERE':join(temp,'source.ogg')},temp,async (_cmd,args)=>{conversions++;await writeFile(args.at(-1),'OggS converted');});
assert.equal(conversions,1);
assert.equal(converted.get('YOUR-CLIP-HERE.ogg'),join(temp,'0.opus'));
await assert.rejects(run(['--audio-dir','YOUR-AUDIO-DIRECTORY-HERE','--lrc-dir','YOUR-LRC-DIRECTORY-HERE'],{}),/Missing AUDIO_S3_ENDPOINT/);
await assert.rejects(run(['--audio-dir','--lrc-dir'],{}),/Usage:/);
assert.equal(writes.length,0);
const objectKey='objects/'+'a'.repeat(64)+'.opus';
assert.equal(audioUrl(objectKey),'/api/audio-url?f='+encodeURIComponent(objectKey));
const signed=presignGet({endpoint:'https://YOUR-ENDPOINT-HERE',region:'YOUR-REGION-HERE',bucket:'YOUR-BUCKET-HERE',key:objectKey,accessKeyId:'YOUR-ACCESS-KEY-HERE',secretAccessKey:'YOUR-SECRET-HERE',pathStyle:true});
assert.equal(new URL(signed).pathname,'/YOUR-BUCKET-HERE/'+objectKey);
assert(new URL(signed).searchParams.has('X-Amz-Signature'));
const beforeCorrupt=writes.length;
await assert.rejects(publish(fixture('TITLE'),audio,async (method,key,body,...rest)=> {
  if (method==='GET' && key.startsWith('objects/')) return new Response('OggS corrupted');
  return request(method,key,body,...rest);
}),/Audio integrity mismatch/);
assert(!writes.slice(beforeCorrupt).includes('catalog/current.json'));
const read = key => request('GET',key);
await publish(fixture('YOUR-TITLE-ONE-HERE'),audio,request);
assert.equal(writes.at(-1),'catalog/current.json');
const published = await readCatalog(read);
assert.equal(published.recordings[0].duration,null);
assert.deepEqual(published.recordings[0].segments,[]);
assert.equal((await readCatalog(read)).recordings[0].clips[0].title,'YOUR-TITLE-ONE-HERE');
const first = objects.get('catalog/current.json').toString();
const oldKeys = [...objects.keys()];
await publish(fixture('YOUR-TITLE-TWO-HERE'),audio,request);
assert.equal((await readCatalog(read)).recordings[0].clips[0].title,'YOUR-TITLE-TWO-HERE');
assert.notEqual(objects.get('catalog/current.json').toString(),first);
for (const key of oldKeys) assert(objects.has(key));
const current = objects.get('catalog/current.json').toString();
fail = true;
await assert.rejects(publish(fixture('YOUR-TITLE-THREE-HERE'),audio,request));
assert.equal(objects.get('catalog/current.json').toString(),current);
assert.throws(()=>validateCatalog({...fixture('YOUR-TITLE-HERE'),recordings:[]}));
assert.throws(()=>validatePointer({schemaVersion:1,key:'../private'}));
const bad = fixture('YOUR-TITLE-HERE'); bad.recordings[0].clips[0].opus='https://YOUR-URL-HERE';
assert.throws(()=>validateCatalog(bad));
objects.set(JSON.parse(current).key,Buffer.from('{}'));
await assert.rejects(readCatalog(read),/integrity/);
console.log('catalog rollover, ordering, retention, failure atomicity, schema and integrity OK');

} finally { await rm(temp,{recursive:true,force:true}); }
