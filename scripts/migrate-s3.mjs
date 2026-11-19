#!/usr/bin/env node
// Copy the immutable diary catalog from a configured source (local or S3) to any
// S3-compatible target (for example Backblaze B2). Source objects are never
// written, renamed, or deleted. Output never includes credentials or URLs.
import {createHash} from 'node:crypto';
import {readdir,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {S3Client,ListObjectsV2Command,GetObjectCommand,HeadObjectCommand,PutObjectCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {s3Options,s3ObjectKey,objectCacheControl} from '../src/lib/server/s3-store.mjs';
import {configuredStore,s3Store,localStore,validKey} from '../src/lib/server/storage.mjs';
import {digest} from '../src/lib/server/publisher.mjs';
import {monthBounds} from '../src/lib/server/months.mjs';
import {validateManifest,validateMonth,validatePointer} from '../src/lib/catalog-schema.js';

const SHA256=/^[a-f0-9]{64}$/;
const MONTH_KEY=/^months\/\d{4}-(?:0[1-9]|1[0-2])\/[a-f0-9]{64}\.json$/;
const RELEASE_KEY=/^releases\/[a-f0-9]{64}\/manifest\.json$/;
const AUDIO_NAME=/^[a-f0-9]{64}\.opus$/;
const DEFAULT_BUDGET_MB=1024;
const DEFAULT_CONCURRENCY=5;
const DEFAULT_WINDOW_DAYS=30;
const DEFAULT_RETRIES=4;

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

export function parseArgs(argv=process.argv.slice(2)){
  const options={dryRun:false,prune:false,windowDays:undefined,months:undefined,concurrency:DEFAULT_CONCURRENCY,budgetMb:DEFAULT_BUDGET_MB,now:undefined,help:false};
  const numeric=(flag,value,min,max)=>{
    if(!/^\d+$/.test(value??''))throw Error(`${flag} requires an integer`);
    const n=Number(value);
    if(n<min||n>max)throw Error(`${flag} must be between ${min} and ${max}`);
    return n;
  };
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(arg==='--dry-run')options.dryRun=true;
    else if(arg==='--prune')options.prune=true;
    else if(arg==='--help'||arg==='-h')options.help=true;
    else if(arg==='--window-days')options.windowDays=numeric(arg,argv[++i],0,36500);
    else if(arg==='--months')options.months=numeric(arg,argv[++i],0,1200);
    else if(arg==='--concurrency')options.concurrency=numeric(arg,argv[++i],1,16);
    else if(arg==='--budget-mb')options.budgetMb=numeric(arg,argv[++i],1,1048576);
    else if(arg==='--now')options.now=numeric(arg,argv[++i],0,Number.MAX_SAFE_INTEGER);
    else throw Error('Unknown argument. Use --help.');
  }
  if(options.windowDays===undefined)options.windowDays=options.months!==undefined?0:DEFAULT_WINDOW_DAYS;
  if(options.months===undefined)options.months=0;
  return options;
}

// Map TARGET_S3_* to the existing validated S3 option parser without touching S3_*.
export function targetOptions(env){
  const mapped={};
  for(const field of ['ENDPOINT','REGION','BUCKET','ACCESS_KEY_ID','SECRET_ACCESS_KEY','SESSION_TOKEN','PREFIX','FORCE_PATH_STYLE']){
    const value=env['TARGET_S3_'+field];
    if(value!==undefined)mapped['S3_'+field]=value;
  }
  if(env.TARGET_S3_AUDIO_KEY_PREFIX!==undefined)mapped.S3_AUDIO_KEY_PREFIX=env.TARGET_S3_AUDIO_KEY_PREFIX;
  return s3Options(mapped);
}

function notFound(error){
  const status=Number(error?.$metadata?.httpStatusCode??error?.statusCode);
  return status===404||['NoSuchKey','NotFound'].includes(error?.name);
}

function sdkError(operation,error){
  const status=Number(error?.$metadata?.httpStatusCode??error?.statusCode??error?.status);
  const label=Number.isFinite(status)?` (HTTP ${status})`:(error?.code?` (${error.code})`:'');
  const wrapped=new Error(`${operation} failed${label}`);
  wrapped.status=Number.isFinite(status)?status:undefined;
  wrapped.code=error?.code;
  return wrapped;
}

function retryable(error){
  const status=error?.status;
  if(status===429||(status>=500&&status<=599))return true;
  return ['ECONNRESET','ETIMEDOUT','EAI_AGAIN','ENOTFOUND','EPIPE','ECONNREFUSED','EHOSTUNREACH','ENETUNREACH','UND_ERR_CONNECT_TIMEOUT'].includes(error?.code)||error?.name==='TimeoutError';
}

const defaultSleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function withRetry(operation,{retries=DEFAULT_RETRIES,baseDelayMs=250,maxDelayMs=8000,sleep=defaultSleep,stats}={}){
  for(let attempt=0;;attempt++){
    try{return await operation();}
    catch(error){
      if(!retryable(error)||attempt>=retries)throw error;
      if(stats)stats.retries=(stats.retries??0)+1;
      const delay=Math.min(maxDelayMs,baseDelayMs*2**attempt);
      await sleep(delay);
    }
  }
}

async function bodyBytes(body){
  if(!body)return Buffer.alloc(0);
  if(typeof body.transformToByteArray==='function')return Buffer.from(await body.transformToByteArray());
  return Buffer.from(body);
}

// Target/backend over physical keys. The label only affects sanitized errors.
export function createS3Backend(options,client=new S3Client(options.clientOptions),label='target'){
  const base={Bucket:options.bucket};
  return {
    options,
    async list(prefix=''){
      const keys=[];
      let token;
      do{
        let response;
        try{response=await client.send(new ListObjectsV2Command({...base,Prefix:prefix||undefined,ContinuationToken:token}));}
        catch(error){throw sdkError(`${label} list`,error);}
        for(const item of response.Contents??[])if(item.Key)keys.push({key:item.Key,size:Number(item.Size)||0});
        token=response.IsTruncated?response.NextContinuationToken:undefined;
      }while(token);
      return keys;
    },
    async get(key){
      try{return await bodyBytes((await client.send(new GetObjectCommand({...base,Key:key}))).Body);}
      catch(error){throw sdkError(`${label} read`,error);}
    },
    async head(key){
      try{return {size:Number((await client.send(new HeadObjectCommand({...base,Key:key}))).ContentLength)||0};}
      catch(error){if(notFound(error))return null;throw sdkError(`${label} head`,error);}
    },
    async put(key,bytes,contentType,cacheControl){
      try{await client.send(new PutObjectCommand({...base,Key:key,Body:bytes,ContentType:contentType,CacheControl:cacheControl}));}
      catch(error){throw sdkError(`${label} write`,error);}
    },
    async delete(key){
      try{await client.send(new DeleteObjectCommand({...base,Key:key}));}
      catch(error){if(notFound(error))return;throw sdkError(`${label} delete`,error);}
    }
  };
}

async function readStore(store,key){
  const response=await store.read(key);
  if(response.ok)return Buffer.from(await response.arrayBuffer());
  if(response.status===404){const error=new Error('source object missing');error.code='ENOENT';throw error;}
  throw Error(`source read failed (HTTP ${response.status})`);
}

async function walk(root,prefix){
  const entries=[];
  const base=resolve(root,prefix);
  const visit=async(directory,relative)=>{
    let children;
    try{children=await readdir(directory,{withFileTypes:true});}
    catch(error){if(error.code==='ENOENT')return;throw error;}
    for(const child of children){
      const rel=relative?`${relative}/${child.name}`:child.name;
      if(child.isDirectory())await visit(join(directory,child.name),rel);
      else if(child.isFile())entries.push({key:prefix+rel,size:(await stat(join(directory,child.name))).size});
    }
  };
  await visit(base,'');
  return entries;
}

// Local source uses the same configuredStore reader as the application.
export function createLocalSource({root,store=localStore(root)}={}){
  if(!root)throw Error('Missing local source directory');
  return {
    storage:'local',
    layout:{dataPrefix:'',audioPrefix:'audio/'},
    list:prefix=>walk(root,prefix),
    read:key=>readStore(store,validKey(key))
  };
}

export function sourceFromEnv(env,{client}={}){
  const storage=env.CATALOG_STORAGE??'local';
  if(storage==='local'){
    const root=env.CATALOG_LOCAL_DIR||'.diary-data';
    return createLocalSource({root,store:configuredStore(env)});
  }
  if(storage!=='s3')throw Error('Source storage must be local or s3');
  const options=s3Options(env);
  const s3client=client??new S3Client(options.clientOptions);
  const store=s3Store(env,s3client);
  const backend=createS3Backend(options,s3client,'source');
  return {
    storage:'s3',
    options,
    layout:{dataPrefix:options.prefix,audioPrefix:options.audioPrefix},
    list:backend.list,
    read:key=>readStore(store,key)
  };
}

function classify(entries,layout){
  const index={pointer:null,legacy:null,releases:[],months:[],audio:[]};
  const seen=new Set();
  for(const entry of entries){
    if(seen.has(entry.key))continue;
    seen.add(entry.key);
    if(entry.key.startsWith(layout.audioPrefix)){
      const name=entry.key.slice(layout.audioPrefix.length);
      if(AUDIO_NAME.test(name)){
        index.audio.push({...entry,logicalKey:`audio/${name}`,hash:name.slice(0,-5)});
        continue;
      }
    }
    if(!entry.key.startsWith(layout.dataPrefix))continue;
    const relative=entry.key.slice(layout.dataPrefix.length);
    if(relative==='current.json')index.pointer={...entry,logicalKey:relative};
    else if(relative==='manifest.json')index.legacy={...entry,logicalKey:relative};
    else if(RELEASE_KEY.test(relative))index.releases.push({...entry,logicalKey:relative});
    else if(MONTH_KEY.test(relative))index.months.push({...entry,logicalKey:relative});
  }
  return index;
}

function parseJSON(bytes,label){
  try{return JSON.parse(bytes.toString('utf8'));}
  catch{throw Error(`Invalid source ${label} JSON`);}
}

function audioLogical(opus){
  if(typeof opus==='string'&&/^audio\/[a-f0-9]{64}\.opus$/.test(opus))return opus;
  if(typeof opus==='string'&&/^https?:/.test(opus)){
    try{
      const match=new URL(opus).pathname.match(/audio\/[a-f0-9]{64}\.opus$/);
      if(match)return match[0];
    }catch{/* fall through to the explicit error */ }
  }
  throw Error('Unsupported audio reference in source');
}

function uniqueByKey(entries){return [...new Map(entries.map(entry=>[entry.key,entry])).values()];}

export async function buildPlan({source,target,now=Date.now()/1000,windowDays=DEFAULT_WINDOW_DAYS,months=0,budgetBytes=DEFAULT_BUDGET_MB*1024*1024,retries=DEFAULT_RETRIES,sleep=defaultSleep,stats}){
  if(!source||!target)throw Error('Both source and target are required');
  const list=prefix=>withRetry(()=>source.list(prefix),{retries,sleep,stats});
  const read=key=>withRetry(()=>source.read(key),{retries,sleep,stats});
  const layout=source.layout;
  const listing=await list(layout.dataPrefix);
  // When the audio namespace sits below the data prefix (or the data prefix is
  // empty), one listing already covers both; legacy objects/ needs its own pass.
  const extra=layout.audioPrefix.startsWith(layout.dataPrefix)?[]:await list(layout.audioPrefix);
  const index=classify(uniqueByKey([...listing,...extra]),layout);

  let pointer=null;
  let pointerBytes=null;
  let manifest;
  let manifestBytes;
  let manifestKey;

  if(index.pointer){
    pointerBytes=await read('current.json');
    pointer=validatePointer(parseJSON(pointerBytes,'current'));
    manifestBytes=await read(pointer.key);
    manifest=validateManifest(parseJSON(manifestBytes,'manifest'));
    manifestKey=pointer.key;
  }else if(index.legacy){
    manifestBytes=await read('manifest.json');
    manifest=validateManifest(parseJSON(manifestBytes,'manifest'));
    const revision=digest(JSON.stringify(manifest.months));
    if(manifest.revision!==revision)throw Error('Source legacy manifest revision mismatch');
    manifestKey=`releases/${revision}/manifest.json`;
    pointer={schemaVersion:2,releaseId:revision,key:manifestKey};
    pointerBytes=Buffer.from(JSON.stringify(pointer));
  }else{
    throw Error('Source has neither current.json nor manifest.json');
  }
  if(digest(JSON.stringify(manifest.months))!==manifest.revision)throw Error('Source manifest revision mismatch');

  const pruned=windowDays>0||months>0;
  const cutoff=windowDays>0?now-windowDays*86400:-Infinity;
  let selected=manifest.months.slice();
  if(months>0)selected=[...selected].sort((a,b)=>b.startAt-a.startAt).slice(0,months);
  selected.sort((a,b)=>a.startAt-b.startAt);

  // A pruned run only reads the blocks it might keep.
  const blocks=new Map();
  for(const entry of (pruned?selected:manifest.months)){
    if(!entry.available)continue;
    const bytes=await read(entry.key);
    const block=validateMonth(parseJSON(bytes,'month'),entry);
    if(digest(JSON.stringify(block.audios))!==entry.revision)throw Error('Source month revision mismatch');
    blocks.set(entry.id,{bytes,block});
  }

  const monthObjects=[];
  const rowsById=new Map();
  if(pruned){
    const entries=[];
    for(const entry of selected){
      const sourceBlock=blocks.get(entry.id);
      if(!sourceBlock)continue;
      const rows=windowDays>0?sourceBlock.block.audios.filter(audio=>audio.startAt>=cutoff):sourceBlock.block.audios;
      if(windowDays>0&&rows.length===0)continue;
      const revision=digest(JSON.stringify(rows));
      const payload=JSON.stringify({schemaVersion:2,id:entry.id,revision,audios:rows});
      entries.push({...monthBounds(entry.id),count:rows.length,revision,key:`months/${entry.id}/${revision}.json`,available:true});
      monthObjects.push({logicalKey:`months/${entry.id}/${revision}.json`,body:Buffer.from(payload),kind:'month'});
      rowsById.set(entry.id,rows);
    }
    if(entries.length===0)throw Error('No months retained by migration window');
    entries.sort((a,b)=>a.startAt-b.startAt);
    const revision=digest(JSON.stringify(entries));
    manifest={schemaVersion:2,timezone:'Asia/Shanghai',generatedAt:Math.floor(now),revision,months:entries};
    manifestBytes=Buffer.from(JSON.stringify(manifest));
    manifestKey=`releases/${revision}/manifest.json`;
    pointer={schemaVersion:2,releaseId:revision,key:manifestKey};
    pointerBytes=Buffer.from(JSON.stringify(pointer));
  }else{
    for(const entry of manifest.months){
      const sourceBlock=blocks.get(entry.id);
      if(!sourceBlock)continue;
      monthObjects.push({logicalKey:entry.key,body:null,kind:'month',size:sourceBlock.bytes.length});
      rowsById.set(entry.id,sourceBlock.block.audios);
    }
  }

  const audioIndex=new Map(index.audio.map(entry=>[entry.logicalKey,entry]));
  const audioKeys=new Set();
  for(const rows of rowsById.values())for(const audio of rows)audioKeys.add(audioLogical(audio.opus));

  const objects=[];
  const options=target.options;
  for(const entry of monthObjects){
    const bytes=entry.body?entry.body.length:entry.size;
    objects.push({...entry,targetKey:s3ObjectKey(options,entry.logicalKey),contentType:'application/json',cacheControl:objectCacheControl(entry.logicalKey),size:bytes});
  }

  const releaseKeys=new Set([manifestKey]);
  if(!pruned)for(const release of index.releases)releaseKeys.add(release.logicalKey);
  for(const key of releaseKeys){
    const body=key===manifestKey?manifestBytes:null;
    objects.push({
      logicalKey:key,
      targetKey:s3ObjectKey(options,key),
      kind:'manifest',
      body,
      size:body?body.length:index.releases.find(release=>release.logicalKey===key)?.size??0,
      contentType:'application/json',
      cacheControl:objectCacheControl(key)
    });
  }

  for(const key of [...audioKeys].sort()){
    if(!SHA256.test(key.slice(6,-5)))throw Error('Unsupported audio key');
    const sourceEntry=audioIndex.get(key);
    if(!sourceEntry)throw Error('Source audio object missing');
    objects.push({
      logicalKey:key,
      targetKey:s3ObjectKey(options,key),
      kind:'audio',
      body:null,
      size:sourceEntry.size,
      contentType:'audio/ogg',
      cacheControl:objectCacheControl(key)
    });
  }

  objects.push({
    logicalKey:'current.json',
    targetKey:s3ObjectKey(options,'current.json'),
    kind:'pointer',
    body:pointerBytes,
    size:pointerBytes.length,
    contentType:'application/json',
    cacheControl:objectCacheControl('current.json')
  });

  const bytes=objects.reduce((total,object)=>total+object.size,0);
  const counts={pointer:0,manifest:0,month:0,audio:0};
  for(const object of objects)counts[object.kind]++;
  return {
    objects,
    targetOptions:options,
    release:pointer.releaseId,
    months:manifest.months.length,
    counts,
    bytes,
    budgetBytes,
    budgetExceeded:bytes>budgetBytes,
    pruned
  };
}

async function pool(items,limit,worker){
  let next=0;
  const errors=[];
  const run=async()=>{
    for(;;){
      const index=next++;
      if(index>=items.length||errors.length)return;
      try{await worker(items[index],index);}
      catch(error){errors.push(error);return;}
    }
  };
  await Promise.all(Array.from({length:Math.min(limit,items.length)},run));
  if(errors.length)throw errors[0];
}

async function syncObject(object,{source,target,retries,sleep,stats}){
  let bytes=null;
  const load=async()=>{
    if(bytes)return bytes;
    if(object.body)bytes=object.body;
    else bytes=await withRetry(()=>source.read(object.logicalKey),{retries,sleep,stats});
    return bytes;
  };
  const expectedHash=object.kind==='audio'?object.logicalKey.slice(6,-5):null;

  const existing=await withRetry(()=>target.head(object.targetKey),{retries,sleep,stats});
  if(existing&&existing.size===object.size){
    const current=await withRetry(()=>target.get(object.targetKey),{retries,sleep,stats});
    if(expectedHash){
      if(sha256(current)===expectedHash)return 'skipped';
    }else if(sha256(current)===sha256(await load())){
      return 'skipped';
    }
  }

  const payload=await load();
  if(expectedHash&&sha256(payload)!==expectedHash)throw Error('Source audio integrity mismatch');
  await withRetry(()=>target.put(object.targetKey,payload,object.contentType,object.cacheControl),{retries,sleep,stats});
  const check=await withRetry(()=>target.get(object.targetKey),{retries,sleep,stats});
  if(sha256(check)!==sha256(payload))throw Error('Target verification failed');
  return 'uploaded';
}

async function pruneTarget(plan,target,{retries,sleep,stats}){
  const keep=new Set(plan.objects.map(object=>object.targetKey));
  const options=plan.targetOptions;
  const listed=await withRetry(()=>target.list(options.prefix),{retries,sleep,stats});
  const extra=options.audioPrefix.startsWith(options.prefix)?[]:await withRetry(()=>target.list(options.audioPrefix),{retries,sleep,stats});
  const extraKeys=new Set();
  for(const entry of [...listed,...extra]){
    if(keep.has(entry.key)||extraKeys.has(entry.key))continue;
    let managed=false;
    if(entry.key.startsWith(options.prefix)){
      const relative=entry.key.slice(options.prefix.length);
      managed=relative==='current.json'||RELEASE_KEY.test(relative)||MONTH_KEY.test(relative);
    }
    if(!managed&&entry.key.startsWith(options.audioPrefix))managed=AUDIO_NAME.test(entry.key.slice(options.audioPrefix.length));
    if(managed)extraKeys.add(entry.key);
  }
  for(const key of extraKeys)await withRetry(()=>target.delete(key),{retries,sleep,stats});
  return extraKeys.size;
}

export async function migrate(plan,{source,target,concurrency=DEFAULT_CONCURRENCY,dryRun=false,prune=false,retries=DEFAULT_RETRIES,sleep=defaultSleep,stats={retries:0}}={}){
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>16)throw Error('Invalid concurrency');
  const summary={
    ok:true,
    dryRun,
    objects:plan.objects.length,
    counts:plan.counts,
    bytes:plan.bytes,
    budgetBytes:plan.budgetBytes,
    budgetExceeded:plan.budgetExceeded,
    release:plan.release,
    months:plan.months,
    pruned:plan.pruned,
    uploaded:0,
    skipped:0,
    deleted:0,
    retries:stats.retries??0
  };
  if(dryRun)return summary;

  const objects=plan.objects.filter(object=>object.kind!=='pointer');
  await pool(objects,concurrency,async object=>{
    const result=await syncObject(object,{source,target,retries,sleep,stats});
    if(result==='uploaded')summary.uploaded++;else summary.skipped++;
  });

  const pointer=plan.objects.find(object=>object.kind==='pointer');
  if(!pointer)throw Error('Migration plan has no pointer');
  const pointerResult=await syncObject(pointer,{source,target,retries,sleep,stats});
  if(pointerResult==='uploaded')summary.uploaded++;else summary.skipped++;

  if(prune)summary.deleted=await pruneTarget(plan,target,{retries,sleep,stats});
  summary.retries=stats.retries??0;
  return summary;
}

