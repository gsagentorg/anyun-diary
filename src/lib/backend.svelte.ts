import { Capacitor } from '@capacitor/core';
import { env } from '$env/dynamic/public';
import type { Audio } from './types';
import { createMonthSupply } from './supply.js';
import { monthIdAt, subtractCalendarMonths } from './month.js';
export interface MonthRef { id:string; startAt:number; endAt:number; count:number; revision:string; key:string; available:boolean }
export interface Manifest { schemaVersion:2; timezone:string; generatedAt:number; revision:string; months:MonthRef[] }
const KEY='anyun-backend-v1';
export const backend=$state({base:(env?.PUBLIC_AUDIO_BASE??'').replace(/\/+$/,''),prompt:false,manifest:null as Manifest|null,months:{} as Record<string,Audio[]>,errors:{} as Record<string,string>,loading:{} as Record<string,boolean>,error:'',pending:false,generation:0});
export const MAX_CACHED_MONTHS=3;
const monthRecency=new Map<string,true>();
function touchMonth(id:string){monthRecency.delete(id);monthRecency.set(id,true);while(monthRecency.size>MAX_CACHED_MONTHS){const oldest=monthRecency.keys().next().value!;monthRecency.delete(oldest);delete backend.months[oldest];delete backend.errors[oldest];delete backend.loading[oldest];}}
export function inspectMonthCache(){return {cachedMonths:Object.keys(backend.months).length,maxCachedMonths:MAX_CACHED_MONTHS,ids:[...monthRecency.keys()],supply:supply.inspect()};}
const requests=new Set<AbortController>();
const inflight=new Map<string,Promise<Audio[]>>();
let supply=createSupply();
function createSupply(){return createMonthSupply({maxCachedMonths:MAX_CACHED_MONTHS,manifestUrl:'/api/catalog',monthUrl:(entry:{id:string})=>'/api/month/'+encodeURIComponent(entry.id),fetch:(url:RequestInfo|URL,options?:RequestInit)=>fetch(apiBase()+url,{...options,cache:'no-store'})});}
export function isNativeApp(){return typeof window!=='undefined'&&Capacitor.isNativePlatform();}
export function apiBase(){return isNativeApp()?backend.base:'';}
export function requestController(){const c=new AbortController();requests.add(c);return c;}
export function releaseController(c:AbortController){requests.delete(c);}
export function resetCatalog(){supply.clear();for(const c of requests)c.abort();requests.clear();inflight.clear();backend.generation++;supply=createSupply();backend.manifest=null;backend.months={};monthRecency.clear();backend.errors={};backend.loading={};backend.error='';}
export function saveBackendBase(url:string){if(!isNativeApp())return;resetCatalog();backend.base=url.trim().replace(/\/+$/,'');backend.prompt=false;try{localStorage.setItem(KEY,backend.base);}catch{}void fetchIndex();}
export function dismissBackendPrompt(){backend.prompt=false;}
export function currentMonthId(now=Date.now()){return monthIdAt(now/1000);}
export async function fetchIndex(){if(isNativeApp()&&!backend.base)return;const generation=backend.generation,c=requestController();backend.pending=true;try{const m=await supply.manifest({signal:c.signal,refresh:true});if(generation!==backend.generation)return;for(const id of Object.keys(backend.months)){const old=backend.manifest?.months.find(v=>v.id===id),entry=m.months.find((v:MonthRef)=>v.id===id);if(!entry?.available||old?.revision!==entry.revision||old?.key!==entry.key)delete backend.months[id];}backend.manifest=m;backend.error='';const current=m.months.find((v:MonthRef)=>v.id===currentMonthId());if(current?.available)await loadMonth(current.id);}catch(e){if(!c.signal.aborted&&generation===backend.generation)backend.error=e instanceof Error?e.message:'目录加载失败';}finally{releaseController(c);if(generation===backend.generation)backend.pending=false;}}
export async function loadMonth(id:string,signal?:AbortSignal):Promise<Audio[]>{
 if(signal?.aborted)throw new DOMException('Aborted','AbortError');
 if(backend.months[id]){touchMonth(id);return backend.months[id];}
 if(inflight.has(id)&&!signal)return inflight.get(id)!;
 const ref=backend.manifest?.months.find(m=>m.id===id);if(!ref?.available)throw Error('该月份超出可查询范围或尚未发布');
 const generation=backend.generation,c=requestController();const abort=()=>c.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)c.abort();backend.loading[id]=true;delete backend.errors[id];
 const task=(async()=>{try{const m=await supply.month(id,{signal:c.signal});if(!m)throw Error('月份不可用');if(generation!==backend.generation||c.signal.aborted)throw new DOMException('Aborted','AbortError');backend.months[id]=m.audios;touchMonth(id);return m.audios as Audio[];}catch(e){if(!c.signal.aborted&&generation===backend.generation)backend.errors[id]=e instanceof Error?e.message:'月份加载失败';throw e;}finally{releaseController(c);signal?.removeEventListener('abort',abort);if(generation===backend.generation){backend.loading[id]=false;inflight.delete(id);}}})();inflight.set(id,task);return task;
}
export async function audiosInRange(from:number,to:number,signal?:AbortSignal):Promise<Audio[]>{if(!Number.isFinite(from)||!Number.isFinite(to)||from>=to)throw Error('日期范围无效');return supply.range({startAt:from,endAt:to,signal}) as Promise<Audio[]>;}
export function loadRollingWindow(endAt:number,signal?:AbortSignal):Promise<Audio[]>{return audiosInRange(subtractCalendarMonths(endAt,1),endAt,signal);}
export function resolveAudio(id:string,monthId:string,signal?:AbortSignal):Promise<Audio|null>{return supply.resolve(id,monthId,{signal}) as Promise<Audio|null>;}
export function searchAudios(query:string,options:{signal?:AbortSignal;onMessage?:(message:any)=>void}={}){return supply.search(query,options);}
export function initBackend(){if(typeof window==='undefined')return;if(isNativeApp()){try{backend.base=localStorage.getItem(KEY)||backend.base;}catch{}if(!backend.base)backend.prompt=true;}void fetchIndex();}
