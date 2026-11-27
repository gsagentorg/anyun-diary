#!/usr/bin/env node
import {mkdtemp,readFile,rm,mkdir,rename,stat,open,unlink} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {tmpdir,homedir,availableParallelism} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {configuredStore} from '../src/lib/server/storage.mjs';
import {publishMonths,loadPrevious,audioKey,digest} from '../src/lib/server/publisher.mjs';
import {validateMonth} from '../src/lib/catalog-schema.js';
import {maxQueryMonths,monthId,monthBounds,queryMonths} from '../src/lib/server/months.mjs';
const execute=promisify(execFile);
export {publishMonths};
// Match manifest retention before conversion, reads, or uploads.
export function retainedAudios(audios,{now=Date.now()/1000,maxMonths=0}={}){const entries=[...new Set(audios.map(a=>monthId(a.startAt)))].map(id=>({...monthBounds(id),available:true}));const retained=new Set(queryMonths(entries,now,maxQueryMonths(maxMonths)).map(e=>e.id));return audios.filter(a=>retained.has(monthId(a.startAt)));}
export async function preparePublicationAudio(audios,sources,temp,options={},prepare=prepareAudio){return prepare(audios,sources,temp,execute,options);}
// The codec arguments below are part of the cache key, so changing encoding parameters can never reuse a stale artifact.
const CODEC_ARGS=['-vn','-c:a','libopus','-b:a','96k'];
const MAX_CONCURRENCY=64;
export function resolveConcurrency(value=process.env.PUBLISH_CONCURRENCY){if(value===undefined||value===null||value==='')return Math.max(1,Math.min(MAX_CONCURRENCY,availableParallelism()));const parsed=Number(String(value).trim());if(!Number.isInteger(parsed)||parsed<1||parsed>MAX_CONCURRENCY)throw Error('PUBLISH_CONCURRENCY must be an integer from 1 to '+MAX_CONCURRENCY);return parsed;}
export function resolveCacheDir(value=process.env.PUBLISH_CACHE_DIR){if(value!==undefined&&value!==null&&value!==''){if(typeof value!=='string')throw Error('PUBLISH_CACHE_DIR must be a directory path');return value;}return join(process.env.XDG_CACHE_HOME||join(homedir(),'.cache'),'anyun-publish');}
async function encoderSignature(executeMedia){try{const {stdout}=await executeMedia('ffmpeg',['-version'],{maxBuffer:262144});const version=String(stdout==null?'':stdout).split('\n')[0].trim();return version?'ffmpeg '+version+' | '+CODEC_ARGS.join(' '):null;}catch{return null;}}
async function sourceDigest(file){const hash=createHash('sha256');await pipeline(createReadStream(file),hash);return hash.digest('hex');}
function cacheKey(sourceHash,signature){return createHash('sha256').update(sourceHash).update('\0').update(signature).digest('hex');}
async function validCached(file){try{const info=await stat(file);if(!info.isFile()||info.size<4)return false;const handle=await open(file,'r');try{const head=Buffer.alloc(4);const {bytesRead}=await handle.read(head,0,4,0);return bytesRead===4&&head.toString()==='OggS';}finally{await handle.close();}}catch{return false;}}
async function mapLimit(items,limit,worker){const results=new Array(items.length);let next=0,failure=null;const runners=Array.from({length:Math.min(limit,items.length)},async()=>{while(!failure){const index=next++;if(index>=items.length)return;try{results[index]=await worker(items[index],index);}catch(error){failure=failure??error;return;}}});await Promise.all(runners);if(failure)throw failure;return results;}
export async function prepareAudio(audios,sources,temp,executeMedia=execute,options={}){
  const concurrency=resolveConcurrency(options.concurrency==null?process.env.PUBLISH_CONCURRENCY:options.concurrency);
  const cacheDir=options.cacheDir==null?resolveCacheDir():options.cacheDir;
  for(const a of audios)if(!sources[a.id])throw Error('Missing audio source');
  const passThrough=a=>String(sources[a.id]).toLowerCase().endsWith('.opus');
  // Probe the encoder signature once per run, and only when a real transcode is needed.
  const signature=audios.some(a=>!passThrough(a))?(options.encoderSignature==null?await encoderSignature(executeMedia):options.encoderSignature):null;
  if(signature)await mkdir(cacheDir,{recursive:true});
  const prepared=await mapLimit(audios,concurrency,async(a,index)=>{
    const original=sources[a.id];
    if(passThrough(a))return original;
    let key=null,target=null;
    if(signature){key=cacheKey(await sourceDigest(original),signature);target=join(cacheDir,key+'.opus');if(await validCached(target))return target;await unlink(target).catch(()=>{});}
    const output=signature?join(cacheDir,key+'.'+randomBytes(6).toString('hex')+'.part.opus'):join(temp,index+'.opus');
    try{await executeMedia('ffmpeg',['-nostdin','-v','error','-i',original,...CODEC_ARGS,output],{maxBuffer:1048576});if(!signature)return output;await rename(output,target);return target;}catch(error){if(signature)await rm(output,{force:true}).catch(()=>{});throw error;}
  });
  return new Map(audios.map((a,index)=>[a.id,prepared[index]]));
}
// Audio keys already referenced by the previous release. Keys are content-addressed,
// so a reference alone proves the object exists; only the (small) month blocks of
// the months in this run are read, never the audio bodies.
export async function referencedAudioKeys(store,previous,audios){const keys=new Set();if(!previous)return keys;const months=new Set(audios.map(a=>monthId(a.startAt)));for(const entry of previous.months){if(!months.has(entry.id))continue;const r=await store.read(entry.key);if(!r.ok)throw Error('Previous month unavailable');const block=validateMonth(await r.json(),entry);for(const a of block.audios)keys.add(audioKey(a.opus));}return keys;}
// `options.previous` may be the previous release manifest, null, or a Set of audio keys
// that are already published; omitted means "load it from the current pointer".
export async function publish(audios,media,store,options={}){const {previous:given,audioKeys,...rest}=options;const previous=given instanceof Set?await loadPrevious(store):given===undefined?await loadPrevious(store):given;const referenced=audioKeys??(given instanceof Set?given:await referencedAudioKeys(store,previous,audios));const uploaded=new Map();for(const a of audios){const bytes=await readFile(media.get(a.id));if(bytes.subarray(0,4).toString()!=='OggS')throw Error('Invalid Opus');const key='audio/'+digest(bytes)+'.opus';uploaded.set(a.id,{...a,opus:key});if(referenced.has(key))continue;await store.write(key,bytes,'audio/ogg');}return publishMonths(audios.map(a=>uploaded.get(a.id)??a),store,{...rest,previous});}
export async function run(args=process.argv.slice(2),env=process.env){const options={};for(let i=0;i<args.length;i++){if(!['--audio-dir','--lrc-dir'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw Error('Usage: --audio-dir DIRECTORY --lrc-dir DIRECTORY');options[args[i]]=args[++i];}if(!options['--audio-dir']||!options['--lrc-dir'])throw Error('Both source directories required');const maxMonths=maxQueryMonths(env.MAX_QUERY_MONTHS),store=configuredStore(env);const result=await execute('python3',[join(dirname(fileURLToPath(import.meta.url)),'derive-catalog.py'),options['--audio-dir'],options['--lrc-dir']],{env,maxBuffer:64*1024*1024});const {audios,sources}=JSON.parse(result.stdout);const temp=await mkdtemp(join(tmpdir(),'diary-publish-'));try{const publicationOptions={maxMonths,now:Date.now()/1000,concurrency:resolveConcurrency(env.PUBLISH_CONCURRENCY),cacheDir:resolveCacheDir(env.PUBLISH_CACHE_DIR)};const media=await preparePublicationAudio(audios,sources,temp,publicationOptions);const manifest=await publish(audios,media,store,publicationOptions);console.log(JSON.stringify({revision:manifest.revision,months:manifest.months.length}));}finally{await rm(temp,{recursive:true,force:true});}}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))run().catch(()=>{console.error('Publication failed; verify source inputs and storage configuration. Re-read manifest before retrying an uncertain write.');process.exitCode=1;});