function sameLocation(source,target){
  if(!source?.options||!target?.options)return false;
  const a=source.options;
  const b=target.options;
  return a.bucket===b.bucket&&a.prefix===b.prefix&&a.audioPrefix===b.audioPrefix&&(a.clientOptions?.endpoint??'')===(b.clientOptions?.endpoint??'');
}

const USAGE=`Usage: node scripts/migrate-s3.mjs [options]

Copies current.json, release manifests, month blocks, and referenced audio from
the configured source (CATALOG_STORAGE=s3|local) to TARGET_S3_*.

  --dry-run              report object count/bytes only; no target writes
  --window-days N        keep audio from the last N days (default 30; 0 disables)
  --months N             keep the last N business months (0 disables)
  --concurrency N        parallel transfer slots (default 5, max 16)
  --budget-mb N          warn when the planned transfer exceeds N MB
  --prune                after a successful pointer switch, delete managed
                         target objects that are not in this plan
  --now EPOCH            evaluation time in unix seconds (testing)
  --help`;

export async function run(argv=process.argv.slice(2),env=process.env,deps={}){
  const options=parseArgs(argv);
  if(options.help){console.log(USAGE);return null;}
  const source=deps.source??sourceFromEnv(env);
  const target=deps.target??createS3Backend(targetOptions(env));
  if(sameLocation(source,target))throw Error('Source and target resolve to the same location');
  const now=options.now??deps.now??Date.now()/1000;
  const plan=await buildPlan({source,target,now,windowDays:options.windowDays,months:options.months,budgetBytes:options.budgetMb*1024*1024,retries:deps.retries??DEFAULT_RETRIES,sleep:deps.sleep});
  const summary=await migrate(plan,{source,target,concurrency:options.concurrency,dryRun:options.dryRun,prune:options.prune,retries:deps.retries??DEFAULT_RETRIES,sleep:deps.sleep});
  (deps.log??console.log)(JSON.stringify(summary));
  if(summary.budgetExceeded)(deps.warn??console.error)(`Warning: planned transfer (${summary.bytes} bytes) exceeds --budget-mb ${options.budgetMb}`);
  return summary;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  run().catch(error=>{
    console.error(`S3 migration failed: ${error?.message??'unknown error'}`);
    process.exitCode=1;
  });
}