#!/usr/bin/env node
// Copy the immutable diary catalog from a configured source to an S3-compatible
// target (for example Backblaze B2) or a Vercel Blob store. Sources: the
// production HTTP API (SOURCE_AUDIO_BASE; inherits the retired migrate-audio
// chain), an S3 store (CATALOG_STORAGE=s3), or a local directory. Source
// objects are never written, renamed, or deleted. Output never includes
// credentials or URLs.
//
// Pruning is part of the publish pipeline, not an optional extra: once the
// pointer switch succeeded, target objects that this run's manifest no longer
// references are deleted (managed key shapes only, target prefix only), so a
// rolling-window publish reclaims out-of-window data on every run. --no-prune
// is the explicit opt-out.
import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,readdir,rmdir,stat,statfs,unlink,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {S3Client,ListObjectsV2Command,GetObjectCommand,HeadObjectCommand,PutObjectCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {s3Options,s3ObjectKey,objectCacheControl} from '../src/lib/server/s3-store.mjs';
import {configuredStore,s3Store,localStore,blobStore,validKey} from '../src/lib/server/storage.mjs';
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
const DEFAULT_PRUNE=true;
const DEFAULT_RETRIES=4;
const DEFAULT_TIMEOUT_MS=120000;
const DEFAULT_CACHE_DIR_NAME='anyun-migrate-s3';
const DEFAULT_CACHE_RESERVE_BYTES=512*1024*1024;
const CACHE_FILE_NAME=/^[a-f0-9]{64}\.opus(\.part)?$/;

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

export function parseArgs(argv=process.argv.slice(2)){
  const options={dryRun:false,prune:DEFAULT_PRUNE,pruneExplicit:false,pruneDisabled:false,verifyFull:false,windowDays:undefined,months:undefined,concurrency:DEFAULT_CONCURRENCY,budgetMb:DEFAULT_BUDGET_MB,timeoutMs:DEFAULT_TIMEOUT_MS,cacheDir:undefined,now:undefined,help:false};
  const numeric=(flag,value,min,max)=>{
    if(!/^\d+$/.test(value??''))throw Error(`${flag} requires an integer`);
    const n=Number(value);
    if(n<min||n>max)throw Error(`${flag} must be between ${min} and ${max}`);
    return n;
  };
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(arg==='--dry-run')options.dryRun=true;
    // Pruning is part of every publish run by default; --prune stays accepted
    // as a legacy alias, --no-prune is the explicit opt-out.
    else if(arg==='--prune'){options.prune=true;options.pruneExplicit=true;}
    else if(arg==='--no-prune'){options.prune=false;options.pruneDisabled=true;}
    else if(arg==='--verify-full')options.verifyFull=true;
    else if(arg==='--help'||arg==='-h')options.help=true;
    else if(arg==='--window-days')options.windowDays=numeric(arg,argv[++i],0,36500);
    else if(arg==='--months')options.months=numeric(arg,argv[++i],0,1200);
    else if(arg==='--concurrency')options.concurrency=numeric(arg,argv[++i],1,16);
    else if(arg==='--budget-mb')options.budgetMb=numeric(arg,argv[++i],1,1048576);
    else if(arg==='--timeout-ms')options.timeoutMs=numeric(arg,argv[++i],1,3600000);
    else if(arg==='--cache-dir'){
      const value=argv[++i];
      if(typeof value!=='string'||!value.trim())throw Error(`${arg} requires a non-empty directory path`);
      options.cacheDir=value.trim();
    }
    else if(arg==='--now')options.now=numeric(arg,argv[++i],0,Number.MAX_SAFE_INTEGER);
    else throw Error('Unknown argument. Use --help.');
  }
  if(options.pruneExplicit&&options.pruneDisabled)throw Error('Use either --prune or --no-prune');
  if(options.windowDays===undefined)options.windowDays=options.months!==undefined?0:DEFAULT_WINDOW_DAYS;
  if(options.months===undefined)options.months=0;
  return options;
}

