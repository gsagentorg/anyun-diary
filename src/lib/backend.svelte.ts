import { Capacitor } from '@capacitor/core';
import { env } from '$env/dynamic/public';
import type { Audio } from './types';
import { createMonthSupply } from './supply.js';
import { monthIdAt, subtractCalendarMonths } from './month.js';
import { nativeFetchJSON } from './native-cache';
import { bounded, catalogTimeouts, shouldRetireOperation } from './catalog-recovery';
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
// fetchIndex 用令牌所有权管理 pending：挂死的旧操作既不锁死新请求，其 finally 也不解锁/污染新操作。
interface IndexOperation{generation:number;controller:AbortController;startedAt:number}
let indexOperation:IndexOperation|null=null;
function retireIndexOperation(){const current=indexOperation;if(!current)return;indexOperation=null;backend.pending=false;requests.delete(current.controller);try{current.controller.abort();}catch{/* abort 只是尽力通知，所有权已摘除，旧链结果一律不写回 */}}
let supply=createSupply();
function createSupply(){return createMonthSupply({maxCachedMonths:MAX_CACHED_MONTHS,manifestUrl:'/api/catalog',monthUrl:(entry:{id:string},manifest:Manifest)=>'/api/month/'+encodeURIComponent(entry.id)+'?release='+encodeURIComponent(manifest.revision),fetch:catalogFetch});}
/** Catalog JSON goes through the native disk cache inside the App (offline warm start); web uses plain fetch.
 * 桥不响应 abort，所以给它有界超时：超时/中止按「缓存未命中」处理，降级为普通 fetch，绝不无限挂起。 */
async function catalogFetch(url:RequestInfo|URL,options?:RequestInit):Promise<Response>{
 const target=String(url),absolute=apiBase()+target;
 if(isNativeApp()&&(target.startsWith('/api/catalog')||target.startsWith('/api/month/'))){
  const cached=await bounded(()=>nativeFetchJSON(absolute),{timeoutMs:catalogTimeouts().nativeBridgeMs,signal:options?.signal}).catch(()=>null);
  if(cached&&cached.data!=null)return new Response(JSON.stringify(cached.data),{status:200,headers:{'content-type':'application/json','x-anyun-cache':cached.source??'cache'}});
 }
 return fetch(absolute,{...options,cache:target.startsWith('/api/month/')?'default':'no-store'});
}
export function isNativeApp(){return typeof window!=='undefined'&&Capacitor.isNativePlatform();}
export function apiBase(){return isNativeApp()?backend.base:'';}
export function requestController(){const c=new AbortController();requests.add(c);return c;}
export function releaseController(c:AbortController){requests.delete(c);}
export function resetCatalog(){currentEtag="";retireIndexOperation();supply.clear();for(const c of requests)c.abort();requests.clear();inflight.clear();backend.generation++;supply=createSupply();backend.manifest=null;backend.months={};backend.summaries={};monthRecency.clear();backend.errors={};backend.loading={};backend.error='';}
export function saveBackendBase(url:string){if(!isNativeApp())return;resetCatalog();backend.base=url.trim().replace(/\/+$/,'');backend.prompt=false;try{localStorage.setItem(KEY,backend.base);}catch{}void fetchIndex();}
export function dismissBackendPrompt(){backend.prompt=false;}
export function currentMonthId(now=Date.now()){return monthIdAt(now/1000);}
let currentEtag='';
/** 连接确认健康（200 提交或 304）后给失败月份重新来过的机会：只清 error 门控，
 * 重抓由页面既有 effect 经 loadMonth 驱动（逐月、inflight 去重、有界超时），不做全量历史批抓。 */
