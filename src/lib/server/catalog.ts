import {createHash} from 'node:crypto';
import type {Audio} from '../types';
import {monthBounds} from './months.mjs';
import {validateAudio,validatePointer} from '../catalog-schema.js';
export type MonthEntry={id:string;startAt:number;endAt:number;count:number;revision:string;key:string;available:boolean};
export type Manifest={schemaVersion:2;timezone:'Asia/Shanghai';generatedAt:number;revision:string;months:MonthEntry[]};
export type Month={schemaVersion:2;id:string;revision:string;audios:Audio[]};
export type Store={read:(key:string,options?:{signal?:AbortSignal})=>Promise<Response>};
export async function readCatalog(store:Store,signal?:AbortSignal,releaseId?:string):Promise<Manifest>{
 let key="manifest.json";
 if(releaseId){key=validatePointer({schemaVersion:2,releaseId,key:"releases/"+releaseId+"/manifest.json"}).key;}else{const current=await store.read("current.json",{signal});if(current.ok){const p=validatePointer(await current.json());key=p.key;releaseId=p.releaseId;}else if(current.status!==404)throw Error("Current unavailable");}
 let r=await store.read(key,{signal});if(releaseId&&r.status===404){const current=await store.read('current.json',{signal});if(current.status===404){const legacy=await store.read('manifest.json',{signal});if(legacy.ok){const candidate=await legacy.json();if(candidate.revision===releaseId){r=new Response(JSON.stringify(candidate));releaseId=undefined;}}}}if(!r.ok)throw Error('Manifest unavailable');const m=await r.json();
 if(m.schemaVersion!==2||m.timezone!=='Asia/Shanghai'||!Array.isArray(m.months)||typeof m.revision!=='string'||!Number.isFinite(m.generatedAt))throw Error('Invalid manifest');
 if(releaseId&&(m.revision!==releaseId||createHash("sha256").update(JSON.stringify(m.months)).digest("hex")!==releaseId))throw Error("Release mismatch");
 const ids=new Set();for(const e of m.months){const b=monthBounds(e.id);if(ids.has(e.id)||e.startAt!==b.startAt||e.endAt!==b.endAt||!Number.isInteger(e.count)||e.count<0||typeof e.available!=='boolean'||e.key!=='months/'+e.id+'/'+e.revision+'.json'||! /^[a-f0-9]{64}$/.test(e.revision))throw Error('Invalid entry');ids.add(e.id);}return m;
}
export async function readMonth(store:Store,entry:MonthEntry,signal?:AbortSignal):Promise<Month>{
 if(!entry.available)throw Error('Month unavailable');const r=await store.read(entry.key,{signal});if(!r.ok)throw Error('Month unavailable');const m=await r.json();
 if(m.schemaVersion!==2||m.id!==entry.id||m.revision!==entry.revision||!Array.isArray(m.audios)||m.audios.length!==entry.count||createHash('sha256').update(JSON.stringify(m.audios)).digest('hex')!==entry.revision)throw Error('Invalid month');
 const ids=new Set();for(const a of m.audios){validateAudio(a);if(a.monthId!==entry.id||typeof a.id!=='string'||ids.has(a.id)||typeof a.file!=='string'||typeof a.opus!=='string'||typeof a.title!=='string'||!Number.isFinite(a.startAt)||a.startAt<entry.startAt||a.startAt>=entry.endAt||!Number.isFinite(a.duration)||a.duration<=0)throw Error('Invalid audio');ids.add(a.id);}return m;
}
