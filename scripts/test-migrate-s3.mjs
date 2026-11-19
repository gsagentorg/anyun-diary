#!/usr/bin/env node
// Offline coverage for scripts/migrate-s3.mjs. No network, no real S3/B2.
import assert from 'node:assert/strict';
import {mkdtemp,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Readable} from 'node:stream';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {localStore} from '../src/lib/server/storage.mjs';
import {digest} from '../src/lib/server/publisher.mjs';
import {monthBounds} from '../src/lib/server/months.mjs';
import {parseArgs,targetOptions,createS3Backend,createLocalSource,sourceFromEnv,createAudioCache,resolveCacheDir,run} from './migrate-s3.mjs';

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const NOW=Date.UTC(2026,10,19,0,0,0)/1000;

const sourceEnv=(prefix)=>prefix===''
  ?{CATALOG_STORAGE:'s3',AUDIO_S3_REGION:'fixture-region',AUDIO_S3_BUCKET:'fixture-bucket',AUDIO_S3_ACCESS_KEY_ID:'fixture-key',AUDIO_S3_SECRET_ACCESS_KEY:'fixture-secret',AUDIO_S3_PATH_STYLE:'1'}
  :{CATALOG_STORAGE:'s3',S3_ENDPOINT:'https://example.invalid',S3_REGION:'fixture-region',S3_BUCKET:'fixture-bucket',S3_ACCESS_KEY_ID:'fixture-key',S3_SECRET_ACCESS_KEY:'fixture-secret',S3_FORCE_PATH_STYLE:'true',S3_PREFIX:prefix};

const TARGET_ENV={TARGET_S3_ENDPOINT:'https://s3.fixture-region.backblazeb2.test',TARGET_S3_REGION:'us-west-004',TARGET_S3_BUCKET:'fixture-target',TARGET_S3_ACCESS_KEY_ID:'fixture-target-key',TARGET_S3_SECRET_ACCESS_KEY:'fixture-target-secret',TARGET_S3_FORCE_PATH_STYLE:'false'};

const bodyToBuffer=async body=>{
  if(Buffer.isBuffer(body))return body;
  if(body&&typeof body.getReader==='function'){
    const reader=body.getReader();
    const chunks=[];
    for(;;){const {done,value}=await reader.read();if(done)break;chunks.push(Buffer.from(value));}
    return Buffer.concat(chunks);
  }
  if(body&&typeof body[Symbol.asyncIterator]==='function'){
    const chunks=[];
    for await(const chunk of body)chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  if(body&&typeof body.pipe==='function')return await new Promise((resolveBody,reject)=>{
    const chunks=[];
    body.on('data',chunk=>chunks.push(chunk));
    body.on('error',reject);
    body.on('end',()=>resolveBody(Buffer.concat(chunks)));
  });
  return Buffer.from(body);
};

function fakeClient({objects=new Map(),calls=[],latency=0,fail=null,getBytes=null,active={current:0,max:0}}={}){
  const toBodyBuffer=bodyToBuffer;
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
      if(name==='PutObjectCommand'){objects.set(input.Key,await toBodyBuffer(input.Body));return {};}
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
  // Pruning is built into every publish run; --no-prune is the opt-out and
  // --prune remains a legacy alias.
  assert.equal(defaults.prune,true);
  assert.equal(parseArgs(['--no-prune']).prune,false);
  assert.equal(parseArgs(['--prune']).prune,true);
  assert.throws(()=>parseArgs(['--prune','--no-prune']),/either --prune or --no-prune/);
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

test('prune runs by default only after the pointer switch and keeps unmanaged keys',async()=>{
  const catalog=makeCatalog();
  const first=await runWith({source:s3Source(catalog),argv:['--window-days','0']});
  const objects=first.targetObjects;
  objects.set('backup/months/2020-01/'+('a'.repeat(64))+'.json',Buffer.from('{}'));
  objects.set('backup/audio/'+('b'.repeat(64))+'.opus',Buffer.from('stale'));
  objects.set('backup/notes.txt',Buffer.from('keep me'));
  objects.set('backup/current.json',Buffer.from('{}'));
  first.calls.length=0;
  const second=await runWith({source:s3Source(catalog),argv:['--window-days','0'],targetObjects:objects});
  assert.equal(second.summary.pruneMode,'auto');
  assert.equal(second.summary.deleted,2);
  assert.equal(second.summary.deletedBytes,Buffer.byteLength('{}')+Buffer.byteLength('stale'));
  assert(!objects.has('backup/months/2020-01/'+('a'.repeat(64))+'.json'));
  assert(!objects.has('backup/audio/'+('b'.repeat(64))+'.opus'));
  assert.equal(objects.get('backup/notes.txt').toString(),'keep me');
  const currentPut=second.calls.findIndex(call=>call.name==='PutObjectCommand'&&call.input.Key==='backup/current.json');
  const firstDelete=second.calls.findIndex(call=>call.name==='DeleteObjectCommand');
  assert(currentPut>=0);
  assert(firstDelete>currentPut);
  // "list the full target, then delete": every listing precedes the first delete
  const firstList=second.calls.findIndex(call=>call.name==='ListObjectsV2Command');
  assert(firstList>=0&&firstList<firstDelete);
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
    argv:['--window-days','0'],
    targetObjects:objects,
    targetClientOptions:{fail:(name,input)=>name==='PutObjectCommand'&&input.Key==='backup/current.json'?{$metadata:{httpStatusCode:400}}:null}
  }),/HTTP 400/);
  assert(objects.has(stale));
  assert(first.calls.filter(call=>call.name==='DeleteObjectCommand').length===0);
});