// Resolve the target S3 configuration with the legacy chain:
// TARGET_S3_* > AUDIO_S3_* > S3_* (path style also accepts AUDIO_S3_PATH_STYLE,
// the audio prefix also accepts AUDIO_S3_KEY_PREFIX). The mapping feeds
// s3Options pure S3_* names so legacy markers never flip the target layout.
export function targetOptions(env){
  const chains={
    ENDPOINT:['TARGET_S3_ENDPOINT','AUDIO_S3_ENDPOINT','S3_ENDPOINT'],
    REGION:['TARGET_S3_REGION','AUDIO_S3_REGION','S3_REGION'],
    BUCKET:['TARGET_S3_BUCKET','AUDIO_S3_BUCKET','S3_BUCKET'],
    ACCESS_KEY_ID:['TARGET_S3_ACCESS_KEY_ID','AUDIO_S3_ACCESS_KEY_ID','S3_ACCESS_KEY_ID'],
    SECRET_ACCESS_KEY:['TARGET_S3_SECRET_ACCESS_KEY','AUDIO_S3_SECRET_ACCESS_KEY','S3_SECRET_ACCESS_KEY'],
    SESSION_TOKEN:['TARGET_S3_SESSION_TOKEN','AUDIO_S3_SESSION_TOKEN','S3_SESSION_TOKEN'],
    PREFIX:['TARGET_S3_PREFIX','AUDIO_S3_PREFIX','S3_PREFIX'],
    FORCE_PATH_STYLE:['TARGET_S3_FORCE_PATH_STYLE','AUDIO_S3_PATH_STYLE','AUDIO_S3_FORCE_PATH_STYLE','S3_FORCE_PATH_STYLE'],
    AUDIO_KEY_PREFIX:['TARGET_S3_AUDIO_KEY_PREFIX','AUDIO_S3_KEY_PREFIX','S3_AUDIO_KEY_PREFIX']
  };
  const mapped={};
  for(const [field,chain] of Object.entries(chains)){
    for(const name of chain){
      const value=env[name];
      if(value!==undefined){mapped['S3_'+field]=value;break;}
    }
  }
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

// Streaming SHA-256 over any body shape (SDK Readable, web ReadableStream, or
// byte-array facade). Peak memory stays at chunk size, never file size.
export async function digestBody(body){
  const hash=createHash('sha256');
  if(!body)hash.update(Buffer.alloc(0));
  else if(typeof body[Symbol.asyncIterator]==='function')for await(const chunk of body)hash.update(chunk);
  else if(typeof body.transformToByteArray==='function')hash.update(Buffer.from(await body.transformToByteArray()));
  else if(typeof body.getReader==='function'){
    const reader=body.getReader();
    for(;;){const {done,value}=await reader.read();if(done)break;hash.update(Buffer.from(value));}
  }
  else hash.update(Buffer.from(body));
  return hash.digest('hex');
}

function hashFileStream(path){
  return new Promise((resolveDone,reject)=>{
    const hash=createHash('sha256');
    createReadStream(path)
      .on('data',chunk=>hash.update(chunk))
      .on('error',reject)
      .on('end',()=>resolveDone(hash.digest('hex')));
  });
}

// Dedicated temp-directory cache for HTTP-source audio. Files land as
// <hash>.opus.part, are renamed after the streamed download, and are named by
// content hash so an interrupted run can reuse complete files (size+digest
// verified) instead of re-downloading. The whole directory is cleared when the
// run exits (run()'s finally), including failure paths.
export function resolveCacheDir(env,cliValue){
  const raw=cliValue??env?.MIGRATE_CACHE_DIR;
  if(raw===undefined||raw===null)return join(tmpdir(),DEFAULT_CACHE_DIR_NAME);
  if(typeof raw!=='string'||!raw.trim())throw Error('Invalid cache directory');
  return resolve(raw.trim());
}

export function createAudioCache({dir,statfsFn=statfs,reserveBytes=DEFAULT_CACHE_RESERVE_BYTES}={}){
  if(!dir||typeof dir!=='string')throw Error('Invalid cache directory');
  const root=resolve(dir);
  if(!Number.isFinite(reserveBytes)||reserveBytes<0)throw Error('Invalid cache reserve');
  let ensured=null;
  let liveBytes=0;
  let peakBytes=0;
  let downloads=0;
  let reused=0;
  const live=new Map();
  const ensure=async()=>{
    if(!ensured)ensured=mkdir(root,{recursive:true}).then(()=>{}).catch(error=>{ensured=null;throw error;});
    return ensured;
  };
  const pathFor=hash=>join(root,`${hash}.opus`);
  const freeBytes=async()=>{
    let info;
    try{info=await statfsFn(root);}
    catch(error){throw Error(`Cache disk space check failed (${error?.code??error?.message??'unknown'})`);}
    const free=Number(info?.bavail)*Number(info?.bsize);
    if(!Number.isFinite(free)||free<0)throw Error('Cache disk space check failed (unavailable)');
    return free;
  };
  return {
    dir:root,
    pathFor,
    digestFile:hash=>hashFileStream(pathFor(hash)),
    async acquire(hash,{size,download}={}){
      if(!SHA256.test(hash))throw Error('Invalid cache key');
      await ensure();
      // Reuse only a complete file whose size and digest both match the audio
      // identity; anything else is treated as corrupt and re-downloaded.
      try{
        const info=await stat(pathFor(hash));
        if(info.isFile()&&(size===undefined||size===null||info.size===size)&&await hashFileStream(pathFor(hash))===hash){
          reused++;
          liveBytes+=info.size;
          peakBytes=Math.max(peakBytes,liveBytes);
          live.set(hash,info.size);
          return {path:pathFor(hash),size:info.size,digest:hash,reused:true};
        }
      }catch(error){if(error.code!=='ENOENT')throw error;}
      const expected=Number.isInteger(size)&&size>=0?size:0;
      const free=await freeBytes();
      if(free-reserveBytes-liveBytes<expected)throw Error(`Insufficient cache disk space: need ${expected} bytes plus ${reserveBytes} reserve, ${free-liveBytes} free; use --cache-dir on a larger volume or reduce --concurrency`);
      const part=join(root,`${hash}.opus.part`);
      const hasher=createHash('sha256');
      let written=0;
      const stream=await download();
      try{
        await pipeline(stream,new Transform({transform(chunk,_enc,callback){hasher.update(chunk);written+=chunk.length;callback(null,chunk);}}),createWriteStream(part));
        await rename(part,pathFor(hash));
      }catch(error){
        await unlink(part).catch(()=>{});
        const reason=error?.name==='TimeoutError'||error?.name==='AbortError'?'timeout':(error?.code??error?.name??'network');
        throw Error(`Source audio download failed (${reason})`);
      }
      downloads++;
      liveBytes+=written;
      peakBytes=Math.max(peakBytes,liveBytes);
      live.set(hash,written);
      return {path:pathFor(hash),size:written,digest:hasher.digest('hex'),reused:false};
    },
    async release(hash){
      const counted=live.get(hash)??0;
      live.delete(hash);
      liveBytes-=counted;
      try{await unlink(pathFor(hash));}
      catch(error){if(error.code!=='ENOENT')throw error;}
    },
    async clear(){
      let entries;
      try{entries=await readdir(root);}
      catch(error){if(error.code==='ENOENT')return;throw error;}
      await Promise.all(entries.filter(name=>CACHE_FILE_NAME.test(name)).map(name=>unlink(join(root,name)).catch(error=>{if(error.code!=='ENOENT')throw error;})));
      await rmdir(root).catch(error=>{if(error.code!=='ENOENT'&&error.code!=='ENOTEMPTY')throw error;});
    },
    stats(){return {downloads,reused,peakBytes};}
  };
}

// Target/backend over physical keys. The label only affects sanitized errors.
// The default client disables SDK-internal retries; explicit retries (when
// enabled) are reported through the summary instead of happening silently.
export function createS3Backend(options,client=new S3Client({...options.clientOptions,maxAttempts:1}),label='target'){
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
    async getStream(key){
      try{return (await client.send(new GetObjectCommand({...base,Key:key}))).Body;}
      catch(error){throw sdkError(`${label} read`,error);}
    },
    async head(key){
      try{return {size:Number((await client.send(new HeadObjectCommand({...base,Key:key}))).ContentLength)||0};}
      catch(error){if(notFound(error))return null;throw sdkError(`${label} head`,error);}
    },
    async put(key,body,contentType,cacheControl){
      try{await client.send(new PutObjectCommand({...base,Key:key,Body:body,ContentType:contentType,CacheControl:cacheControl}));}
      catch(error){throw sdkError(`${label} write`,error);}
    },
    async delete(key){
      try{await client.send(new DeleteObjectCommand({...base,Key:key}));}
      catch(error){if(notFound(error))return;throw sdkError(`${label} delete`,error);}
    }
  };
}

