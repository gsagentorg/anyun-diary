#!/usr/bin/env node
import { readFile, stat, mkdir, rename, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { S3Client, GetBucketCorsCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3';
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
const hash = s => createHash('sha256').update(s).digest('hex');
const hmac = (k,s) => createHmac('sha256',k).update(s).digest();
export function presign({method='PUT',key,ep,region,bucket,ak,sk,ttl=3600,prefix='audio/',pathStyle=false,now=new Date()}) {
  const u=new URL(ep); if(!pathStyle) u.hostname=bucket+'.'+u.hostname;
  u.pathname='/'+(pathStyle?enc(bucket)+'/':'')+(prefix+key).split('/').map(enc).join('/');
  const date=now.toISOString().replace(/[-:]/g,'').replace(/[.][0-9]{3}/,'');
  const scope=date.slice(0,8)+'/'+region+'/s3/aws4_request';
  const q={'X-Amz-Algorithm':'AWS4-HMAC-SHA256','X-Amz-Credential':ak+'/'+scope,'X-Amz-Date':date,'X-Amz-Expires':String(ttl),'X-Amz-SignedHeaders':'host'};
  const query=Object.entries(q).sort().map(([k,v])=>enc(k)+'='+enc(v)).join('&');
  const canonical=[method,u.pathname,query,'host:'+u.host+'\n','host','UNSIGNED-PAYLOAD'].join('\n');
  const signing=hmac(hmac(hmac(hmac('AWS4'+sk,date.slice(0,8)),region),'s3'),'aws4_request');
  const sig=createHmac('sha256',signing).update(['AWS4-HMAC-SHA256',date,scope,hash(canonical)].join('\n')).digest('hex');
  u.search=query+'&X-Amz-Signature='+sig; return u.href;
}
function number(v,label,max) { if(!/^[0-9]+$/.test(String(v)) || +v<1 || +v>max) throw Error('Invalid '+label); return +v; }
function url(v,label) { let u; try{u=new URL(v);}catch{throw Error('Invalid '+label);} if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash) throw Error('Invalid '+label); return u; }
function parse(args) {
  const command=args.shift(), o={command,concurrency:4,'timeout-ms':120000,out:'static/audio'};
  if(!['transfer','pull','push-s3','verify','configure-cors'].includes(command)) throw Error('Command: transfer | pull | push-s3 | verify | configure-cors');
  for(let i=0;i<args.length;i++) { const m=/^--([a-z-]+)(?:=(.*))?$/.exec(args[i]); if(!m)throw Error('Invalid option'); const [,k,v]=m;
    if(['dry-run','overwrite','source-api','verify-full','conditional-put','configure-cors'].includes(k)){if(v!==undefined)throw Error('Flag takes no value');o[k]=true;}
    else if(k==='cors-origin'){(o.origins??=[]).push(v??args[++i]);}
    else if(['concurrency','timeout-ms','out'].includes(k)){o[k]=v??args[++i];if(!o[k]||o[k].startsWith('--'))throw Error('Missing option value');}
    else throw Error('Unknown option');
  }
  if(o['configure-cors']&&o.command!=='transfer')throw Error('--configure-cors requires transfer');
  if(o.command==='configure-cors'||o['configure-cors']){if(!o.origins?.length)throw Error('Required --cors-origin');o.origins=[...new Set(o.origins.map(corsOrigin))];}
  else if(o.origins)throw Error('--cors-origin requires configure-cors');
  o.concurrency=number(o.concurrency,'concurrency',32);o.timeout=number(o['timeout-ms'],'timeout-ms',3600000);return o;
}

const CORS_ID='anyun-diary-audio-read-v1';
function corsOrigin(v){const u=url(v,'CORS origin');if(v!==u.origin||u.hostname.includes('*'))throw Error('CORS origin must be exact http(s) origin without path or wildcard');return u.origin;}
function validateRules(rules){
  if(!Array.isArray(rules)||rules.length>100)throw Error('Invalid CORS rules; refusing replacement');
  for(const r of rules){
    if(!r||Object.keys(r).some(k=>!['ID','AllowedOrigins','AllowedMethods','AllowedHeaders','ExposeHeaders','MaxAgeSeconds'].includes(k))||
      (r.ID!==undefined&&(typeof r.ID!=='string'||r.ID.length>255))||
      !['AllowedOrigins','AllowedMethods'].every(k=>Array.isArray(r[k])&&r[k].length&&r[k].every(x=>typeof x==='string'&&x.length))||
      !r.AllowedMethods.every(x=>['GET','HEAD','PUT','POST','DELETE'].includes(x))||
      !['AllowedHeaders','ExposeHeaders'].every(k=>r[k]===undefined||(Array.isArray(r[k])&&r[k].every(x=>typeof x==='string'&&x.length)))||
      (r.MaxAgeSeconds!==undefined&&(!Number.isInteger(r.MaxAgeSeconds)||r.MaxAgeSeconds<0)))throw Error('Invalid CORS rules; refusing replacement');
  }
}
function canonicalRules(rules){return JSON.stringify(rules.map(r=>Object.fromEntries(Object.keys(r).sort().map(k=>[k,Array.isArray(r[k])?[...r[k]].sort():r[k]]))).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));}
async function configureCors(cfg,o){
  const client=new S3Client({endpoint:cfg.ep,region:cfg.region,credentials:{accessKeyId:cfg.ak,secretAccessKey:cfg.sk},forcePathStyle:cfg.pathStyle,maxAttempts:1,requestHandler:{connectionTimeout:o.timeout,requestTimeout:o.timeout}});
  const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),o.timeout);
  const send=command=>client.send(command,{abortSignal:ac.signal});
  async function get(){try{const result=await send(new GetBucketCorsCommand({Bucket:cfg.bucket}));if(!result.CORSRules)throw Error('Missing CORS rules');validateRules(result.CORSRules);return result.CORSRules;}catch(e){if(e.name==='NoSuchCORSConfiguration')return [];throw e;}}
  try{
    console.log('CORS: reading existing configuration');
    const existing=await get(),managed=existing.filter(r=>r.ID===CORS_ID);
    if(managed.length>1)throw Error('Duplicate managed CORS rule; refusing replacement');
    if(managed.length){try{managed[0].AllowedOrigins.forEach(corsOrigin);}catch{throw Error('Invalid managed CORS origins; refusing replacement');}}
    const rule={ID:CORS_ID,AllowedOrigins:[...new Set([...(managed[0]?.AllowedOrigins??[]),...o.origins])].sort(),AllowedMethods:['GET','HEAD'],AllowedHeaders:['Range'],ExposeHeaders:['Accept-Ranges','Content-Range','Content-Length','ETag']};
    if(managed.length&&canonicalRules([{...managed[0],AllowedOrigins:rule.AllowedOrigins}])!==canonicalRules([rule]))throw Error('Managed CORS rule conflicts; refusing replacement');
    const intended=[...existing.filter(r=>r.ID!==CORS_ID),rule];validateRules(intended);
    if(o['dry-run']){console.log('CORS dry-run (no PUT): '+JSON.stringify(intended.map(r=>({...r,ID:r.ID===CORS_ID?CORS_ID:r.ID===undefined?undefined:'[existing rule]',AllowedOrigins:r.AllowedOrigins.map(x=>o.origins.includes(x)?x:'[existing origin]')}))));return;}
    if(canonicalRules(existing)===canonicalRules(intended)){console.log('CORS: already configured; no PUT');return;}
    await send(new PutBucketCorsCommand({Bucket:cfg.bucket,CORSConfiguration:{CORSRules:intended}}));
    let actual;try{actual=await get();}catch{throw Error('CORS read-back mismatch or unreadable configuration');}
    if(canonicalRules(actual)!==canonicalRules(intended))throw Error('CORS read-back mismatch');
    console.log('CORS: configuration verified');
  }catch(e){const status=e.$metadata?.httpStatusCode;throw Error('CORS configuration failed'+(status?' (HTTP '+status+')':'')+': '+(e.message?.startsWith('CORS ')||e.message?.includes('refusing replacement')?e.message:'GetBucketCors/PutBucketCors permission, service support, response or network error')+'; no fallback or automatic retry');}
  finally{clearTimeout(timer);ac.abort();client.destroy();}
}
async function request(u,init,signal,missing=false) {
  const r=await fetch(u,{...init,signal,headers:{'accept-encoding':'identity',...init?.headers},redirect:init?.method==='PUT'?'error':'follow'});
  if(missing&&r.status===404){await r.body?.cancel();return null;}
  if(!r.ok){const retry=r.headers.get('retry-after');await r.body?.cancel();throw Error('HTTP '+r.status+(r.status===429?' throttled; Retry-After '+(/^[0-9]+$/.test(retry??'')?retry+' seconds':'unspecified/date; consult provider'):'')+'; no automatic retry');}
  if(r.headers.get('content-encoding')&&r.headers.get('content-encoding')!=='identity'){await r.body?.cancel();throw Error('Encoded response unsupported');}return r;
}
function meter(full=true){const h=full?createHash('sha256'):null;let bytes=0,first=Buffer.alloc(0);const stream=new Transform({transform(c,e,cb){bytes+=c.length;h?.update(c);if(first.length<4)first=Buffer.concat([first,c.subarray(0,4-first.length)]);cb(null,c);}});return {stream,result(){if(first.toString()!=='OggS')throw Error('Invalid OggS');return {bytes,sha256:h?.digest('hex')};}};}
async function digest(body,signal){const m=meter();await pipeline(body,m.stream,new Writable({write(c,e,cb){cb();}}),{signal});return m.result();}
function contentLength(r){const l=r.headers.get('content-length');if(l===null||!/^[0-9]+$/.test(l)||!Number.isSafeInteger(+l))throw Error('Missing/invalid Content-Length');return +l;}
const same=(a,b)=>a.bytes===b.bytes&&a.sha256===b.sha256;
export async function run(args=process.argv.slice(2),env=process.env,cwd=process.cwd()) {
  const o=parse([...args]);const data=o.command==='configure-cors'?{recordings:[]}:JSON.parse(await readFile(join(cwd,'src/lib/data.json'),'utf8'));
  const names=[...new Set(data.recordings.flatMap(r=>r.clips.map(c=>c.opus).filter(Boolean)))];
  for(const n of names)if(typeof n!=='string'||!n.endsWith('.opus')||/[\\/\x00-\x1f\x7f]/.test(n)||n.includes('..'))throw Error('Unsafe catalog filename');
  let source,cfg;
  if(['transfer','pull'].includes(o.command))source=url(env.SOURCE_AUDIO_BASE,'SOURCE_AUDIO_BASE');
  if(['transfer','push-s3','configure-cors'].includes(o.command)){
    for(const k of ['ENDPOINT','REGION','BUCKET','ACCESS_KEY_ID','SECRET_ACCESS_KEY'])if(!env['AUDIO_S3_'+k])throw Error('Missing AUDIO_S3_'+k);
    const ep=url(env.AUDIO_S3_ENDPOINT,'S3 endpoint');if(ep.pathname!=='/')throw Error('S3 endpoint must be origin only');
    if(!/^[a-z0-9][a-z0-9.-]*$/.test(env.AUDIO_S3_BUCKET)||!/^[a-z0-9-]+$/.test(env.AUDIO_S3_REGION))throw Error('Invalid bucket/region');
    if(![undefined,'0','1'].includes(env.AUDIO_S3_PATH_STYLE))throw Error('Invalid path style');
    const prefix=env.AUDIO_S3_KEY_PREFIX??'audio/';if(prefix.startsWith('/')||prefix.includes('..')||[...prefix].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===92))throw Error('Invalid prefix');
    cfg={ep:ep.origin,region:env.AUDIO_S3_REGION,bucket:env.AUDIO_S3_BUCKET,ak:env.AUDIO_S3_ACCESS_KEY_ID,sk:env.AUDIO_S3_SECRET_ACCESS_KEY,prefix,pathStyle:env.AUDIO_S3_PATH_STYLE==='1',ttl:number(env.AUDIO_S3_URL_TTL_SECONDS??3600,'TTL',604800)};
  }
  if(o.command==='configure-cors'||o['configure-cors'])await configureCors(cfg,o);
  if(o.command==='configure-cors')return;
  const dir=resolve(cwd,o.out);let next=0,completed=0;const failures=[];
  const log=(i,stage)=>console.log(new Date().toISOString()+' ['+(i+1)+'/'+names.length+'] '+stage);
  const safeError=e=>e.name==='AbortError'?'Timeout/cancelled':/https?:|Signature|Credential/i.test(e.message)?'Network failure (redacted)':e.message;
  async function object(name,index){
    log(index,'start');const ac=new AbortController(),signal=ac.signal,timer=setTimeout(()=>ac.abort(),o.timeout);
    try{
      const local=join(dir,name);const from=source?new URL(o['source-api']?'api/audio-url?f='+enc(name):'audio/'+enc(name),source.href.endsWith('/')?source.href:source.href+'/').href:null;
      const s3=method=>presign({...cfg,key:name,method});
      log(index,'checking source');
      const read=async()=>source?(await request(from,{},signal)).body:createReadStream(local);
      if(o.command==='verify'){await digest(await read(),signal);return;}
      let size;if(source){const r=await request(from,{method:'HEAD'},signal);try{size=contentLength(r);}finally{await r.body?.cancel();}}else size=(await stat(local)).size;
      if(o['dry-run']){log(index,'dry-run checked');return;}
      const full=o['verify-full']||o.command==='pull';
      const original=full?await digest(await read(),signal):null;if(original&&original.bytes!==size)throw Error('Source length mismatch');
      if(o.command==='pull'){
        try{const old=await digest(createReadStream(local),signal);if(same(old,original))return;if(!o.overwrite)throw Error('Existing backup differs; use --overwrite');}catch(e){if(e.code!=='ENOENT')throw e;}
        await mkdir(dir,{recursive:true});const tmp=local+'.part';let created=false;
        try{const sink=createWriteStream(tmp,{flags:'wx'});sink.on('open',()=>{created=true;});const m=meter();await pipeline(await read(),m.stream,sink,{signal});if(!same(m.result(),original))throw Error('Source changed');await rename(tmp,local);}finally{if(created)await rm(tmp,{force:true});}return;
      }
      log(index,'checking destination');
      const existing=await request(s3('HEAD'),{method:'HEAD'},signal,true);
      if(existing){
        await existing.body?.cancel();
        if(full){
          const r=await request(s3('GET'),{},signal);
          if(!same(await digest(r.body,signal),original))throw Error('Destination differs; existing object not uploaded');
        }
        log(index,'skip: destination exists');
        return; // Existing destination keys are never re-uploaded.
      }
      log(index,'uploading');
      const body=await read(),m=meter(full);const pump=pipeline(body,m.stream,{signal});pump.catch(()=>ac.abort());
      try{const r=await request(s3('PUT'),{method:'PUT',body:m.stream,duplex:'half',headers:{'content-length':String(size),'content-type':'audio/ogg',...(o['conditional-put']?{'if-none-match':'*'}:{})}},signal);await r.body?.cancel();await pump;const sent=m.result();if(sent.bytes!==size)throw Error('Source length mismatch during upload');if(full&&!same(sent,original))throw Error('Source changed during upload');}
      catch(e){ac.abort();m.stream.destroy();await pump.catch(()=>{});throw e;}
      log(index,'checking uploaded object');
      const head=await request(s3('HEAD'),{method:'HEAD'},signal);try{if(contentLength(head)!==size)throw Error('Destination length mismatch');}finally{await head.body?.cancel();}
      if(full){const r=await request(s3('GET'),{},signal);if(!same(await digest(r.body,signal),original))throw Error('Destination integrity mismatch');}
    }finally{clearTimeout(timer);ac.abort();}
  }
  await Promise.all(Array.from({length:Math.min(o.concurrency,names.length)},async()=>{while(next<names.length){const i=next++;try{await object(names[i],i);completed++;log(i,'done; completed '+completed+'/'+names.length);}catch(e){const message='object '+(i+1)+': '+safeError(e);failures.push(message);console.error(new Date().toISOString()+' ERROR '+message);}}}));
  console.log(o.command+': '+(names.length-failures.length)+'/'+names.length+' objects OK'+(o['dry-run']?' (dry-run; no PUT)':''));if(failures.length)throw Error(failures.join('\n'));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))run().catch(e=>{console.error(/https?:|Signature|Credential/i.test(e.message)?'Migration failed (redacted)':e.message);process.exitCode=1;});