test('a rolling window publish reclaims out-of-window objects by default',async()=>{
  const catalog=makeCatalog({monthsSpec:[
    {id:'2026-05',rows:[{title:'Old A'},{title:'Old B'}]},
    {id:'2026-11',rows:[{title:'New'}]}
  ]});
  const targetObjects=new Map();
  const full=await runWith({source:s3Source(catalog),argv:['--window-days','0','--months','0'],targetObjects});
  assert.equal(full.summary.deleted,0);
  assert([...targetObjects.keys()].some(key=>key.includes('2026-05')));
  const sizes=new Map([...targetObjects.entries()].map(([key,value])=>[key,value.length]));
  // Same command the publish pipeline runs, no extra flags: the 30-day window
  // now drops 2026-05, and the run reclaims those objects on its own.
  const rolling=await runWith({source:s3Source(catalog),argv:[],targetObjects});
  assert.equal(rolling.summary.months,1);
  const removed=[...sizes.keys()].filter(key=>!targetObjects.has(key));
  assert(removed.length>0);
  assert(![...targetObjects.keys()].some(key=>key.includes('2026-05')));
  assert.equal(rolling.summary.deleted,removed.length);
  assert.equal(rolling.summary.deletedBytes,removed.reduce((total,key)=>total+sizes.get(key),0));
  assert.equal(rolling.summary.pruneMode,'auto');
  assert.match(rolling.summary.versioningHint,/versioned bucket/);
});