// Blob target reusing the application blobStore (no separate Blob protocol).
// Logical keys map 1:1 (prefix is identity); listing/head go through the SDK
// so target-side reclamation works here as well.
export function createBlobBackend({baseUrl,token,access='public',fetcher=fetch,sdk}={}){
  let store;
  try{store=blobStore({baseUrl,token,access,fetcher,sdk});}
  catch(error){throw Error(error?.message?.includes('Blob base')?'Invalid BLOB_BASE_URL':'Invalid Blob target configuration');}
  let base;
  try{base=new URL(baseUrl);}catch{throw Error('Invalid BLOB_BASE_URL');}
  const options={bucket:'blob',prefix:'',audioPrefix:'audio/',clientOptions:{endpoint:base.href}};
  const sanitize=(operation,error)=>{
    if(error&&typeof error.message==='string'&&error.message.startsWith(operation))return error;
    const wrapped=new Error(`${operation} failed`);
    wrapped.status=error?.status;
    return wrapped;
  };
  return {
    options,
    storage:'blob',
    async list(prefix=''){
      const api=sdk??await import('@vercel/blob');
      const entries=[];
      let cursor;
      try{
        do{
          const page=await api.list({token,prefix,cursor,limit:1000});
          for(const blob of page.blobs??[])entries.push({key:blob.pathname,size:blob.size});
          cursor=page.hasMore?page.cursor:undefined;
        }while(cursor);
      }
      catch(error){throw sanitize('target list',error);}
      return entries;
    },
    async head(key){
      const api=sdk??await import('@vercel/blob');
      const pathname=validKey(key);
      try{
        const result=await api.head(pathname,{token});
        return {size:typeof result?.size==='number'&&result.size>=0?result.size:null};
      }
      catch(error){
        if(error&&(error.name==='BlobNotFoundError'||error?.status===404))return null;
        throw sanitize('target head',error);
      }
    },
    async get(key){
      let response;
      try{response=await store.read(validKey(key));}
      catch(error){throw sanitize('target read',error);}
      if(response.status===404){const error=new Error('target read failed (HTTP 404)');error.status=404;throw error;}
      if(!response.ok)throw Error(`target read failed (HTTP ${response.status})`);
      return Buffer.from(await response.arrayBuffer());
    },
    async getStream(key){
      let response;
      try{response=await store.read(validKey(key));}
      catch(error){throw sanitize('target read',error);}
      if(response.status===404){const error=new Error('target read failed (HTTP 404)');error.status=404;throw error;}
      if(!response.ok){await response.body?.cancel().catch(()=>{});throw Error(`target read failed (HTTP ${response.status})`);}
      return response.body;
    },
    async put(key,body,contentType){
      try{await store.write(validKey(key),body,contentType);}
      catch(error){throw sanitize('target write',error);}
    },
    async delete(key){
      try{await store.remove(validKey(key));}
      catch(error){throw sanitize('target delete',error);}
    }
  };
}