function rearmFailedMonthErrors(){for(const id of Object.keys(backend.errors)){if(!backend.summaries[id]&&!backend.loading[id])delete backend.errors[id];}}
export async function fetchIndex(options:{force?:boolean}={}):Promise<void>{
 if(isNativeApp()&&!backend.base)return;
 if(indexOperation){
  // force（顶栏「刷新数据」/「重试目录」）与超过操作期限的残留请求都先退休；普通周期刷新绝不打断健康在途请求。
  if(!options.force&&!shouldRetireOperation(indexOperation.startedAt))return;
  retireIndexOperation();
 }
 const token:IndexOperation={generation:backend.generation,controller:requestController(),startedAt:Date.now()};
 indexOperation=token;backend.pending=true;
 const limits=catalogTimeouts(),deadlineAt=token.startedAt+limits.operationMs;
 const stageMs=()=>Math.min(limits.requestMs,deadlineAt-Date.now());
 const owned=()=>indexOperation===token&&!token.controller.signal.aborted;
 try{
 const pointer=await bounded<{notModified:boolean;etag:string;body:unknown}>(async s=>{
  const resp=await fetch(apiBase()+'/api/current',{signal:s,cache:'no-store',headers:currentEtag?{'If-None-Match':currentEtag}:{}});
  if(resp.status===304)return {notModified:true,etag:'',body:undefined};
  if(!resp.ok)throw Error('目录版本检查失败');
  return {notModified:false,etag:resp.headers.get('etag')??'',body:await resp.json()};
 },{timeoutMs:stageMs(),signal:token.controller.signal});
 if(!owned())return;
 if(pointer.notModified){
  // 304=连接健康且版本未变：清掉旧的连接错误并放行失败月份重试，已加载月份原样保留。
  if(backend.manifest){backend.error='';rearmFailedMonthErrors();}
  return;
 }
 const p=pointer.body as {schemaVersion?:number;releaseId?:unknown};
 if(p.schemaVersion!==2||typeof p.releaseId!=='string'||!p.releaseId)throw Error('目录版本无效');
 const m=await bounded(s=>supply.manifest({signal:s,refresh:true,commit:false}) as Promise<Manifest>,{timeoutMs:stageMs(),signal:token.controller.signal});
 if(!owned())return;
 const nextMonths={...backend.months},nextSummaries={...backend.summaries};
 const needed=new Set([...Object.keys(backend.summaries),...Object.keys(backend.months),...pins.keys(),currentMonthId()]);
 for(const id of needed){
  if(!owned())return;
  const old=backend.manifest?.months.find(v=>v.id===id),entry=m.months.find(v=>v.id===id);
  if(!entry?.available){delete nextMonths[id];delete nextSummaries[id];continue;}
  if(old?.revision===entry.revision&&old.key===entry.key&&nextSummaries[id])continue;
  const block=await bounded(s=>supply.month(id,{signal:s,manifest:m}) as Promise<{audios:Audio[]}|null>,{timeoutMs:stageMs(),signal:token.controller.signal});
  if(!owned())return;
  if(!block)throw Error('月份不可用');
  nextMonths[id]=block.audios;nextSummaries[id]=block.audios.map((audio:Audio)=>({...audio,lyrics:[]}));
 }
 supply.commitManifest(m);backend.manifest=m;backend.months=nextMonths;backend.summaries=nextSummaries;backend.error='';currentEtag=pointer.etag;
 rearmFailedMonthErrors();
 for(const id of Object.keys(nextMonths))touchMonth(id);
 }catch(e){
  // 被退休/重置的旧操作不写错误、不污染新操作；失败一律保留已有 manifest 与月份。
  if(owned())backend.error=e instanceof Error?e.message:'目录更新失败，将保留已有内容';
 }finally{
  releaseController(token.controller);
  // pending 由令牌所有权释放：只有仍持有操作时才写回，resetCatalog 之后旧 finally 是空操作。
  if(indexOperation===token){indexOperation=null;backend.pending=false;}
 }
}
export async function loadMonth(id:string,signal?:AbortSignal):Promise<Audio[]>{
 if(signal?.aborted)throw new DOMException('Aborted','AbortError');
 if(backend.months[id]){touchMonth(id);return backend.months[id];}
 if(inflight.has(id)&&!signal)return inflight.get(id)!;
 const ref=backend.manifest?.months.find(m=>m.id===id);if(!ref?.available)throw Error('该月份超出可查询范围或尚未发布');
 const generation=backend.generation,c=requestController();const abort=()=>c.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)c.abort();backend.loading[id]=true;delete backend.errors[id];
 const task=(async()=>{try{const m=await bounded(s=>supply.month(id,{signal:s,manifest:backend.manifest}) as Promise<{audios:Audio[]}|null>,{timeoutMs:catalogTimeouts().requestMs,signal:c.signal});if(!m)throw Error('月份不可用');if(generation!==backend.generation||c.signal.aborted)throw new DOMException('Aborted','AbortError');if(backend.manifest?.months.find(v=>v.id===id)?.revision!==ref.revision)return m.audios as Audio[];backend.months[id]=m.audios;backend.summaries[id]=m.audios.map((a:Audio)=>({...a,lyrics:[]}));touchMonth(id);return m.audios as Audio[];}catch(e){if(!c.signal.aborted&&generation===backend.generation)backend.errors[id]=e instanceof Error?e.message:'月份加载失败';throw e;}finally{releaseController(c);signal?.removeEventListener('abort',abort);if(generation===backend.generation){backend.loading[id]=false;inflight.delete(id);}}})();inflight.set(id,task);return task;
}
export async function audiosInRange(from:number,to:number,signal?:AbortSignal,onProgress?:(progress:{completed:number;total:number})=>void):Promise<Audio[]>{if(!Number.isFinite(from)||!Number.isFinite(to)||from>=to)throw Error('日期范围无效');return supply.range({startAt:from,endAt:to,signal,onProgress}) as Promise<Audio[]>;}
export function loadRollingWindow(endAt:number,signal?:AbortSignal):Promise<Audio[]>{return audiosInRange(subtractCalendarMonths(endAt,1),endAt,signal);}
export function resolveAudio(id:string,monthId:string,signal?:AbortSignal):Promise<Audio|null>{return supply.resolve(id,monthId,{signal}) as Promise<Audio|null>;}
export function searchAudios(query:string,options:{signal?:AbortSignal;onMessage?:(message:any)=>void}={}){return supply.search(query,options);}
let recoveryTimer:ReturnType<typeof setTimeout>|null=null,recoveryForce=false;
/** 生命周期恢复入口：visibility/pageshow/online 与顶栏「刷新数据」都走这里。
 * force=立即退休当前请求；同一瞬间的多次事件合并为一次检查。页面隐藏时绝不发请求，
 * 不后台循环重试、不打断播放、绝不自动 reload。 */
export function recoverCatalog(options:{force?:boolean}={}):void{
 if(typeof window==='undefined')return;
 if(typeof document!=='undefined'&&document.visibilityState==='hidden')return;
 if(options.force)retireIndexOperation();
 if(recoveryTimer!==null){if(options.force)recoveryForce=true;return;}
 recoveryForce=!!options.force;
 recoveryTimer=setTimeout(()=>{recoveryTimer=null;const force=recoveryForce;recoveryForce=false;if(typeof document!=='undefined'&&document.visibilityState==='hidden')return;void fetchIndex({force});},catalogTimeouts().coalesceMs);
}
let refreshListeners=false;
export function initBackend(){if(typeof window==='undefined')return;if(isNativeApp()){try{backend.base=localStorage.getItem(KEY)||backend.base;}catch{}if(!backend.base)backend.prompt=true;}void fetchIndex();if(!refreshListeners){refreshListeners=true;window.addEventListener('online',()=>recoverCatalog());}}
