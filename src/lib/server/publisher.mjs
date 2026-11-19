import {createHash} from 'node:crypto';
import {validateAudio,validateManifest,validateMonth,validatePointer} from '../catalog-schema.js';
import {monthId,monthBounds,queryMonths,maxQueryMonths} from './months.mjs';
export const digest=b=>createHash('sha256').update(b).digest('hex');
export async function publishMonths(audios,store,{now=Date.now()/1000,maxMonths=0,previous}={}){
 maxMonths=maxQueryMonths(maxMonths);
 if(!previous){const r=await store.read('current.json');if(r.ok){const p=validatePointer(await r.json());const r2=await store.read(p.key);if(!r2.ok)throw Error('Previous release unavailable');previous=validateManifest(await r2.json());if(previous.revision!==p.releaseId)throw Error('Release mismatch');}else if(r.status===404){const legacy=await store.read('manifest.json');if(legacy.ok)previous=validateManifest(await legacy.json());else if(legacy.status!==404)throw Error('Previous manifest unavailable');}else throw Error('Current unavailable');}
 if(previous)validateManifest(previous);
 const groups=new Map([[monthId(now),[]]]);const ids=new Set();
 for(const audio of audios){validateAudio(audio);if(ids.has(audio.id)||!Number.isFinite(audio.startAt)||!Number.isFinite(audio.duration)||audio.duration<=0)throw Error('Invalid or duplicate audio');ids.add(audio.id);const id=monthId(audio.startAt);if(audio.monthId!==id)throw Error('Audio month mismatch');if(!groups.has(id))groups.set(id,[]);groups.get(id).push(audio);}
 // Preserve all historical month entries, including gaps and previously pruned blocks.
 const earliest=[...groups.keys(),...(previous?.months??[]).map(e=>e.id)].sort()[0];
 for(let start=monthBounds(earliest).startAt;start<=monthBounds(monthId(now)).startAt;){const id=monthId(start);if(!groups.has(id))groups.set(id,[]);start=monthBounds(id).endAt;}
 const entries=[];const payloads=new Map();
 for(const [id,rows]of groups){rows.sort((a,b)=>a.startAt-b.startAt||a.id.localeCompare(b.id));const revision=digest(JSON.stringify(rows));const entry={id,...monthBounds(id),count:rows.length,revision,key:'months/'+id+'/'+revision+'.json',available:true};entries.push(entry);payloads.set(id,JSON.stringify({schemaVersion:2,id,revision,audios:rows}));}
 entries.sort((a,b)=>a.startAt-b.startAt);
 for(const e of entries){const old=previous?.months.find(p=>p.id===e.id);if(old?.revision===e.revision&&old.available)continue;await store.write(e.key,payloads.get(e.id));}
 await verifyReferences(store,entries);
 const revision=digest(JSON.stringify(entries));const manifest={schemaVersion:2,timezone:'Asia/Shanghai',generatedAt:Math.floor(now),revision,months:entries};
 const key='releases/'+revision+'/manifest.json';const existing=await store.read(key);
 if(existing.status===404)await store.write(key,JSON.stringify(manifest));else if(!existing.ok)throw Error('Release unavailable');
 const check=await store.read(key);if(!check.ok)throw Error('Manifest verification failed');const verified=validateManifest(await check.json());if(verified.revision!==revision||digest(JSON.stringify(verified.months))!==revision)throw Error('Manifest integrity mismatch');
 const pointer=JSON.stringify({schemaVersion:2,releaseId:revision,key});const current=await store.read('current.json');if(!current.ok&&current.status!==404)throw Error('Current unavailable');if(!current.ok||JSON.stringify(await current.json())!==pointer)await commitPointer(store,pointer);return verified;
}
async function verifyReferences(store,entries){for(const e of entries){const r=await store.read(e.key);if(!r.ok)throw Error('Month reference unavailable');const m=validateMonth(await r.json(),e);if(digest(JSON.stringify(m.audios))!==e.revision)throw Error('Month integrity mismatch');for(const a of m.audios){let key=a.opus;if(/^https?:/.test(key)){const match=new URL(key).pathname.match(/audio\/[a-f0-9]{64}\.opus$/);if(!match)throw Error('Invalid audio reference');key=match[0];}if(!/^audio\/[a-f0-9]{64}\.opus$/.test(key))throw Error('Invalid audio reference');const audio=await store.read(key);if(!audio.ok||digest(Buffer.from(await audio.arrayBuffer()))!==key.slice(6,-5))throw Error('Audio reference unavailable');}}}
export async function rollbackRelease(store,releaseId){const p=validatePointer({schemaVersion:2,releaseId,key:'releases/'+releaseId+'/manifest.json'});const r=await store.read(p.key);if(!r.ok)throw Error('Release unavailable');const m=validateManifest(await r.json());if(m.revision!==releaseId||digest(JSON.stringify(m.months))!==releaseId)throw Error('Release mismatch');await verifyReferences(store,m.months);await commitPointer(store,JSON.stringify(p));return m;}
async function commitPointer(store,pointer){await store.write('current.json',pointer);const check=await store.read('current.json');if(!check.ok||JSON.stringify(await check.json())!==pointer)throw Error('Pointer verification failed; re-read current before retry');}
