#!/usr/bin/env node
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {configuredStore} from '../src/lib/server/storage.mjs';
import {publishMonths,digest} from '../src/lib/server/publisher.mjs';
import {maxQueryMonths,monthId,monthBounds,queryMonths} from '../src/lib/server/months.mjs';
const execute=promisify(execFile);
export {publishMonths};
// Match manifest retention before conversion, reads, or uploads.
export function retainedAudios(audios,{now=Date.now()/1000,maxMonths=0}={}){const entries=[...new Set(audios.map(a=>monthId(a.startAt)))].map(id=>({...monthBounds(id),available:true}));const retained=new Set(queryMonths(entries,now,maxQueryMonths(maxMonths)).map(e=>e.id));return audios.filter(a=>retained.has(monthId(a.startAt)));}
export async function preparePublicationAudio(audios,sources,temp,options={},prepare=prepareAudio){return prepare(audios,sources,temp);}
export async function prepareAudio(audios,sources,temp,executeMedia=execute){const media=new Map();for(const [index,a]of audios.entries()){const original=sources[a.id];if(!original)throw Error('Missing audio source');if(original.toLowerCase().endsWith('.opus'))media.set(a.id,original);else{const target=join(temp,index+'.opus');await executeMedia('ffmpeg',['-nostdin','-v','error','-i',original,'-vn','-c:a','libopus','-b:a','96k',target],{maxBuffer:1048576});media.set(a.id,target);}}return media;}
export async function publish(audios,media,store,options={}){const uploaded=new Map();for(const a of audios){const bytes=await readFile(media.get(a.id));if(bytes.subarray(0,4).toString()!=='OggS')throw Error('Invalid Opus');const key='audio/'+digest(bytes)+'.opus';const existing=await store.read(key);if(existing.status===404){await store.write(key,bytes,'audio/ogg');const check=await store.read(key);if(!check.ok||digest(Buffer.from(await check.arrayBuffer()))!==digest(bytes))throw Error('Audio verification failed');}else if(!existing.ok)throw Error('Audio unavailable');else {if(digest(Buffer.from(await existing.arrayBuffer()))!==digest(bytes))throw Error('Existing audio integrity mismatch');}uploaded.set(a.id,{...a,opus:key});}return publishMonths(audios.map(a=>uploaded.get(a.id)??a),store,options);}
export async function run(args=process.argv.slice(2),env=process.env){const options={};for(let i=0;i<args.length;i++){if(!['--audio-dir','--lrc-dir'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw Error('Usage: --audio-dir DIRECTORY --lrc-dir DIRECTORY');options[args[i]]=args[++i];}if(!options['--audio-dir']||!options['--lrc-dir'])throw Error('Both source directories required');const maxMonths=maxQueryMonths(env.MAX_QUERY_MONTHS),store=configuredStore(env);const result=await execute('python3',[join(dirname(fileURLToPath(import.meta.url)),'derive-catalog.py'),options['--audio-dir'],options['--lrc-dir']],{env,maxBuffer:64*1024*1024});const {audios,sources}=JSON.parse(result.stdout);const temp=await mkdtemp(join(tmpdir(),'diary-publish-'));try{const publicationOptions={maxMonths,now:Date.now()/1000};const media=await preparePublicationAudio(audios,sources,temp,publicationOptions);const manifest=await publish(audios,media,store,publicationOptions);console.log(JSON.stringify({revision:manifest.revision,months:manifest.months.length}));}finally{await rm(temp,{recursive:true,force:true});}}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))run().catch(()=>{console.error('Publication failed; verify source inputs and storage configuration. Re-read manifest before retrying an uncertain write.');process.exitCode=1;});
