import {createHash} from 'node:crypto';
import {validateAudio,validateManifest} from '../catalog-schema.js';
import {monthId,monthBounds,queryMonths,maxQueryMonths} from './months.mjs';
export const digest=b=>createHash('sha256').update(b).digest('hex');
export async function publishMonths(audios,store,{now=Date.now()/1000,maxMonths=0,previous}={}){
 maxMonths=maxQueryMonths(maxMonths);
 if(!previous){const r=await store.read('manifest.json');if(r.ok)previous=await r.json();else if(r.status!==404)throw Error('Previous manifest unavailable');}
 if(previous){validateManifest(previous);for(const e of previous.months)if(e.key!=='months/'+e.id+'/'+e.revision+'.json'||! /^[a-f0-9]{64}$/.test(e.revision))throw Error('Invalid previous month key');}
 const groups=new Map([[monthId(now),[]]]);const ids=new Set();
 for(const audio of audios){validateAudio(audio);if(ids.has(audio.id)||!Number.isFinite(audio.startAt)||!Number.isFinite(audio.duration)||audio.duration<=0)throw Error('Invalid or duplicate audio');ids.add(audio.id);const id=monthId(audio.startAt);if(audio.monthId!==id)throw Error('Audio month mismatch');if(!groups.has(id))groups.set(id,[]);groups.get(id).push(audio);}
 // Preserve all historical month entries, including gaps and previously pruned blocks.
 const earliest=[...groups.keys(),...(previous?.months??[]).map(e=>e.id)].sort()[0];
 for(let start=monthBounds(earliest).startAt;start<=monthBounds(monthId(now)).startAt;){const id=monthId(start);if(!groups.has(id))groups.set(id,[]);start=monthBounds(id).endAt;}
 const entries=[];const payloads=new Map();
 for(const [id,rows]of groups){rows.sort((a,b)=>a.startAt-b.startAt||a.id.localeCompare(b.id));const revision=digest(JSON.stringify(rows));const entry={id,...monthBounds(id),count:rows.length,revision,key:'months/'+id+'/'+revision+'.json',available:true};entries.push(entry);payloads.set(id,JSON.stringify({schemaVersion:2,id,revision,audios:rows}));}
 entries.sort((a,b)=>a.startAt-b.startAt);const retained=new Set(queryMonths(entries,now,maxMonths).map(e=>e.id));for(const e of entries)e.available=retained.has(e.id)&&payloads.has(e.id);
 for(const e of entries){if(!e.available)continue;const old=previous?.months.find(p=>p.id===e.id);if(old?.revision===e.revision&&old.available)continue;const body=payloads.get(e.id);await store.write(e.key,body);const check=await store.read(e.key);if(!check.ok||await check.text()!==body)throw Error('Month verification failed');}
 const revision=digest(JSON.stringify(entries));const manifest={schemaVersion:2,timezone:'Asia/Shanghai',generatedAt:Math.floor(now),revision,months:entries};
 if(previous?.revision!==revision){await store.write('manifest.json',JSON.stringify(manifest));const check=await store.read('manifest.json');if(!check.ok||(await check.json()).revision!==revision)throw Error('Manifest verification failed');}
 // Publication commit point precedes cleanup. Never delete any audio.
 for(const old of previous?.months??[]){const entry=entries.find(e=>e.id===old.id);if(old.available&&(!entry?.available||entry.key!==old.key))await store.remove(old.key);}
 return previous?.revision===revision?previous:manifest;
}
