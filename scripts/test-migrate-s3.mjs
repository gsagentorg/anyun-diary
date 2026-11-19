#!/usr/bin/env node
// Offline coverage for scripts/migrate-s3.mjs. No network, no real S3/B2.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {localStore} from '../src/lib/server/storage.mjs';
import {digest} from '../src/lib/server/publisher.mjs';
import {monthBounds} from '../src/lib/server/months.mjs';
import {parseArgs,targetOptions,createS3Backend,createLocalSource,sourceFromEnv,run} from './migrate-s3.mjs';

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const NOW=Date.UTC(2026,10,19,0,0,0)/1000;

const sourceEnv=(prefix)=>prefix===''
  ?{CATALOG_STORAGE:'s3',AUDIO_S3_REGION:'fixture-region',AUDIO_S3_BUCKET:'fixture-bucket',AUDIO_S3_ACCESS_KEY_ID:'fixture-key',AUDIO_S3_SECRET_ACCESS_KEY:'fixture-secret',AUDIO_S3_PATH_STYLE:'1'}
  :{CATALOG_STORAGE:'s3',S3_ENDPOINT:'https://example.invalid',S3_REGION:'fixture-region',S3_BUCKET:'fixture-bucket',S3_ACCESS_KEY_ID:'fixture-key',S3_SECRET_ACCESS_KEY:'fixture-secret',S3_FORCE_PATH_STYLE:'true',S3_PREFIX:prefix};

const TARGET_ENV={TARGET_S3_ENDPOINT:'https://s3.fixture-region.backblazeb2.test',TARGET_S3_REGION:'us-west-004',TARGET_S3_BUCKET:'fixture-target',TARGET_S3_ACCESS_KEY_ID:'fixture-target-key',TARGET_S3_SECRET_ACCESS_KEY:'fixture-target-secret',TARGET_S3_FORCE_PATH_STYLE:'false'};

function fakeClient({objects=new Map(),calls=[],latency=0,fail=null,getBytes=null,active={current:0,max:0}}={}){
  return {async send(command){
    const name=command.constructor.name;
    const input=command.input;
    calls.push({name,input});
    active.current++;
    active.max=Math.max(active.max,active.current);
    try{
      if(latency)await new Promise(resolve=>setTimeout(resolve,latency));
      const failure=fail?.(name,input,calls,objects);
      if(failure)throw failure;
      if(name==='ListObjectsV2Command'){
        const prefix=input.Prefix??'';
        const contents=[...objects.entries()].filter(([key])=>key.startsWith(prefix)).sort(([a],[b])=>a<b?-1:1).map(([key,value])=>({Key:key,Size:value.length}));
        return {Contents:contents,IsTruncated:false};
      }
      if(name==='HeadObjectCommand'){
        if(!objects.has(input.Key))throw {name:'NotFound',$metadata:{httpStatusCode:404}};
        return {ContentLength:objects.get(input.Key).length};
      }
      if(name==='GetObjectCommand'){
        if(!objects.has(input.Key))throw {name:'NoSuchKey',$metadata:{httpStatusCode:404}};
        const value=getBytes?getBytes(input.Key,objects.get(input.Key)):objects.get(input.Key);
        return {Body:{transformToByteArray:async()=>value}};
      }
      if(name==='PutObjectCommand'){objects.set(input.Key,Buffer.from(input.Body));return {};}
      if(name==='DeleteObjectCommand'){objects.delete(input.Key);return {};}
      throw Error('Unexpected command '+name);
    }finally{active.current--;}
  }};
}

