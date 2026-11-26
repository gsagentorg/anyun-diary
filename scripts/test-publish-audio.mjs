import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {prepareAudio,resolveCacheDir,resolveConcurrency} from './publish-data.mjs';

const SIGNATURE='ffmpeg version 0.0-test | -vn -c:a libopus -b:a 96k';

async function workspace(prefix){return mkdtemp(join(tmpdir(),`publish-audio-${prefix}-`));}

function fakeMedia({delay=0}={}){
  const calls=[];let inFlight=0,peak=0;
  const media=async(command,args)=>{
    if(args[0]==='-version'){calls.push({type:'version',command});return {stdout:'ffmpeg version 0.0-test',stderr:''};}
    assert.equal(command,'ffmpeg');
    calls.push({type:'transcode',args});
    inFlight++;peak=Math.max(peak,inFlight);
    try{await new Promise(r=>setTimeout(r,delay));await writeFile(args[args.length-1],Buffer.concat([Buffer.from('OggS'),Buffer.from('fake-opus')]));}
    finally{inFlight--;}
    return {stdout:'',stderr:''};
  };
  return {media,calls,peak:()=>peak,reset(){calls.length=0;peak=0;},transcodes(){return calls.filter(c=>c.type==='transcode');}};
}

async function sourcesFor(dir,count,extension='.flac'){
  const audios=[],sources={};
  for(let i=0;i<count;i++){const id=`track-${i}`;const file=join(dir,`source-${i}${extension}`);await writeFile(file,Buffer.from(`original-bytes-${i}`));audios.push({id});sources[id]=file;}
  return {audios,sources};
}

test('cache hit: identical sources are not transcoded twice',async()=>{
  const root=await workspace('hit');
  const mediaDir=await workspace('hit-sources');
  const temp=await workspace('hit-temp');
  const cacheDir=join(root,'cache');
  const {audios,sources}=await sourcesFor(mediaDir,2);
  const fake=fakeMedia();
  const first=await prepareAudio(audios,sources,temp,fake.media,{cacheDir,concurrency:2,encoderSignature:SIGNATURE});
  assert.equal(fake.transcodes().length,2);
  for(const path of first.values())assert.equal(await readFile(path,'utf8').then(v=>v.slice(0,4)),'OggS');
  fake.reset();
  const second=await prepareAudio(audios,sources,temp,fake.media,{cacheDir,concurrency:2,encoderSignature:SIGNATURE});
  assert.equal(fake.transcodes().length,0,'second run must reuse cached artifacts');
  assert.deepEqual([...second.values()],[...first.values()]);
});

test('concurrency is bounded and actually parallel',async()=>{
  const mediaDir=await workspace('conc-sources');
  const temp=await workspace('conc-temp');
  const {audios,sources}=await sourcesFor(mediaDir,8);
  const bounded=fakeMedia({delay:15});
  await prepareAudio(audios,sources,temp,bounded.media,{cacheDir:join(await workspace('conc-cache'),'c'),concurrency:4,encoderSignature:SIGNATURE});
  assert.ok(bounded.peak()<=4,`max in-flight ${bounded.peak()} exceeded 4`);
  assert.ok(bounded.peak()>=2,`max in-flight ${bounded.peak()} was not parallel`);
  const serial=fakeMedia({delay:5});
  await prepareAudio(audios,sources,temp,serial.media,{cacheDir:join(await workspace('conc-cache'),'d'),concurrency:1,encoderSignature:SIGNATURE});
  assert.equal(serial.peak(),1);
});

test('encoder signature change misses the cache',async()=>{
  const mediaDir=await workspace('sig-sources');
  const temp=await workspace('sig-temp');
  const cacheDir=join(await workspace('sig-cache'),'cache');
  const {audios,sources}=await sourcesFor(mediaDir,2);
  const fake=fakeMedia();
  await prepareAudio(audios,sources,temp,fake.media,{cacheDir,concurrency:2,encoderSignature:SIGNATURE});
  assert.equal(fake.transcodes().length,2);
  fake.reset();
  await prepareAudio(audios,sources,temp,fake.media,{cacheDir,concurrency:2,encoderSignature:SIGNATURE.replace('96k','64k')});
  assert.equal(fake.transcodes().length,2,'different codec args must not reuse the cache');
});

test('corrupt or empty cache entries fall back to transcoding',async()=>{
  const mediaDir=await workspace('bad-sources');
  const temp=await workspace('bad-temp');
  const cacheDir=join(await workspace('bad-cache'),'cache');
  const {audios,sources}=await sourcesFor(mediaDir,1);
  const fake=fakeMedia();
  const [cachedPath]=[...(await prepareAudio(audios,sources,temp,fake.media,{cacheDir,concurrency:1,encoderSignature:SIGNATURE})).values()];
  assert.equal((await readdir(cacheDir)).length,1);
  fake.reset();
  await writeFile(cachedPath,'not-an-ogg-file');
  const repaired=await prepareAudio(audios,sources,temp,fake.media,{cacheDir,concurrency:1,encoderSignature:SIGNATURE});
  assert.equal(fake.transcodes().length,1,'corrupt entry must be re-transcoded');
  assert.equal((await readFile([...repaired.values()][0])).subarray(0,4).toString(),'OggS');
  fake.reset();
  await writeFile(cachedPath,'');
  await prepareAudio(audios,sources,temp,fake.media,{cacheDir,concurrency:1,encoderSignature:SIGNATURE});
  assert.equal(fake.transcodes().length,1,'empty entry must be re-transcoded');
  await rm(join(cacheDir,'x.opus'),{force:true});
});

test('opus inputs bypass both ffmpeg and the cache',async()=>{
  const mediaDir=await workspace('opus-sources');
  const temp=await workspace('opus-temp');
  const cacheDir=join(await workspace('opus-cache'),'cache');
  const {audios,sources}=await sourcesFor(mediaDir,2,'.opus');
  const fake=fakeMedia();
  const media=await prepareAudio(audios,sources,temp,fake.media,{cacheDir,concurrency:2,encoderSignature:SIGNATURE});
  assert.equal(fake.calls.length,0,'no ffmpeg invocation expected');
  for(const a of audios)assert.equal(media.get(a.id),sources[a.id]);
  await assert.rejects(stat(cacheDir),'cache directory must not be created');
});

test('invalid concurrency values are rejected',()=>{
  for(const value of ['0','65','2.5','abc','-1'])assert.throws(()=>resolveConcurrency(value),/1 to 64/);
  assert.equal(resolveConcurrency('4'),4);
  assert.equal(resolveCacheDir('/tmp/explicit-cache'),'/tmp/explicit-cache');
});

test('first failure rejects without leaving running work',async()=>{
  const mediaDir=await workspace('fail-sources');
  const temp=await workspace('fail-temp');
  const {audios,sources}=await sourcesFor(mediaDir,4);
  let started=0,settled=0;
  const failing=async(command,args)=>{
    if(args[0]==='-version')return {stdout:'ffmpeg version 0.0-test',stderr:''};
    const mine=++started;
    await new Promise(r=>setTimeout(r,10));
    settled++;
    if(mine===1)throw Error('transcode exploded');
    await writeFile(args[args.length-1],Buffer.concat([Buffer.from('OggS'),Buffer.from('ok')]));
    return {stdout:'',stderr:''};
  };
  await assert.rejects(prepareAudio(audios,sources,temp,failing,{cacheDir:join(await workspace('fail-cache'),'c'),concurrency:2,encoderSignature:SIGNATURE}),/transcode exploded/);
  assert.equal(started,settled,'every started transcode must be awaited');
  assert.ok(started<=audios.length);
});