export function targetFromEnv(env,deps={}){
  const storage=(env.TARGET_STORAGE??'').toLowerCase();
  const s3Configured=['ENDPOINT','REGION','BUCKET','ACCESS_KEY_ID','SECRET_ACCESS_KEY']
    .some(field=>env['TARGET_S3_'+field]!==undefined||env['AUDIO_S3_'+field]!==undefined||env['S3_'+field]!==undefined);
  if(storage==='blob'||(!storage&&!s3Configured&&env.BLOB_READ_WRITE_TOKEN!==undefined)){
    if(!env.BLOB_BASE_URL)throw Error('Blob target requires BLOB_BASE_URL');
    if(!env.BLOB_READ_WRITE_TOKEN)throw Error('Blob target requires BLOB_READ_WRITE_TOKEN');
    return createBlobBackend({baseUrl:env.BLOB_BASE_URL,token:env.BLOB_READ_WRITE_TOKEN,access:env.BLOB_ACCESS||'public',fetcher:deps.blobFetcher,sdk:deps.blobSdk});
  }
  if(storage&&storage!=='s3')throw Error('TARGET_STORAGE must be s3 or blob');
  return createS3Backend(targetOptions(env),deps.s3Client);
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

// Production HTTP API source: the pointer comes from /api/current, the release
// manifest from /api/catalog, month blocks from /api/month/<id>?release=<id>
// (pinned so a mid-run publish cannot mix releases), and audio streams from
// /api/audio/<hash>.opus following the 307 to storage. Requests carry no
// credentials and never retry automatically.
export function createHttpSource({base,fetcher=fetch,timeoutMs=DEFAULT_TIMEOUT_MS}={}){
  let parsed;
  try{parsed=base!==undefined?new URL(base):null;}catch{parsed=null;}
  if(!parsed||!['https:','http:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash)throw Error('Invalid SOURCE_AUDIO_BASE');
  const root=parsed.href.endsWith('/')?parsed.href:parsed.href+'/';
  const signal=()=>AbortSignal.timeout(timeoutMs);
  const request=async(path,extraHeaders)=>{
    let response;
    try{
      response=await fetcher(new URL(path,root).href,{headers:{'accept-encoding':'identity',...(extraHeaders??{})},redirect:'follow',cache:'no-store',signal:signal()});
    }catch(error){
      throw Error(`Source API request failed (${error?.name==='TimeoutError'?'timeout':'network'})`);
    }
    if(!response.ok){
      const status=response.status;
      await response.body?.cancel().catch(()=>{});
      throw Error(`Source API request failed (HTTP ${status})`);
    }
    if(response.headers.get('content-encoding')&&response.headers.get('content-encoding')!=='identity'){
      await response.body?.cancel().catch(()=>{});
      throw Error('Source API encoded response unsupported');
    }
    return response;
  };
  let releaseId=null;
  const currentRelease=async()=>{
    if(releaseId)return releaseId;
    const response=await request('api/current');
    const payload=await response.json().catch(()=>null);
    if(!payload||!SHA256.test(String(payload.releaseId??'')))throw Error('Source API returned an invalid pointer');
    releaseId=String(payload.releaseId);
    return releaseId;
  };
  return {
    storage:'http',
    base:root,
    options:{bucket:'http-source',prefix:'',audioPrefix:'audio/',clientOptions:{endpoint:root}},
    layout:{dataPrefix:'',audioPrefix:'audio/'},
    read:async key=>{
      validKey(key);
      if(key==='current.json'){
        const id=await currentRelease();
        return Buffer.from(JSON.stringify({schemaVersion:2,releaseId:id,key:`releases/${id}/manifest.json`}));
      }
      const release=key.match(/^releases\/([a-f0-9]{64})\/manifest\.json$/);
      if(release){
        const id=await currentRelease();
        if(release[1]!==id)throw Error('Source API manifest does not match the current pointer');
        const response=await request('api/catalog');
        const payload=await response.json().catch(()=>null);
        if(!payload||!Array.isArray(payload.months)||typeof payload.revision!=='string')throw Error('Source API returned an invalid manifest');
        // /api/catalog serves whatever release is current at fetch time; pin it
        // to the release captured from /api/current so a mid-run publish cannot
        // mix releases into one plan.
        if(payload.revision!==id)throw Error('Source release changed during migration');
        return Buffer.from(JSON.stringify({schemaVersion:payload.schemaVersion,timezone:payload.timezone,generatedAt:payload.generatedAt,revision:payload.revision,months:payload.months}));
      }
      const month=key.match(/^months\/(\d{4}-(?:0[1-9]|1[0-2]))\/[a-f0-9]{64}\.json$/);
      if(month){
        const id=await currentRelease();
        const response=await request(`api/month/${month[1]}?release=${id}`);
        return Buffer.from(await response.arrayBuffer());
      }
      const audio=key.match(/^audio\/([a-f0-9]{64})\.opus$/);
      if(audio){
        const response=await request(`api/audio/${audio[1]}.opus`);
        return Buffer.from(await response.arrayBuffer());
      }
      throw Error('Unsupported source key');
    },
    // Streaming variant for the audio path only: returns the undecoded web
    // stream so the temp-file cache can pipe it to disk without buffering.
    readStream:async key=>{
      validKey(key);
      const audio=key.match(/^audio\/([a-f0-9]{64})\.opus$/);
      if(!audio)throw Error('Unsupported source key');
      const response=await request(`api/audio/${audio[1]}.opus`);
      return response.body;
    },
    probeSize:async key=>{
      if(!/^audio\/[a-f0-9]{64}\.opus$/.test(key))throw Error('Unsupported source key');
      const name=key.slice(6);
      const fail=error=>{throw Error(`Source audio probe failed (${error?.name==='TimeoutError'?'timeout':'network'})`);};
      // Spec probe: HEAD follows the 307 to storage and reads Content-Length.
      let response;
      try{
        response=await fetcher(new URL(`api/audio/${name}`,root).href,{method:'HEAD',headers:{'accept-encoding':'identity'},redirect:'follow',cache:'no-store',signal:signal()});
      }catch(error){fail(error);}
      let size=null;
      try{
        // Signed-redirect sources may reject HEAD outright (e.g. 403 when the
        // 307 target only signs GET). A failed HEAD is a missing capability,
        // not a probe failure: fall through to the range probe, which stays
        // the place where hard failures are raised.
        if(response.ok){
          const length=response.headers.get('content-length');
          if(length!==null&&/^[0-9]+$/.test(length)&&Number.isSafeInteger(+length))size=+length;
        }
      }finally{await response.body?.cancel().catch(()=>{});}
      if(size!==null)return size;
      // Some deployments strip Content-Length on HEAD; one range request
      // recovers the total from Content-Range. This is a capability fallback,
      // not a retry: failures stay failures.
      try{
        response=await fetcher(new URL(`api/audio/${name}`,root).href,{headers:{'accept-encoding':'identity',range:'bytes=0-1'},redirect:'follow',cache:'no-store',signal:signal()});
      }catch(error){fail(error);}
      try{
        if(!response.ok)throw Error(`Source audio probe failed (HTTP ${response.status})`);
        const contentRange=response.headers.get('content-range');
        const total=contentRange?(/\/([0-9]+)$/.exec(contentRange)?.[1]??null):null;
        const length=response.headers.get('content-length');
        size=Number(total??length);
      }finally{await response.body?.cancel().catch(()=>{});}
      if(!Number.isSafeInteger(size)||size<0)throw Error('Source audio probe returned no length');
      return size;
    }
  };
}

export function sourceFromEnv(env,{client,httpFetcher,timeoutMs=DEFAULT_TIMEOUT_MS}={}){
  if(env.SOURCE_AUDIO_BASE)return createHttpSource({base:env.SOURCE_AUDIO_BASE,fetcher:httpFetcher??fetch,timeoutMs});
  const storage=env.CATALOG_STORAGE??'local';
  if(storage==='local'){
    const root=env.CATALOG_LOCAL_DIR||'.diary-data';
    return createLocalSource({root,store:configuredStore(env)});
  }
  if(storage!=='s3')throw Error('Source storage must be http (SOURCE_AUDIO_BASE), s3, or local');
  const options=s3Options(env);
  const s3client=client??new S3Client({...options.clientOptions,maxAttempts:1});
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
    }catch{/* fall through to the explicit error */}
  }
  throw Error('Unsupported audio reference in source');
}

function uniqueByKey(entries){return [...new Map(entries.map(entry=>[entry.key,entry])).values()];}

export async function buildPlan({source,target,now=Date.now()/1000,windowDays=DEFAULT_WINDOW_DAYS,months=0,budgetBytes=DEFAULT_BUDGET_MB*1024*1024,retries=DEFAULT_RETRIES,sleep=defaultSleep,stats}){
  if(!source||!target)throw Error('Both source and target are required');
  const listable=typeof source.list==='function';
  const v1Mode=source.storage==='http';
  const list=prefix=>listable?withRetry(()=>source.list(prefix),{retries,sleep,stats}):Promise.reject(Error('Source cannot list'));
  const read=key=>v1Mode?source.read(key):withRetry(()=>source.read(key),{retries,sleep,stats});
  const layout=source.layout;
  let index;
  if(listable){
    const listing=await list(layout.dataPrefix);
    // When the audio namespace sits below the data prefix (or the data prefix is
    // empty), one listing already covers both; legacy objects/ needs its own pass.
    const extra=layout.audioPrefix.startsWith(layout.dataPrefix)?[]:await list(layout.audioPrefix);
    index=classify(uniqueByKey([...listing,...extra]),layout);
  }else{
    // Reference-driven discovery (production HTTP API): current.json first, the
    // legacy fallback is not reachable because /api/current normalizes it.
    index={pointer:{logicalKey:'current.json'},legacy:null,releases:[],months:[],audio:[]};
  }

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

  // /api/catalog flips month availability to the API query window and the
  // stored manifest may itself carry unavailable months; the HTTP API cannot
  // read either kind back, so drop them and rebuild the manifest from the
  // entries actually read. Listable sources keep the strict digest check.
  let droppedMonths=0;
  let manifestMutated=false;
  if(digest(JSON.stringify(manifest.months))!==manifest.revision){
    if(listable)throw Error('Source manifest revision mismatch');
    manifestMutated=true;
  }
  if(v1Mode){
    const total=manifest.months.length;
    manifest={...manifest,months:manifest.months.filter(entry=>entry.available)};
    droppedMonths=total-manifest.months.length;
  }

  const pruned=windowDays>0||months>0;
  const cutoff=windowDays>0?now-windowDays*86400:-Infinity;
  let selected=manifest.months.slice();
  if(months>0)selected=[...selected].sort((a,b)=>b.startAt-a.startAt).slice(0,months);
  selected.sort((a,b)=>a.startAt-b.startAt);

  // A pruned run only reads the blocks it might keep.
  const blocks=new Map();
  let needsNormalization=false;
  for(const entry of (pruned?selected:manifest.months)){
    if(!entry.available)continue;
    const bytes=await read(entry.key);
    const block=validateMonth(parseJSON(bytes,'month'),entry);
    if(digest(JSON.stringify(block.audios))!==entry.revision)throw Error('Source month revision mismatch');
    if(block.audios.some(audio=>typeof audio.opus==='string'&&!audio.opus.startsWith('audio/')))needsNormalization=true;
    blocks.set(entry.id,{bytes,block});
  }

  const rebuild=pruned||needsNormalization||droppedMonths>0||manifestMutated;
  const monthObjects=[];
  const rowsById=new Map();
  if(rebuild){
    const entries=[];
    for(const entry of selected){
      const sourceBlock=blocks.get(entry.id);
      if(!sourceBlock)continue;
      let rows=windowDays>0?sourceBlock.block.audios.filter(audio=>audio.startAt>=cutoff):sourceBlock.block.audios;
      if(windowDays>0&&rows.length===0)continue;
      if(needsNormalization)rows=rows.map(audio=>({...audio,opus:audioLogical(audio.opus)}));
      const revision=digest(JSON.stringify(rows));
      const payload=JSON.stringify({schemaVersion:2,id:entry.id,revision,audios:rows});
      entries.push({...monthBounds(entry.id),count:rows.length,revision,key:`months/${entry.id}/${revision}.json`,available:true});
      monthObjects.push({logicalKey:`months/${entry.id}/${revision}.json`,body:Buffer.from(payload),kind:'month'});
      rowsById.set(entry.id,rows);
    }
    if(entries.length===0)throw Error(pruned?'No months retained by migration window':'Source catalog has no available months');
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
  if(!rebuild)for(const release of index.releases)releaseKeys.add(release.logicalKey);
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
    let size;
    if(sourceEntry)size=sourceEntry.size;
    else if(listable)throw Error('Source audio object missing');
    else size=await source.probeSize(key);
    objects.push({
      logicalKey:key,
      targetKey:s3ObjectKey(options,key),
      kind:'audio',
      body:null,
      size,
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
    droppedMonths,
    normalized:needsNormalization,
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

// v1Mode (SOURCE_AUDIO_BASE chain) inherits the retired migrate-audio
// semantics: existing destination keys are always skipped (content is only
// compared with --verify-full), uploads are unconditional PUTs, 429/5xx and
// network errors never retry automatically, and lengths are checked through
// HEAD. Other sources keep the hash-aware resume engine.
//
// HTTP-source audio never buffers whole files in memory: it downloads through
// the temp-dir cache (.part then rename), uploads by streaming the cached file
// into the target Body, and verifies by streaming digests. Objects already
// present at the target are skipped before any download starts.
async function syncCachedAudio(object,{source,target,cache,verifyFull,op}){
  const hash=object.logicalKey.slice(6,-5);
  const targetDigest=async()=>{
    const body=await op(()=>target.getStream(object.targetKey));
    try{return await digestBody(body);}
    finally{await body?.cancel?.().catch(()=>{});}
  };
  const existing=await op(()=>target.head(object.targetKey));
  if(existing){
    if(!verifyFull)return 'skipped';
    if(await targetDigest()===hash)return 'skipped';
    throw Error('Destination differs; existing object not uploaded');
  }
  const entry=await cache.acquire(hash,{
    size:object.size,
    download:async()=>{
      if(typeof source.readStream==='function')return Readable.fromWeb(await source.readStream(object.logicalKey));
      return Readable.from([await source.read(object.logicalKey)]);
    }
  });
  try{
    if(entry.digest!==hash)throw Error('Source audio integrity mismatch');
    if(entry.size!==object.size)throw Error('Source length mismatch');
    // Stream the cached file into the target; the S3 SDK Body accepts a Node
    // Readable and the Blob SDK accepts its web-stream form.
    const nodeStream=createReadStream(entry.path);
    nodeStream.on('error',()=>{}); // the target put surfaces failures; an orphaned stream must never crash the process
    const uploadBody=target.storage==='blob'?Readable.toWeb(nodeStream):nodeStream;
    try{await op(()=>target.put(object.targetKey,uploadBody,object.contentType,object.cacheControl));}
    catch(error){nodeStream.destroy();throw error;}
    const head=await op(()=>target.head(object.targetKey));
    if(head&&head.size!==null&&head.size!==entry.size)throw Error('Destination length mismatch');
    if(verifyFull){
      // The verification read comes from the cache file, never a second
      // source download.
      const fileDigest=await cache.digestFile(hash);
      if(await targetDigest()!==fileDigest)throw Error('Destination integrity mismatch');
    }
    return 'uploaded';
  }finally{await cache.release(hash);}
}

async function syncObject(object,{source,target,retries,sleep,stats,verifyFull,cache}){
  const v1Mode=source.storage==='http';
  const op=operation=>{
    if(!v1Mode)return withRetry(operation,{retries,sleep,stats});
    return operation().catch(error=>{
      if(error?.status===429)throw Error('Target request throttled (HTTP 429); no automatic retry');
      throw error;
    });
  };
  const load=async()=>{
    if(object.body)return object.body;
    if(v1Mode)return Buffer.from(await source.read(object.logicalKey));
    return Buffer.from(await withRetry(()=>source.read(object.logicalKey),{retries,sleep,stats}));
  };
  const expectedHash=object.kind==='audio'?object.logicalKey.slice(6,-5):null;
  if(expectedHash&&cache&&source.storage==='http')return syncCachedAudio(object,{source,target,cache,verifyFull,op});

  const existing=await op(()=>target.head(object.targetKey));
  if(existing){
    if(v1Mode&&object.kind!=='pointer'&&!verifyFull)return 'skipped';
    const current=await op(()=>target.get(object.targetKey));
    if(expectedHash){
      if(sha256(current)===expectedHash)return 'skipped';
      if(v1Mode)throw Error('Destination differs; existing object not uploaded');
    }else{
      const payload=await load();
      if(sha256(current)===sha256(payload))return 'skipped';
      if(v1Mode&&object.kind!=='pointer')throw Error('Destination differs; existing object not uploaded');
    }
  }

  const payload=await load();
  if(expectedHash&&sha256(payload)!==expectedHash)throw Error('Source audio integrity mismatch');
  if(v1Mode&&payload.length!==object.size)throw Error('Source length mismatch');
  await op(()=>target.put(object.targetKey,payload,object.contentType,object.cacheControl));
  if(v1Mode){
    const head=await op(()=>target.head(object.targetKey));
    if(head&&head.size!==null&&head.size!==payload.length)throw Error('Destination length mismatch');
    if(verifyFull&&sha256(await op(()=>target.get(object.targetKey)))!==sha256(payload))throw Error('Destination integrity mismatch');
    return 'uploaded';
  }
  const check=await withRetry(()=>target.get(object.targetKey),{retries,sleep,stats});
  if(sha256(check)!==sha256(payload))throw Error('Target verification failed');
  return 'uploaded';
}

// Collect the complete stale set first, then delete. Two guards stay
// unchanged: only keys inside the target layout are candidates, and only
// managed key shapes (current.json / releases/ / months/ / audio/) are ever
// removed - user data under the same prefix is listed but never touched.
// The source backend is a different client and is never reached here.
async function pruneTarget(plan,target,{retries,sleep,stats}){
  const keep=new Set(plan.objects.map(object=>object.targetKey));
  const options=plan.targetOptions;
  const listed=await withRetry(()=>target.list(options.prefix),{retries,sleep,stats});
  const extra=options.audioPrefix.startsWith(options.prefix)?[]:await withRetry(()=>target.list(options.audioPrefix),{retries,sleep,stats});
  const stale=new Map();
  for(const entry of [...listed,...extra]){
    if(keep.has(entry.key)||stale.has(entry.key))continue;
    let managed=false;
    if(entry.key.startsWith(options.prefix)){
      const relative=entry.key.slice(options.prefix.length);
      managed=relative==='current.json'||RELEASE_KEY.test(relative)||MONTH_KEY.test(relative);
    }
    if(!managed&&entry.key.startsWith(options.audioPrefix))managed=AUDIO_NAME.test(entry.key.slice(options.audioPrefix.length));
    if(managed)stale.set(entry.key,Number(entry.size)||0);
  }
  // The listing above is complete before the first delete is issued.
  let deleted=0;
  let bytes=0;
  for(const [key,size] of stale){
    await withRetry(()=>target.delete(key),{retries,sleep,stats});
    deleted++;
    bytes+=size;
  }
  return {deleted,bytes};
}

export async function migrate(plan,{source,target,concurrency=DEFAULT_CONCURRENCY,dryRun=false,prune=DEFAULT_PRUNE,verifyFull=false,retries=DEFAULT_RETRIES,sleep=defaultSleep,stats={retries:0},cache=null}={}){
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>16)throw Error('Invalid concurrency');
  // Pruning needs a listing; S3-like targets list through the SDK and the
  // Blob target lists through its own paginated API, so both reclaim.
  const canPrune=typeof target.list==='function';
  const summary={
    ok:true,
    dryRun,
    verifyFull,
    objects:plan.objects.length,
    counts:plan.counts,
    bytes:plan.bytes,
    budgetBytes:plan.budgetBytes,
    budgetExceeded:plan.budgetExceeded,
    release:plan.release,
    months:plan.months,
    droppedMonths:plan.droppedMonths??0,
    normalized:plan.normalized??false,
    pruned:plan.pruned,
    pruneMode:!prune?'disabled':(canPrune?'auto':'skipped'),
    uploaded:0,
    skipped:0,
    deleted:0,
    deletedBytes:0,
    retries:stats.retries??0
  };
  if(dryRun)return summary;

  const objects=plan.objects.filter(object=>object.kind!=='pointer');
  await pool(objects,concurrency,async object=>{
    const result=await syncObject(object,{source,target,retries,sleep,stats,verifyFull,cache});
    if(result==='uploaded')summary.uploaded++;else summary.skipped++;
  });

  const pointer=plan.objects.find(object=>object.kind==='pointer');
  if(!pointer)throw Error('Migration plan has no pointer');
  const pointerResult=await syncObject(pointer,{source,target,retries,sleep,stats,verifyFull,cache});
  if(pointerResult==='uploaded')summary.uploaded++;else summary.skipped++;

  // Reaching this point means every object verified and the pointer switch
  // succeeded; any upload/verification/pointer failure throws above and no
  // object is ever deleted.
  if(prune&&canPrune){
    const result=await pruneTarget(plan,target,{retries,sleep,stats});
    summary.deleted=result.deleted;
    summary.deletedBytes=result.bytes;
    summary.versioningHint='Deletes do not reclaim space on a versioned bucket; keep the B2 bucket unversioned or purge old versions separately';
  }
  summary.retries=stats.retries??0;
  if(cache)summary.cache=cache.stats();
  return summary;
}

function sameLocation(source,target){
  if(source?.storage==='http'){
    const base=String(source.base??'').replace(/\/+$/,'').toLowerCase();
    const endpoint=String(target?.options?.clientOptions?.endpoint??'').replace(/\/+$/,'').toLowerCase();
    return base!==''&&endpoint===base;
  }
  if(!source?.options||!target?.options)return false;
  const a=source.options;
  const b=target.options;
  return a.bucket===b.bucket&&a.prefix===b.prefix&&a.audioPrefix===b.audioPrefix&&(a.clientOptions?.endpoint??'')===(b.clientOptions?.endpoint??'');
}

const USAGE=`Usage: node scripts/migrate-s3.mjs [options]

Copies current.json, release manifests, month blocks, and referenced audio from
the configured source to TARGET (S3-compatible, e.g. Backblaze B2, or Vercel
Blob).

Sources:
  SOURCE_AUDIO_BASE=<url>   production HTTP API (/api/current, /api/catalog,
                            /api/month/<id>, /api/audio/<hash>.opus; follows
                            307; no credentials, no automatic retries)
  CATALOG_STORAGE=s3        direct S3 source via S3_*/AUDIO_S3_*
  CATALOG_STORAGE=local     local directory via CATALOG_LOCAL_DIR

Target: TARGET_S3_* > AUDIO_S3_* > S3_* (B2 recommended: AUDIO_S3_*), or
TARGET_STORAGE=blob with BLOB_BASE_URL/BLOB_READ_WRITE_TOKEN.

  --dry-run              report object count/bytes only; no target writes
  --verify-full          compare full digests of existing and uploaded objects
  --window-days N        keep audio from the last N days (default 30; 0 disables)
  --months N             keep the last N business months (0 disables)
  --concurrency N        parallel transfer slots (default 5, max 16)
  --budget-mb N          warn when the planned transfer exceeds N MB
  --timeout-ms N         per-request timeout for the HTTP source (default 120000)
  --cache-dir PATH       audio temp-file cache directory (default
                         $TMPDIR/anyun-migrate-s3; env MIGRATE_CACHE_DIR).
                         HTTP-source audio downloads to <hash>.opus.part,
                         renames on completion, streams into the target, and
                         is deleted after verification. Complete files are
                         reused across interrupted runs; the directory is
                         cleared when the run exits.
  --prune                legacy alias; pruning is already the default
  --no-prune             keep target objects outside this plan (explicit
                         opt-out; the target then grows without bound)
  --now EPOCH            evaluation time in unix seconds (testing)
  --help`;

export async function run(argv=process.argv.slice(2),env=process.env,deps={}){
  const options=parseArgs(argv);
  if(options.help){(deps.log??console.log)(USAGE);return null;}
  const source=deps.source??sourceFromEnv(env,{client:deps.client,httpFetcher:deps.httpFetcher,timeoutMs:options.timeoutMs});
  const target=deps.target??targetFromEnv(env,{s3Client:deps.s3Client??deps.client,blobFetcher:deps.blobFetcher,blobSdk:deps.blobSdk});
  if(sameLocation(source,target))throw Error('Source and target resolve to the same location');
  const now=options.now??deps.now??Date.now()/1000;
  // The temp-file cache exists only for the HTTP source chain (the audio path
  // that would otherwise buffer whole files in memory); dry-run never
  // downloads audio. run()'s finally clears the whole dedicated directory on
  // every exit path, including failures.
  const cache=source.storage==='http'&&!options.dryRun
    ?(deps.cache??createAudioCache({dir:resolveCacheDir(env,options.cacheDir),statfsFn:deps.statfs}))
    :null;
  try{
    const plan=await buildPlan({source,target,now,windowDays:options.windowDays,months:options.months,budgetBytes:options.budgetMb*1024*1024,retries:deps.retries??DEFAULT_RETRIES,sleep:deps.sleep});
    const summary=await migrate(plan,{source,target,concurrency:options.concurrency,dryRun:options.dryRun,prune:options.prune,verifyFull:options.verifyFull,retries:deps.retries??DEFAULT_RETRIES,sleep:deps.sleep,cache});
    (deps.log??console.log)(JSON.stringify(summary));
    if(summary.budgetExceeded)(deps.warn??console.error)(`Warning: planned transfer (${summary.bytes} bytes) exceeds --budget-mb ${options.budgetMb}`);
    return summary;
  }finally{
    if(cache)await cache.clear();
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  run().catch(error=>{
    console.error(`S3 migration failed: ${error?.message??'unknown error'}`);
    process.exitCode=1;
  });
}