function makeCatalog({prefix='data/',audioPrefix='data/audio/',generatedAt=1700000000,monthsSpec=[{id:'2026-11',rows:[{title:'Fixture'}]}]}={}){
  const objects=new Map();
  const entries=[];
  const rowsById=new Map();
  for(const spec of monthsSpec){
    const rows=spec.rows.map((row,index)=>{
      const body=row.bytes?Buffer.concat([Buffer.from('OggS'),Buffer.alloc(row.bytes,7)]):Buffer.from(`OggS-${spec.id}-${index}-${row.title}`);
      const hash=sha256(body);
      objects.set(audioPrefix+hash+'.opus',body);
      return {
        id:`${spec.id}-${index}`,
        file:`${spec.id}-${index}.opus`,
        opus:`audio/${hash}.opus`,
        title:row.title,
        startAt:row.startAt??monthBounds(spec.id).startAt+3600+index,
        monthId:spec.id,
        duration:5,
        lyrics:[]
      };
    }).sort((a,b)=>a.startAt-b.startAt||a.id.localeCompare(b.id));
    rowsById.set(spec.id,rows);
    const revision=digest(JSON.stringify(rows));
    objects.set(`${prefix}months/${spec.id}/${revision}.json`,Buffer.from(JSON.stringify({schemaVersion:2,id:spec.id,revision,audios:rows})));
    entries.push({...monthBounds(spec.id),count:rows.length,revision,key:`months/${spec.id}/${revision}.json`,available:true});
  }
  entries.sort((a,b)=>a.startAt-b.startAt);
  const revision=digest(JSON.stringify(entries));
  const manifest={schemaVersion:2,timezone:'Asia/Shanghai',generatedAt,revision,months:entries};
  objects.set(`${prefix}releases/${revision}/manifest.json`,Buffer.from(JSON.stringify(manifest)));
  objects.set(`${prefix}current.json`,Buffer.from(JSON.stringify({schemaVersion:2,releaseId:revision,key:`releases/${revision}/manifest.json`})));
  return {objects,manifest,revision,rowsById};
}

function snapshot(objects){
  return JSON.stringify([...objects.entries()].sort(([a],[b])=>a<b?-1:1).map(([key,value])=>[key,value.toString('base64')]));
}

async function runWith({source,targetObjects=new Map(),targetPrefix='backup/',argv=[],targetClientOptions={},now=NOW}){
  const calls=[];
  const targetClient=fakeClient({objects:targetObjects,calls,...targetClientOptions});
  const target=createS3Backend(targetOptions({...TARGET_ENV,TARGET_S3_PREFIX:targetPrefix}),targetClient);
  const summary=await run(argv,{}, {source,target,retries:2,sleep:async()=>{},now,log:()=>{},warn:()=>{}});
  return {summary,calls,targetObjects,targetClient};
}

function s3Source(catalog,prefix='data/'){
  return sourceFromEnv(sourceEnv(prefix),{client:fakeClient({objects:catalog.objects})});
}

const tests=[];
const test=(name,fn)=>tests.push({name,fn});
const putKeys=calls=>calls.filter(call=>call.name==='PutObjectCommand').map(call=>call.input.Key);

test('TARGET_S3_* mapping supports B2 custom endpoint and virtual-host style',async()=>{
  const options=targetOptions({...TARGET_ENV,TARGET_S3_PREFIX:'backup/'});
  assert.equal(options.clientOptions.endpoint,'https://s3.fixture-region.backblazeb2.test');
  assert.equal(options.clientOptions.region,'us-west-004');
  assert.equal(options.clientOptions.forcePathStyle,false);
  assert.equal(options.bucket,'fixture-target');
  assert.equal(options.prefix,'backup/');
  assert.equal(options.audioPrefix,'backup/audio/');
  const pathStyle=targetOptions({...TARGET_ENV,TARGET_S3_FORCE_PATH_STYLE:'true',TARGET_S3_PREFIX:'x/'});
  assert.equal(pathStyle.clientOptions.forcePathStyle,true);
  const audioPrefix=targetOptions({...TARGET_ENV,TARGET_S3_AUDIO_KEY_PREFIX:'media/opus/'});
  assert.equal(audioPrefix.audioPrefix,'media/opus/');
  assert.throws(()=>targetOptions({TARGET_S3_BUCKET:'b'}),/TARGET_S3_REGION|S3_REGION/);
  assert.throws(()=>targetOptions({...TARGET_ENV,TARGET_S3_PREFIX:'../escape'}),/PREFIX/);
});

test('argument defaults and validation',async()=>{
  const defaults=parseArgs([]);
  assert.equal(defaults.windowDays,30);
  assert.equal(defaults.months,0);
  assert.equal(defaults.concurrency,5);
  assert.equal(parseArgs(['--months','2']).windowDays,0);
  assert.equal(parseArgs(['--window-days','0','--months','2']).windowDays,0);
  assert.throws(()=>parseArgs(['--concurrency','17']),/between/);
  assert.throws(()=>parseArgs(['--window-days','nope']),/integer/);
  assert.throws(()=>parseArgs(['--unknown']),/Unknown/);
});

