import { Capacitor } from '@capacitor/core';
import { env } from '$env/dynamic/public';
import type { Audio } from './types';
import { createMonthSupply } from './supply.js';
import { monthIdAt, subtractCalendarMonths } from './month.js';
export interface MonthRef { id:string; startAt:number; endAt:number; count:number; revision:string; key:string; available:boolean }
export interface Manifest { queryMonthLimit?:number; schemaVersion:2; timezone:string; generatedAt:number; revision:string; months:MonthRef[] }
const KEY='anyun-backend-v1';
export const backend=$state({base:(env?.PUBLIC_AUDIO_BASE??'').replace(/\/+$/,''),prompt:false,manifest:null as Manifest|null,months:{} as Record<string,Audio[]>,summaries:{} as Record<string,Audio[]>,errors:{} as Record<string,string>,loading:{} as Record<string,boolean>,error:'',pending:false,generation:0});
export const MAX_CACHED_MONTHS=3;
const monthRecency=new Map<string,true>();
const pins=new Map<string,number>();
function trimMonths(){for(const id of monthRecency.keys()){if(monthRecency.size<=Math.max(MAX_CACHED_MONTHS,pins.size))break;if(pins.has(id))continue;monthRecency.delete(id);delete backend.months[id];delete backend.errors[id];delete backend.loading[id];}}
export function pinMonth(id:string){pins.set(id,(pins.get(id)??0)+1);let released=false;return()=>{if(released)return;released=true;const n=(pins.get(id)??1)-1;if(n)pins.set(id,n);else pins.delete(id);trimMonths();};}
function touchMonth(id:string){monthRecency.delete(id);monthRecency.set(id,true);trimMonths();}
export function inspectMonthCache(){return {cachedMonths:Object.keys(backend.months).length,maxCachedMonths:MAX_CACHED_MONTHS,ids:[...monthRecency.keys()],supply:supply.inspect()};}
const requests=new Set<AbortController>();
const inflight=new Map<string,Promise<Audio[]>>();
let supply=createSupply();
function createSupply(){return createMonthSupply({maxCachedMonths:MAX_CACHED_MONTHS,manifestUrl:'/api/catalog',monthUrl:(entry:{id:string},manifest:Manifest)=>'/api/month/'+encodeURIComponent(entry.id)+'?release='+encodeURIComponent(manifest.revision),fetch:(url:RequestInfo|URL,options?:RequestInit)=>fetch(apiBase()+url,{...options,cache:String(url).startsWith('/api/month/')?'default':'no-store'})});}
export function isNativeApp(){return typeof window!=='undefined'&&Capacitor.isNativePlatform();}
export function apiBase(){return isNativeApp()?backend.base:'';}
export function requestController(){const c=new AbortController();requests.add(c);return c;}
export function releaseController(c:AbortController){requests.delete(c);}
export function resetCatalog(){currentEtag="";supply.clear();for(const c of requests)c.abort();requests.clear();inflight.clear();backend.generation++;supply=createSupply();backend.manifest=null;backend.months={};backend.summaries={};monthRecency.clear();backend.errors={};backend.loading={};backend.error='';}
export function saveBackendBase(url:string){if(!isNativeApp())return;resetCatalog();backend.base=url.trim().replace(/\/+$/,'');backend.prompt=false;try{localStorage.setItem(KEY,backend.base);}catch{}void fetchIndex();}
export function dismissBackendPrompt(){backend.prompt=false;}
export function currentMonthId(now=Date.now()){return monthIdAt(now/1000);}
let currentEtag='';
export async function fetchIndex(){
 if((isNativeApp()&&!backend.base)||backend.pending)return;
 const generation=backend.generation,c=requestController();backend.pending=true;
 try{
 const pointer=await fetch(apiBase()+'/api/current',{signal:c.signal,cache:'no-store',headers:currentEtag?{'If-None-Match':currentEtag}:{}});
 if(pointer.status===304&&backend.manifest)return;
 if(!pointer.ok)throw Error('目录版本检查失败');const p=await pointer.json();if(p.schemaVersion!==2||typeof p.releaseId!=='string'||!p.releaseId)throw Error('目录版本无效');
 const m:Manifest=await supply.manifest({signal:c.signal,refresh:true,commit:false});
 const nextMonths={...backend.months},nextSummaries={...backend.summaries};
 const needed=new Set([...Object.keys(backend.summaries),...Object.keys(backend.months),...pins.keys(),currentMonthId()]);
 for(const id of needed){const old=backend.manifest?.months.find(v=>v.id===id),entry=m.months.find(v=>v.id===id);if(!entry?.available){delete nextMonths[id];delete nextSummaries[id];continue;}if(old?.revision===entry.revision&&old.key===entry.key&&nextSummaries[id])continue;const block=await supply.month(id,{signal:c.signal,manifest:m});if(!block)throw Error('月份不可用');nextMonths[id]=block.audios;nextSummaries[id]=block.audios.map((audio:Audio)=>({...audio,lyrics:[]}));}
 if(generation!==backend.generation||c.signal.aborted)return;
 supply.commitManifest(m);backend.manifest=m;backend.months=nextMonths;backend.summaries=nextSummaries;backend.error='';currentEtag=pointer.headers.get('etag')??'';
 for(const id of Object.keys(nextMonths))touchMonth(id);
 }catch(e){if(!c.signal.aborted&&generation===backend.generation)backend.error=e instanceof Error?e.message:'目录更新失败，将保留已有内容';}
 finally{releaseController(c);if(generation===backend.generation)backend.pending=false;}
}
export async function loadMonth(id:string,signal?:AbortSignal):Promise<Audio[]>{
 if(signal?.aborted)throw new DOMException('Aborted','AbortError');
 if(backend.months[id]){touchMonth(id);return backend.months[id];}
 if(inflight.has(id)&&!signal)return inflight.get(id)!;
 const ref=backend.manifest?.months.find(m=>m.id===id);if(!ref?.available)throw Error('该月份超出可查询范围或尚未发布');
 const generation=backend.generation,c=requestController();const abort=()=>c.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)c.abort();backend.loading[id]=true;delete backend.errors[id];
 const task=(async()=>{try{const m=await supply.month(id,{signal:c.signal,manifest:backend.manifest});if(!m)throw Error('月份不可用');if(generation!==backend.generation||c.signal.aborted)throw new DOMException('Aborted','AbortError');if(backend.manifest?.months.find(v=>v.id===id)?.revision!==ref.revision)return m.audios as Audio[];backend.months[id]=m.audios;backend.summaries[id]=m.audios.map((a:Audio)=>({...a,lyrics:[]}));touchMonth(id);return m.audios as Audio[];}catch(e){if(!c.signal.aborted&&generation===backend.generation)backend.errors[id]=e instanceof Error?e.message:'月份加载失败';throw e;}finally{releaseController(c);signal?.removeEventListener('abort',abort);if(generation===backend.generation){backend.loading[id]=false;inflight.delete(id);}}})();inflight.set(id,task);return task;
}
export async function audiosInRange(from:number,to:number,signal?:AbortSignal,onProgress?:(progress:{completed:number;total:number})=>void):Promise<Audio[]>{if(!Number.isFinite(from)||!Number.isFinite(to)||from>=to)throw Error('日期范围无效');return supply.range({startAt:from,endAt:to,signal,onProgress}) as Promise<Audio[]>;}
export function loadRollingWindow(endAt:number,signal?:AbortSignal):Promise<Audio[]>{return audiosInRange(subtractCalendarMonths(endAt,1),endAt,signal);}
export function resolveAudio(id:string,monthId:string,signal?:AbortSignal):Promise<Audio|null>{return supply.resolve(id,monthId,{signal}) as Promise<Audio|null>;}
export function searchAudios(query:string,options:{signal?:AbortSignal;onMessage?:(message:any)=>void}={}){return supply.search(query,options);}
let refreshListeners=false;
export function initBackend(){if(typeof window==='undefined')return;if(isNativeApp()){try{backend.base=localStorage.getItem(KEY)||backend.base;}catch{}if(!backend.base)backend.prompt=true;}void fetchIndex();if(!refreshListeners){refreshListeners=true;window.addEventListener('online',()=>void fetchIndex());}}