test('--no-prune opts out of reclamation and keeps every stale object',async()=>{
  const catalog=makeCatalog({monthsSpec:[{id:'2026-05',rows:[{title:'Old'}]},{id:'2026-11',rows:[{title:'New'}]}]});
  const targetObjects=new Map();
  await runWith({source:s3Source(catalog),argv:['--window-days','0','--months','0'],targetObjects});
  const before=[...targetObjects.keys()];
  const rolling=await runWith({source:s3Source(catalog),argv:['--no-prune'],targetObjects});
  assert.equal(rolling.summary.pruneMode,'disabled');
  assert.equal(rolling.summary.deleted,0);
  assert.equal(rolling.summary.deletedBytes,0);
  assert.equal(rolling.calls.filter(call=>call.name==='DeleteObjectCommand').length,0);
  assert.equal(rolling.calls.filter(call=>call.name==='ListObjectsV2Command').length,0);
  for(const key of before)assert(targetObjects.has(key),`${key} must survive --no-prune`);
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

// ---------- production HTTP API source (SOURCE_AUDIO_BASE chain) ----------

// Local mock of the production API surface: /api/current, /api/catalog (with
// optional availability flip, mirroring MAX_QUERY_MONTHS), /api/month/<id>
// (release-pinned, 404 for unavailable months), and /api/audio/<hash>.opus
// 307-redirecting to a range-capable /storage/<hash>.opus backend.
function startMockApi(catalog,{flip=[],headLengthless=false,catalogStatus=200,catalogRevisionOverride,slow=()=>0}={}){
  const requests=[];
  // makeCatalog may prefix physical keys; look objects up by logical suffix.
  const find=suffix=>{for(const [key,value] of catalog.objects)if(key===suffix||key.endsWith('/'+suffix))return value;};
  const manifest=JSON.parse(find('releases/'+catalog.revision+'/manifest.json').toString());
  const releaseId=JSON.parse(find('current.json').toString()).releaseId;
  const server=createServer((req,res)=>{
    req.on('error',()=>{});
    res.on('error',()=>{});
    requests.push({method:req.method,path:req.url,range:req.headers.range});
    const respond=()=>{
      try{
        const url=new URL(req.url,'http://127.0.0.1');
        if(req.method==='GET'&&url.pathname==='/api/current'){
          res.writeHead(200,{'content-type':'application/json','cache-control':'private, no-cache'});
          res.end(JSON.stringify({schemaVersion:2,releaseId,queryMonthLimit:0,period:'2026-11'}));
          return;
        }
        if(req.method==='GET'&&url.pathname==='/api/catalog'){
          if(catalogStatus!==200){res.writeHead(catalogStatus);res.end();return;}
          const payload={...manifest,queryMonthLimit:0,months:manifest.months.map(entry=>({...entry,available:entry.available&&!flip.includes(entry.id)}))};
          if(catalogRevisionOverride!==undefined)payload.revision=catalogRevisionOverride;
          res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
          res.end(JSON.stringify(payload));
          return;
        }
        const month=url.pathname.match(/^\/api\/month\/(\d{4}-(?:0[1-9]|1[0-2]))$/);
        if(month){
          if(url.searchParams.get('release')!==releaseId){res.writeHead(404);res.end();return;}
          const entry=manifest.months.find(e=>e.id===month[1]);
          if(!entry||!entry.available||flip.includes(entry.id)){res.writeHead(404,{'content-type':'application/json'});res.end(JSON.stringify({error:'Month unavailable'}));return;}
          res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
          res.end(find(entry.key));
          return;
        }
        const audio=url.pathname.match(/^\/api\/audio\/([a-f0-9]{64})\.opus$/);
        if(audio){
          res.writeHead(307,{location:`http://${req.headers.host}/storage/${audio[1]}.opus`,'cache-control':'private, no-store'});
          res.end();
          return;
        }
        const storage=url.pathname.match(/^\/storage\/([a-f0-9]{64})\.opus$/);
        if(storage){
          const body=find('audio/'+storage[1]+'.opus');
          if(!body){res.writeHead(404);res.end();return;}
          const headers={'content-type':'audio/ogg','accept-ranges':'bytes','cache-control':'public,max-age=31536000,immutable'};
          if(req.method==='HEAD'){
            if(!headLengthless)headers['content-length']=String(body.length);
            res.writeHead(200,headers);res.end();return;
          }
          const range=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range??'');
          if(range){
            const start=Number(range[1]),end=Math.min(Number(range[2]),body.length-1);
            res.writeHead(206,{...headers,'content-range':`bytes ${start}-${end}/${body.length}`,'content-length':String(end-start+1)});
            res.end(body.slice(start,end+1));return;
          }
          res.writeHead(200,{...headers,'content-length':String(body.length)});
          res.end(body);
          return;
        }
        res.writeHead(404);res.end();
      }catch{res.writeHead(503);res.end();}
    };
    const delay=slow(req.method,req.url);
    if(delay)setTimeout(respond,delay);else respond();
  });
  return {
    requests,
    server,
    start:async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`;},
    stop:()=>new Promise(resolve=>{server.closeIdleConnections?.();server.close(resolve);})
  };
}

async function runHttp(argv,{catalog,mock,targetObjects=new Map(),envExtra={},targetClientOptions={},deps={},cacheDir}={}){
  const base=await mock.start();
  // Every run gets its own cache dir so tests never touch the real default
  // ($TMPDIR/anyun-migrate-s3) shared location.
  const dir=cacheDir??await mkdtemp(join(tmpdir(),'b2-migrate-cache-'));
  const calls=[];
  const targetClient=fakeClient({objects:targetObjects,calls,...targetClientOptions});
  const env={SOURCE_AUDIO_BASE:base,...TARGET_ENV,TARGET_S3_PREFIX:'backup/',MIGRATE_CACHE_DIR:dir,...envExtra};
  try{
    const summary=await run(argv,env,{s3Client:targetClient,retries:2,sleep:async()=>{},now:NOW,log:()=>{},warn:()=>{},...deps});
    return {summary,calls,targetObjects,base,cacheDir:dir};
  }finally{
    await mock.stop();
    await rm(dir,{recursive:true,force:true});
  }
}

function fakeBlobBackend(objects){
  const puts=[];
  const response=(key,status=200)=>{
    const body=objects.get(key);
    if(body===undefined)return new Response(null,{status:404});
    return new Response(body,{status,headers:{'content-length':String(body.length),'content-type':key.endsWith('.opus')?'audio/ogg':'application/json'}});
  };
  const fetcher=async url=>response(new URL(url).pathname.replace(/^\//,''));
  const sdk={
    put:async(key,bytes)=>{puts.push(key);objects.set(key,await bodyToBuffer(bytes));},
    del:async url=>{objects.delete(new URL(url).pathname.replace(/^\//,''));},
    get:async key=>objects.get(key)
  };
  return {puts,fetcher,sdk,objects};
}

test('AUDIO_S3_* legacy env maps onto the target chain',async()=>{
  const options=targetOptions({AUDIO_S3_ENDPOINT:'https://s3.example.invalid',AUDIO_S3_REGION:'fixture-region',AUDIO_S3_BUCKET:'fixture-bucket',AUDIO_S3_ACCESS_KEY_ID:'k',AUDIO_S3_SECRET_ACCESS_KEY:'s',AUDIO_S3_PATH_STYLE:'1',AUDIO_S3_KEY_PREFIX:'legacy/'});
  assert.equal(options.clientOptions.endpoint,'https://s3.example.invalid');
  assert.equal(options.clientOptions.forcePathStyle,true);
  assert.equal(options.audioPrefix,'legacy/');
  const plain=targetOptions({AUDIO_S3_ENDPOINT:'https://s3.example.invalid',AUDIO_S3_REGION:'fixture-region',AUDIO_S3_BUCKET:'fixture-bucket',AUDIO_S3_ACCESS_KEY_ID:'k',AUDIO_S3_SECRET_ACCESS_KEY:'s'});
  // The mapping feeds s3Options pure S3_* names, so legacy markers never flip
  // the target layout: without an explicit audio prefix the target uses audio/.
  assert.equal(plain.audioPrefix,'audio/');
  assert.equal(plain.prefix,'');
  assert.throws(()=>targetOptions({AUDIO_S3_BUCKET:'b'}),/S3_REGION/);
});

test('http source migrates the full v2 object set with the pointer last',async()=>{
  const catalog=makeCatalog({monthsSpec:[{id:'2026-05',rows:[{title:'Old'}]},{id:'2026-11',rows:[{title:'New'}]}]});
  const mock=startMockApi(catalog);
  const {summary,calls,targetObjects}=await runHttp(['--window-days','0','--months','0'],{catalog,mock});
  assert.equal(summary.droppedMonths,0);
  assert.equal(summary.normalized,false);
  const keys=[...targetObjects.keys()].sort();
  assert(keys.includes('backup/current.json'));
  assert(keys.includes(`backup/releases/${catalog.revision}/manifest.json`));
  assert(keys.some(key=>/^backup\/months\/2026-05\/[a-f0-9]{64}\.json$/.test(key)));
  assert(keys.some(key=>/^backup\/months\/2026-11\/[a-f0-9]{64}\.json$/.test(key)));
  assert(keys.some(key=>/^backup\/audio\/[a-f0-9]{64}\.opus$/.test(key)));
  assert.equal(putKeys(calls).at(-1),'backup/current.json');
  assert.equal(mock.requests.filter(r=>r.path==='/api/current').length,1);
  assert(mock.requests.some(r=>r.method==='GET'&&/^\/api\/audio\/[a-f0-9]{64}\.opus$/.test(r.path)));
  assert(mock.requests.some(r=>r.method==='GET'&&/^\/storage\/[a-f0-9]{64}\.opus$/.test(r.path)));
  const manifest=JSON.parse(targetObjects.get(`backup/releases/${catalog.revision}/manifest.json`));
  assert.equal(manifest.revision,digest(JSON.stringify(manifest.months)));
  const pointer=JSON.parse(targetObjects.get('backup/current.json'));
  assert.deepEqual(Object.keys(pointer).sort(),['key','releaseId','schemaVersion']);
  assert.equal(pointer.releaseId,manifest.revision);
  assert.equal(pointer.key,`releases/${manifest.revision}/manifest.json`);
  const audioPut=calls.find(call=>call.name==='PutObjectCommand'&&call.input.Key.endsWith('.opus'));
  assert.equal(audioPut.input.ContentType,'audio/ogg');
});

test('http source probes sizes with HEAD and falls back to range when HEAD lacks length',async()=>{
  const catalog=makeCatalog({monthsSpec:[{id:'2026-11',rows:[{title:'Only'}]}]});
  const mockA=startMockApi(catalog);
  const a=await runHttp(['--window-days','0','--months','0'],{catalog,mock:mockA});
  assert(mockA.requests.some(r=>r.method==='HEAD'&&/^\/storage\/[a-f0-9]{64}\.opus$/.test(r.path)));
  assert(!mockA.requests.some(r=>r.range));
  assert.equal(a.summary.counts.audio,1);
  const mockB=startMockApi(catalog,{headLengthless:true});
  const b=await runHttp(['--window-days','0','--months','0'],{catalog,mock:mockB});
  assert(mockB.requests.some(r=>r.method==='GET'&&/^\/storage\/[a-f0-9]{64}\.opus$/.test(r.path)&&r.range==='bytes=0-1'));
  assert.equal(b.summary.counts.audio,1);
  assert.equal([...b.targetObjects.keys()].filter(key=>key.endsWith('.opus')).length,1);
});

test('api availability flip drops unreadable months and rebuilds the manifest',async()=>{
  const catalog=makeCatalog({monthsSpec:[{id:'2026-05',rows:[{title:'Old'}]},{id:'2026-11',rows:[{title:'New'}]}]});
  const mock=startMockApi(catalog,{flip:['2026-05']});
  const {summary,targetObjects}=await runHttp(['--window-days','0','--months','0'],{catalog,mock});
  assert.equal(summary.droppedMonths,1);
  assert.equal(summary.months,1);
  assert(!mock.requests.some(r=>r.path?.startsWith('/api/month/2026-05')));
  assert(![...targetObjects.keys()].some(key=>key.includes('2026-05')));
  const manifestKey=[...targetObjects.keys()].find(key=>key.includes('/releases/'));
  const manifest=JSON.parse(targetObjects.get(manifestKey));
  assert.deepEqual(manifest.months.map(entry=>entry.id),['2026-11']);
  assert.equal(manifest.revision,digest(JSON.stringify(manifest.months)));
  const sourceEntry=catalog.manifest.months.find(entry=>entry.id==='2026-11');
  assert(targetObjects.has('backup/'+sourceEntry.key));
  const pointer=JSON.parse(targetObjects.get('backup/current.json'));
  assert.equal(pointer.releaseId,manifest.revision);
  assert.equal(pointer.key,`releases/${manifest.revision}/manifest.json`);
  assert.notEqual(manifest.revision,catalog.revision);
});

test('window-days prunes http source rows and recomputes revisions',async()=>{
  const catalog=makeCatalog({monthsSpec:[{id:'2026-05',rows:[{title:'Old'}]},{id:'2026-11',rows:[{title:'New'}]}]});
  const oldHash=[...catalog.rowsById.get('2026-05')][0].opus;
  const mock=startMockApi(catalog);
  const {summary,targetObjects}=await runHttp(['--window-days','30'],{catalog,mock});
  assert.equal(summary.months,1);
  assert.equal(summary.pruned,true);
  assert(![...targetObjects.keys()].some(key=>key.includes('2026-05')));
  assert(!mock.requests.some(r=>r.path===`/api/audio/${oldHash.slice(6)}`));
  const manifestKey=[...targetObjects.keys()].find(key=>key.includes('/releases/'));
  const manifest=JSON.parse(targetObjects.get(manifestKey));
  assert.deepEqual(manifest.months.map(entry=>entry.id),['2026-11']);
  const block=JSON.parse(targetObjects.get('backup/'+manifest.months[0].key));
  assert.equal(block.revision,digest(JSON.stringify(block.audios)));
});

test('existing target objects are skipped without content reads (legacy chain semantics)',async()=>{
  const catalog=makeCatalog({monthsSpec:[{id:'2026-11',rows:[{title:'New'}]}]});
  const first=await runHttp(['--window-days','0','--months','0'],{catalog,mock:startMockApi(catalog)});
  assert.equal(first.summary.uploaded,first.summary.objects);
  const mock=startMockApi(catalog);
  const second=await runHttp(['--window-days','0','--months','0'],{catalog,mock,targetObjects:first.targetObjects});
  assert.equal(second.summary.uploaded,0);
  assert.equal(second.summary.skipped,second.summary.objects);
  assert.equal(putKeys(second.calls).length,0);
  assert.equal(second.calls.filter(call=>call.name==='GetObjectCommand').length,1);
});

test('verify-full compares full digests and skips matching objects',async()=>{
  const catalog=makeCatalog({monthsSpec:[{id:'2026-11',rows:[{title:'New'}]}]});
  const first=await runHttp(['--window-days','0','--months','0','--verify-full'],{catalog,mock:startMockApi(catalog)});
  assert.equal(first.summary.uploaded,first.summary.objects);
  assert.equal(first.summary.verifyFull,true);
  const second=await runHttp(['--window-days','0','--months','0','--verify-full'],{catalog,mock:startMockApi(catalog),targetObjects:first.targetObjects});
  assert.equal(second.summary.uploaded,0);
  assert.equal(second.summary.skipped,second.summary.objects);
  assert.equal(putKeys(second.calls).length,0);
  assert(second.calls.filter(call=>call.name==='GetObjectCommand').length>=second.summary.objects-1);
});

test('verify-full rejects a differing existing object without re-uploading',async()=>{
  const catalog=makeCatalog({monthsSpec:[{id:'2026-11',rows:[{title:'New'}]}]});
  const first=await runHttp(['--window-days','0','--months','0'],{catalog,mock:startMockApi(catalog)});
  const audioKey=[...first.targetObjects.keys()].find(key=>key.endsWith('.opus'));
  const original=first.targetObjects.get(audioKey);
  const corrupted=Buffer.from(original);
  corrupted[corrupted.length-2]=corrupted[corrupted.length-2]===48?49:48;
  first.targetObjects.set(audioKey,corrupted);
  await assert.rejects(runHttp(['--window-days','0','--months','0','--verify-full'],{catalog,mock:startMockApi(catalog),targetObjects:first.targetObjects}),/Destination differs; existing object not uploaded/);
  assert.deepEqual(first.targetObjects.get(audioKey),corrupted);
});

test('429 from the target never retries automatically',async()=>{
  const catalog=makeCatalog({monthsSpec:[{id:'2026-11',rows:[{title:'New'}]}]});
  const attempts=[];
  await assert.rejects(runHttp(['--window-days','0','--months','0','--concurrency','1'],{
    catalog,mock:startMockApi(catalog),
    targetClientOptions:{fail:(name,input)=>{if(name==='PutObjectCommand'){attempts.push(input.Key);return {$metadata:{httpStatusCode:429}};}return null;}}
  }),/throttled \(HTTP 429\)/);
  assert.equal(attempts.length,1);
});

test('429 from the source API fails immediately without retry',async()=>{
  const catalog=makeCatalog({monthsSpec:[{id:'2026-11',rows:[{title:'New'}]}]});
  const mock=startMockApi(catalog,{catalogStatus:429});
  await assert.rejects(runHttp(['--window-days','0','--months','0'],{catalog,mock}),/Source API request failed \(HTTP 429\)/);
  assert.equal(mock.requests.filter(r=>r.path==='/api/catalog').length,1);
});

test('source release change between api calls is detected',async()=>{
  const catalog=makeCatalog({monthsSpec:[{id:'2026-11',rows:[{title:'New'}]}]});
  const mock=startMockApi(catalog,{catalogRevisionOverride:'f'.repeat(64)});
  await assert.rejects(runHttp(['--window-days','0','--months','0'],{catalog,mock}),/Source release changed during migration/);
});

test('http source timeout fails without retry',async()=>{
  const catalog=makeCatalog({monthsSpec:[{id:'2026-11',rows:[{title:'New'}]}]});
  const mock=startMockApi(catalog,{slow:(method,path)=>path==='/api/current'?400:0});
  await assert.rejects(runHttp(['--timeout-ms','50','--window-days','0','--months','0'],{catalog,mock}),/Source API request failed \(timeout\)/);
  assert.equal(mock.requests.filter(r=>r.path==='/api/current').length,1);
});

// ---------- audio temp-file cache (HTTP source chain) ----------

test('audio cache lifecycle: .part download, rename, reuse, corrupt re-download, cleanup',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'b2-migrate-cache-'));
  const body=Buffer.concat([Buffer.from('OggS'),Buffer.alloc(1000,7)]);
  const hash=sha256(body);
  const cache=createAudioCache({dir});
  try{
    // download: writes .part, renames to the hash-named file, streams the digest
    const entry=await cache.acquire(hash,{size:body.length,download:()=>Readable.from([Buffer.concat([body])])});
    assert.equal(entry.reused,false);
    assert.equal(entry.digest,hash);
    assert.equal(entry.size,body.length);
    assert.equal((await stat(cache.pathFor(hash))).size,body.length);
    assert.equal((await readdir(dir)).filter(name=>name.endsWith('.part')).length,0);
    assert(cache.stats().peakBytes>=body.length);
    // no release here: an interrupted run leaves the file behind
    // reuse: same hash already complete (size+digest verified) - no download.
    // A fresh cache over the same directory reuses it.
    let downloads=0;
    const resumed=createAudioCache({dir});
    const reusedEntry=await resumed.acquire(hash,{size:body.length,download:()=>{downloads++;return Readable.from([body]);}});
    assert.equal(reusedEntry.reused,true);
    assert.equal(downloads,0);
    assert.equal(resumed.stats().reused,1);
    await resumed.release(hash);
    // corrupt cache (right name, wrong bytes) - re-downloaded
    await writeFile(cache.pathFor(hash),Buffer.from('corrupted'));
    const redownloaded=await cache.acquire(hash,{size:body.length,download:()=>{downloads++;return Readable.from([body]);}});
    assert.equal(redownloaded.reused,false);
    assert.equal(downloads,1);
    assert.equal(redownloaded.digest,hash);
    await cache.release(hash);
    // a failed download leaves no .part and reports a source failure
    const failing=sha256(Buffer.from('other audio'));
    await assert.rejects(cache.acquire(failing,{size:5,download:()=>new Readable({read(){this.push(Buffer.from('partial'));this.destroy(Error('boom'));}})}),/Source audio download failed/);
    assert.equal((await readdir(dir)).filter(name=>name.endsWith('.part')).length,0);
    // clear(): the dedicated directory does not outlive the cache
    await writeFile(cache.pathFor(hash),body);
    await cache.clear();
    await assert.rejects(readdir(dir),{code:'ENOENT'});
    // clear() on a missing directory is a no-op
    await cache.clear();
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('http audio downloads through the cache and uploads streamed from the file',async()=>{
  const catalog=makeCatalog({monthsSpec:[{id:'2026-11',rows:[{title:'Big',bytes:300000}]}]});
  const audioBody=[...catalog.objects.values()].find(value=>value.length>300000);
  const mock=startMockApi(catalog);
  const dir=await mkdtemp(join(tmpdir(),'b2-migrate-cache-'));
  const {summary,calls,cacheDir}=await runHttp(['--window-days','0','--months','0'],{catalog,mock,cacheDir:dir});
  assert.equal(cacheDir,dir);
  assert.equal(summary.cache.downloads,1);
  assert.equal(summary.cache.reused,0);
  assert.equal(summary.cache.peakBytes,audioBody.length);
  const audioPut=calls.find(call=>call.name==='PutObjectCommand'&&call.input.Key.endsWith('.opus'));
  assert(audioPut);
  // streamed upload: the Body is a file stream, never an in-memory buffer
  assert(typeof audioPut.input.Body.pipe==='function');
  assert(!Buffer.isBuffer(audioPut.input.Body));
  // the dedicated directory is emptied and removed when the run exits
  await assert.rejects(readdir(dir),{code:'ENOENT'});
});

test('a resumed run reuses the cached audio without re-downloading',async()=>{
  const catalog=makeCatalog({monthsSpec:[{id:'2026-11',rows:[{title:'New'}]}]});
  const audioKey=[...catalog.objects.keys()].find(key=>key.endsWith('.opus'));
  const body=catalog.objects.get(audioKey);
  const hash=audioKey.split('/').pop().slice(0,-5);
  const dir=await mkdtemp(join(tmpdir(),'b2-migrate-cache-'));
  await writeFile(join(dir,hash+'.opus'),body);
  const mock=startMockApi(catalog);
  const {summary,targetObjects}=await runHttp(['--window-days','0','--months','0'],{catalog,mock,cacheDir:dir});
  assert.equal(summary.cache.reused,1);
  assert.equal(summary.cache.downloads,0);
  // no audio GET hit the source (the HEAD size probe is plan-time and allowed)
  assert(!mock.requests.some(r=>r.method==='GET'&&/^\/storage\/[a-f0-9]{64}\.opus$/.test(r.path)));
  const uploaded=[...targetObjects.keys()].find(key=>key.endsWith('.opus'));
  assert.deepEqual(targetObjects.get(uploaded),body);
});

test('objects already present at the target are skipped without downloading to the cache',async()=>{
  const catalog=makeCatalog({monthsSpec:[{id:'2026-11',rows:[{title:'New'}]}]});
  const first=await runHttp(['--window-days','0','--months','0'],{catalog,mock:startMockApi(catalog)});
  const mock=startMockApi(catalog);
  const second=await runHttp(['--window-days','0','--months','0'],{catalog,mock,targetObjects:first.targetObjects});
  assert.equal(second.summary.uploaded,0);
  assert.equal(second.summary.cache.downloads,0);
  assert.equal(second.summary.cache.reused,0);
  assert(!mock.requests.some(r=>r.method==='GET'&&/^\/storage\/[a-f0-9]{64}\.opus$/.test(r.path)));
});

test('verify-full re-reads the target and the cache file without a second source download',async()=>{
  const catalog=makeCatalog({monthsSpec:[{id:'2026-11',rows:[{title:'New'}]}]});
  const mock=startMockApi(catalog);
  const {summary}=await runHttp(['--window-days','0','--months','0','--verify-full'],{catalog,mock});
  assert.equal(summary.verifyFull,true);
  assert.equal(summary.cache.downloads,1);
  const audioDownloads=mock.requests.filter(r=>r.method==='GET'&&/^\/storage\/[a-f0-9]{64}\.opus$/.test(r.path));
  assert.equal(audioDownloads.length,1);
});

test('a failed run still clears the cache directory',async()=>{
  const catalog=makeCatalog({monthsSpec:[{id:'2026-11',rows:[{title:'New'}]}]});
  const mock=startMockApi(catalog);
  const dir=await mkdtemp(join(tmpdir(),'b2-migrate-cache-'));
  await assert.rejects(runHttp(['--window-days','0','--months','0','--concurrency','1'],{
    catalog,mock,cacheDir:dir,
    targetClientOptions:{fail:(name,input)=>name==='PutObjectCommand'&&input.Key.endsWith('.opus')?{$metadata:{httpStatusCode:500}}:null}
  }),/HTTP 500/);
  await assert.rejects(readdir(dir),{code:'ENOENT'});
});

test('insufficient cache disk space aborts with --cache-dir guidance',async()=>{
  const catalog=makeCatalog({monthsSpec:[{id:'2026-11',rows:[{title:'New',bytes:500000}]}]});
  const mock=startMockApi(catalog);
  const dir=await mkdtemp(join(tmpdir(),'b2-migrate-cache-'));
  const targetObjects=new Map();
  const statfsFake=async()=>({bsize:4096,bfree:100000,bavail:10,blocks:100000});
  await assert.rejects(runHttp(['--window-days','0','--months','0'],{
    catalog,mock,cacheDir:dir,targetObjects,deps:{statfs:statfsFake}
  }),/Insufficient cache disk space.*--cache-dir/);
  // no pointer switch ever happened
  assert(![...targetObjects.keys()].some(key=>key.endsWith('current.json')));
});

test('cache directory options validate and resolve with CLI precedence',async()=>{
  assert.throws(()=>parseArgs(['--cache-dir']),/--cache-dir/);
  assert.throws(()=>parseArgs(['--cache-dir','  ']),/--cache-dir/);
  assert.equal(parseArgs(['--cache-dir','/tmp/m']).cacheDir,'/tmp/m');
  assert.equal(resolveCacheDir({}),join(tmpdir(),'anyun-migrate-s3'));
  assert.equal(resolveCacheDir({MIGRATE_CACHE_DIR:'/var/cache/m'}),'/var/cache/m');
  assert.equal(resolveCacheDir({MIGRATE_CACHE_DIR:'/var/cache/m'},'/cli/dir'),resolve('/cli/dir'));
  assert.throws(()=>resolveCacheDir({MIGRATE_CACHE_DIR:'  '}),/Invalid cache directory/);
  assert.throws(()=>createAudioCache({}),/Invalid cache directory/);
  assert.throws(()=>createAudioCache({dir:'/tmp/x',reserveBytes:-1}),/Invalid cache reserve/);
});

test('corrupt cached audio is re-downloaded and the target still receives the correct bytes',async()=>{
  const catalog=makeCatalog({monthsSpec:[{id:'2026-11',rows:[{title:'New'}]}]});
  const audioKey=[...catalog.objects.keys()].find(key=>key.endsWith('.opus'));
  const body=catalog.objects.get(audioKey);
  const hash=audioKey.split('/').pop().slice(0,-5);
  const dir=await mkdtemp(join(tmpdir(),'b2-migrate-cache-'));
  await writeFile(join(dir,hash+'.opus'),Buffer.from('corrupt but plausible'));
  const mock=startMockApi(catalog);
  const {summary,targetObjects}=await runHttp(['--window-days','0','--months','0'],{catalog,mock,cacheDir:dir});
  assert.equal(summary.cache.downloads,1);
  assert.equal(summary.cache.reused,0);
  assert(mock.requests.some(r=>r.method==='GET'&&/^\/storage\/[a-f0-9]{64}\.opus$/.test(r.path)));
  const uploaded=[...targetObjects.keys()].find(key=>key.endsWith('.opus'));
  assert.deepEqual(targetObjects.get(uploaded),body);
});

test('blob target receives the full object set through the blob store',async()=>{
  const catalog=makeCatalog({monthsSpec:[{id:'2026-05',rows:[{title:'Old'}]},{id:'2026-11',rows:[{title:'New'}]}]});
  const mock=startMockApi(catalog);
  const base=await mock.start();
  const blob=fakeBlobBackend(new Map());
  const cacheDir=await mkdtemp(join(tmpdir(),'b2-migrate-cache-'));
  try{
    const summary=await run(['--window-days','0','--months','0'],{
      SOURCE_AUDIO_BASE:base,
      TARGET_STORAGE:'blob',
      BLOB_BASE_URL:'https://blob.fixture.invalid',
      BLOB_READ_WRITE_TOKEN:'fixture-token',
      MIGRATE_CACHE_DIR:cacheDir
    },{blobFetcher:blob.fetcher,blobSdk:blob.sdk,retries:2,sleep:async()=>{},now:NOW,log:()=>{},warn:()=>{}});
    assert.equal(summary.uploaded,summary.objects);
    // Blob has no listing: the implicit prune is reported as skipped, not fatal.
    assert.equal(summary.pruneMode,'skipped');
    assert.equal(summary.deleted,0);
    const keys=[...blob.objects.keys()].sort();
    assert(keys.includes('current.json'));
    assert(keys.includes(`releases/${catalog.revision}/manifest.json`));
    assert(keys.some(key=>/^months\/2026-05\/[a-f0-9]{64}\.json$/.test(key)));
    assert(keys.some(key=>/^audio\/[a-f0-9]{64}\.opus$/.test(key)));
    assert.equal(blob.puts.at(-1),'current.json');
    const pointer=JSON.parse(blob.objects.get('current.json'));
    assert.equal(pointer.releaseId,catalog.revision);
    // Second run: existing objects skip, pointer compares equal, no writes.
    blob.puts.length=0;
    const again=await run(['--window-days','0','--months','0'],{
      SOURCE_AUDIO_BASE:base,
      TARGET_STORAGE:'blob',
      BLOB_BASE_URL:'https://blob.fixture.invalid',
      BLOB_READ_WRITE_TOKEN:'fixture-token',
      MIGRATE_CACHE_DIR:cacheDir
    },{blobFetcher:blob.fetcher,blobSdk:blob.sdk,retries:2,sleep:async()=>{},now:NOW,log:()=>{},warn:()=>{}});
    assert.equal(again.uploaded,0);
    assert.equal(again.skipped,again.objects);
    assert.equal(blob.puts.length,0);
  }finally{
    await mock.stop();
    await rm(cacheDir,{recursive:true,force:true});
  }
});

test('blob target rejects --prune and same-base source/target is rejected',async()=>{
  const catalog=makeCatalog({monthsSpec:[{id:'2026-11',rows:[{title:'New'}]}]});
  const mock=startMockApi(catalog);
  const base=await mock.start();
  const blob=fakeBlobBackend(new Map());
  const cacheDir=await mkdtemp(join(tmpdir(),'b2-migrate-cache-'));
  try{
    await assert.rejects(run(['--window-days','0','--months','0','--prune'],{
      SOURCE_AUDIO_BASE:base,
      TARGET_STORAGE:'blob',
      BLOB_BASE_URL:'https://blob.fixture.invalid',
      BLOB_READ_WRITE_TOKEN:'fixture-token',
      MIGRATE_CACHE_DIR:cacheDir
    },{blobFetcher:blob.fetcher,blobSdk:blob.sdk,retries:1,sleep:async()=>{},now:NOW,log:()=>{},warn:()=>{}}),/unsupported for Blob targets/);
    await assert.rejects(run(['--window-days','0','--months','0'],{
      SOURCE_AUDIO_BASE:base,
      TARGET_STORAGE:'blob',
      BLOB_BASE_URL:base+'',
      BLOB_READ_WRITE_TOKEN:'fixture-token',
      MIGRATE_CACHE_DIR:cacheDir
    },{blobFetcher:blob.fetcher,blobSdk:blob.sdk,retries:1,sleep:async()=>{},now:NOW,log:()=>{},warn:()=>{}}),/same location/);
    assert.equal(blob.puts.length,0);
  }finally{
    await mock.stop();
    await rm(cacheDir,{recursive:true,force:true});
  }
});

let failed=0;
for(const entry of tests){
  try{await entry.fn();console.log('ok - '+entry.name);}
  catch(error){failed++;console.error('not ok - '+entry.name+'\n'+(error?.stack??error));}
}
if(failed)process.exitCode=1;
else console.log(`migrate-s3: ${tests.length} tests passed`);