test('legacy objects/ audio maps onto the target audio prefix and preserves layout',async()=>{
  const catalog=makeCatalog({prefix:'',audioPrefix:'objects/'});
  const source=s3Source(catalog,'');
  const before=snapshot(catalog.objects);
  const {summary,calls,targetObjects}=await runWith({source,argv:['--window-days','0','--months','0'],targetPrefix:'backup/'});
  const keys=[...targetObjects.keys()].sort();
  assert(keys.includes('backup/current.json'));
  assert(keys.includes(`backup/releases/${catalog.revision}/manifest.json`));
  assert(keys.some(key=>/^backup\/months\/2026-11\/[a-f0-9]{64}\.json$/.test(key)));
  assert(keys.some(key=>/^backup\/audio\/[a-f0-9]{64}\.opus$/.test(key)));
  assert(!keys.some(key=>key.includes('objects/')));
  assert.equal(summary.counts.audio,1);
  assert.equal(putKeys(calls).at(-1),'backup/current.json');
  assert.equal(snapshot(catalog.objects),before);
});

test('local source uses localStore and the same logical keys',async()=>{
  const catalog=makeCatalog();
  const root=await mkdtemp(join(tmpdir(),'b2-migrate-local-'));
  try{
    const store=localStore(root);
    for(const [key,value] of catalog.objects)await store.write(key.slice('data/'.length),value);
    const source=createLocalSource({root,store});
    const {targetObjects}=await runWith({source,argv:['--window-days','0','--months','0'],targetPrefix:''});
    const keys=[...targetObjects.keys()].sort();
    assert(keys.includes('current.json'));
    assert(keys.includes(`releases/${catalog.revision}/manifest.json`));
    assert(keys.some(key=>/^audio\/[a-f0-9]{64}\.opus$/.test(key)));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('parallel transfers respect the slot limit',async()=>{
  const catalog=makeCatalog({monthsSpec:Array.from({length:8},(_,index)=>({id:`2026-0${(index%8)+1}`,rows:[{title:`M${index}`}]}))});
  const active={current:0,max:0};
  const {summary}=await runWith({source:s3Source(catalog),argv:['--window-days','0','--concurrency','3'],targetClientOptions:{latency:3,active}});
  assert.equal(summary.uploaded,summary.objects);
  assert(active.max<=3);
  assert(active.max>=2);
});

test('a second run skips matching objects (resumable)',async()=>{
  const catalog=makeCatalog();
  const first=await runWith({source:s3Source(catalog),argv:['--window-days','0']});
  assert.equal(first.summary.uploaded,first.summary.objects);
  first.calls.length=0;
  const second=await runWith({source:s3Source(catalog),argv:['--window-days','0'],targetObjects:first.targetObjects});
  assert.equal(second.summary.uploaded,0);
  assert.equal(second.summary.skipped,second.summary.objects);
  assert.equal(putKeys(second.calls).length,0);
});

test('hash mismatch in an existing target object triggers re-upload',async()=>{
  const catalog=makeCatalog();
  const first=await runWith({source:s3Source(catalog),argv:['--window-days','0']});
  const monthKey=[...first.targetObjects.keys()].find(key=>key.includes('/months/'));
  const original=first.targetObjects.get(monthKey);
  const corrupted=Buffer.from(original);
  corrupted[corrupted.length-2]=corrupted[corrupted.length-2]===48?49:48;
  first.targetObjects.set(monthKey,corrupted);
  first.calls.length=0;
  const second=await runWith({source:s3Source(catalog),argv:['--window-days','0'],targetObjects:first.targetObjects});
  assert(second.summary.uploaded>=1);
  assert(putKeys(second.calls).includes(monthKey));
  assert.deepEqual(second.targetObjects.get(monthKey),original);
});

test('verification failure never writes current.json',async()=>{
  const catalog=makeCatalog();
  const before=snapshot(catalog.objects);
  const targetObjects=new Map();
  await assert.rejects(runWith({
    source:s3Source(catalog),
    argv:['--window-days','0','--concurrency','1'],
    targetObjects,
    targetClientOptions:{getBytes:(key,value)=>key.includes('/months/')?Buffer.from('{}'):value}
  }),/Target verification failed/);
  assert(![...targetObjects.keys()].some(key=>key.endsWith('current.json')));
  assert.equal(snapshot(catalog.objects),before);
});

test('dry-run reports size without touching the target',async()=>{
  const catalog=makeCatalog({monthsSpec:[{id:'2026-11',rows:[{title:'Big',bytes:1200000}]}]});
  const calls=[];
  const targetObjects=new Map();
  const targetClient=fakeClient({objects:targetObjects,calls});
  const target=createS3Backend(targetOptions({...TARGET_ENV,TARGET_S3_PREFIX:'backup/'}),targetClient);
  const summary=await run(['--dry-run','--window-days','0','--budget-mb','1'],{}, {source:s3Source(catalog),target,now:NOW,retries:1,sleep:async()=>{},log:()=>{},warn:()=>{}});
  assert.equal(summary.dryRun,true);
  assert(summary.bytes>1024*1024);
  assert.equal(summary.budgetExceeded,true);
  assert(summary.counts.audio>=1);
  assert.equal(calls.length,0);
  assert.equal(targetObjects.size,0);
});

test('window-days trims rows and recomputes month/manifest revisions',async()=>{
  const catalog=makeCatalog({monthsSpec:[
    {id:'2026-05',rows:[{title:'Old'}]},
    {id:'2026-11',rows:[{title:'New A'},{title:'New B'}]}
  ]});
  const {summary,targetObjects}=await runWith({source:s3Source(catalog),argv:['--window-days','30'],targetPrefix:'backup/'});
  assert.equal(summary.months,1);
  assert.equal(summary.pruned,true);
  assert(![...targetObjects.keys()].some(key=>key.includes('2026-05')));
  const manifestKey=[...targetObjects.keys()].find(key=>key.includes('/releases/'));
  const manifest=JSON.parse(targetObjects.get(manifestKey));
  assert.deepEqual(manifest.months.map(entry=>entry.id),['2026-11']);
  const blockKey=manifest.months[0].key;
  const block=JSON.parse(targetObjects.get('backup/'+blockKey));
  assert.equal(block.audios.length,2);
  assert.equal(block.revision,digest(JSON.stringify(block.audios)));
  assert.equal(manifest.revision,digest(JSON.stringify(manifest.months)));

  const monthsOnly=await runWith({source:s3Source(catalog),argv:['--months','1','--window-days','0'],targetPrefix:'backup/'});
  assert.equal(monthsOnly.summary.months,1);
  assert(![...monthsOnly.targetObjects.keys()].some(key=>key.includes('2026-05')));
});

test('prune runs only after the pointer switch and keeps unmanaged keys',async()=>{
  const catalog=makeCatalog();
  const first=await runWith({source:s3Source(catalog),argv:['--window-days','0']});
  const objects=first.targetObjects;
  objects.set('backup/months/2020-01/'+('a'.repeat(64))+'.json',Buffer.from('{}'));
  objects.set('backup/audio/'+('b'.repeat(64))+'.opus',Buffer.from('stale'));
  objects.set('backup/notes.txt',Buffer.from('keep me'));
  objects.set('backup/current.json',Buffer.from('{}'));
  first.calls.length=0;
  const second=await runWith({source:s3Source(catalog),argv:['--window-days','0','--prune'],targetObjects:objects});
  assert.equal(second.summary.deleted,2);
  assert(!objects.has('backup/months/2020-01/'+('a'.repeat(64))+'.json'));
  assert(!objects.has('backup/audio/'+('b'.repeat(64))+'.opus'));
  assert.equal(objects.get('backup/notes.txt').toString(),'keep me');
  const currentPut=second.calls.findIndex(call=>call.name==='PutObjectCommand'&&call.input.Key==='backup/current.json');
  const firstDelete=second.calls.findIndex(call=>call.name==='DeleteObjectCommand');
  assert(currentPut>=0);
  assert(firstDelete>currentPut);
});

test('failed pointer write skips pruning and leaves the target otherwise intact',async()=>{
  const catalog=makeCatalog();
  const first=await runWith({source:s3Source(catalog),argv:['--window-days','0']});
  const objects=first.targetObjects;
  const stale='backup/months/2020-01/'+('c'.repeat(64))+'.json';
  objects.set(stale,Buffer.from('{}'));
  objects.set('backup/current.json',Buffer.from('{}'));
  first.calls.length=0;
  await assert.rejects(runWith({
    source:s3Source(catalog),
    argv:['--window-days','0','--prune'],
    targetObjects:objects,
    targetClientOptions:{fail:(name,input)=>name==='PutObjectCommand'&&input.Key==='backup/current.json'?{$metadata:{httpStatusCode:400}}:null}
  }),/HTTP 400/);
  assert(objects.has(stale));
  assert(first.calls.filter(call=>call.name==='DeleteObjectCommand').length===0);
});

test('429/5xx retries stop at the configured cap',async()=>{
  const catalog=makeCatalog();
  const calls=[];
  const targetObjects=new Map();
  const targetClient=fakeClient({objects:targetObjects,calls,fail:name=>name==='GetObjectCommand'?{$metadata:{httpStatusCode:503}}:null});
  const target=createS3Backend(targetOptions({...TARGET_ENV,TARGET_S3_PREFIX:'backup/'}),targetClient);
  await assert.rejects(run(['--window-days','0','--concurrency','1'],{}, {source:s3Source(catalog),target,now:NOW,retries:2,sleep:async()=>{},log:()=>{},warn:()=>{}}),/HTTP 503/);
  assert.equal(calls.filter(call=>call.name==='GetObjectCommand').length,3);
});

test('non-retryable 4xx fails immediately',async()=>{
  const catalog=makeCatalog();
  const calls=[];
  const targetObjects=new Map();
  const targetClient=fakeClient({objects:targetObjects,calls,fail:name=>name==='GetObjectCommand'?{$metadata:{httpStatusCode:400}}:null});
  const target=createS3Backend(targetOptions({...TARGET_ENV,TARGET_S3_PREFIX:'backup/'}),targetClient);
  await assert.rejects(run(['--window-days','0','--concurrency','1'],{}, {source:s3Source(catalog),target,now:NOW,retries:5,sleep:async()=>{},log:()=>{},warn:()=>{}}),/HTTP 400/);
  assert.equal(calls.filter(call=>call.name==='GetObjectCommand').length,1);
});

test('corrupt source audio aborts before the pointer and never mutates the source',async()=>{
  const catalog=makeCatalog();
  const audioKey=[...catalog.objects.keys()].find(key=>key.endsWith('.opus'));
  catalog.objects.set(audioKey,Buffer.from('not the same bytes'));
  const before=snapshot(catalog.objects);
  const targetObjects=new Map();
  await assert.rejects(runWith({source:s3Source(catalog),argv:['--window-days','0','--concurrency','1'],targetObjects}),/Source audio integrity mismatch/);
  assert(![...targetObjects.keys()].some(key=>key.endsWith('current.json')));
  assert.equal(snapshot(catalog.objects),before);
});

test('source and target at the same location are rejected',async()=>{
  const catalog=makeCatalog();
  const source=sourceFromEnv({...sourceEnv('data/'),S3_BUCKET:'shared'},{client:fakeClient({objects:catalog.objects})});
  const target=createS3Backend(targetOptions({TARGET_S3_ENDPOINT:'https://example.invalid',TARGET_S3_REGION:'us-west-004',TARGET_S3_BUCKET:'shared',TARGET_S3_ACCESS_KEY_ID:'a',TARGET_S3_SECRET_ACCESS_KEY:'b',TARGET_S3_PREFIX:'data/'}),fakeClient());
  await assert.rejects(run([],{}, {source,target,now:NOW,log:()=>{},warn:()=>{}}),/same location/);
});

let failed=0;
for(const entry of tests){
  try{await entry.fn();console.log('ok - '+entry.name);}
  catch(error){failed++;console.error('not ok - '+entry.name+'\n'+(error?.stack??error));}
}
if(failed)process.exitCode=1;
else console.log(`migrate-s3: ${tests.length} tests passed`);