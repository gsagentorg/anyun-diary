import {searchAudiosAsync,checkSearchBudget,type SearchBudget,type SearchHit} from '../search';
import {readMonth,type Store,type MonthEntry} from './catalog';
/** Shared across HTTP requests; queued work never occupies an active slot. */
export function createSearchLimiter(limit=2){
 let active=0;const queue:Array<()=>void>=[];
 return async function acquire(budget:SearchBudget):Promise<()=>void>{
 checkSearchBudget(budget);
 if(active>=limit)await new Promise<void>((resolve,reject)=>{
 const remove=()=>{const i=queue.indexOf(wake);if(i>=0)queue.splice(i,1);};
 const aborted=()=>{remove();reject(budget.signal?.reason??new DOMException('Aborted','AbortError'));};
 const wake=()=>{budget.signal?.removeEventListener('abort',aborted);try{checkSearchBudget(budget);active++;resolve();}catch(e){reject(e);queue.shift()?.();}};
 queue.push(wake);budget.signal?.addEventListener('abort',aborted,{once:true});if(budget.signal?.aborted)aborted();
 });else active++;
 let released=false;return ()=>{if(released)return;released=true;active--;queue.shift()?.();};
 };
}
const acquireGlobal=createSearchLimiter();
export function searchStream(store:Store,months:MonthEntry[],q:string,{signal,timeoutMs=15000,concurrency=2}:{signal?:AbortSignal;timeoutMs?:number;concurrency?:number}={}){
 const abort=new AbortController();const stop=()=>abort.abort(signal?.reason);signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
 const now=()=>performance.now(),deadline=now()+timeoutMs;const budget={signal:abort.signal,deadline,now};
 const check=()=>{try{checkSearchBudget(budget);}catch(e){if(e instanceof DOMException&&e.name==='TimeoutError'){timedOut=true;abort.abort(e);}throw e;}};
 let completed=0,index=0,timedOut=false,closed=false,initial=true,progress=false;
 type Result={index:number;hits:SearchHit[]};
 const pending=new Map<number,Promise<Result>>();const ready:Result[]=[];
 const timer=setTimeout(()=>{timedOut=true;abort.abort();},timeoutMs);
 const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);abort.abort();closed=true;};
 const encoder=new TextEncoder();const encode=(v:unknown)=>encoder.encode(JSON.stringify(v)+'\n');
 const fill=()=>{check();while(!abort.signal.aborted&&pending.size<Math.max(1,Math.min(16,concurrency))&&index<months.length){check();const n=index++;
 const task=(async()=>{const release=await acquireGlobal(budget);try{check();const m=await readMonth(store,months[n],abort.signal);check();const hits=await searchAudiosAsync(m.audios,q,budget);check();const r={index:n,hits};ready.push(r);return r;}finally{release();}})();
 task.catch(e=>{if(e instanceof DOMException&&e.name==='TimeoutError'){timedOut=true;abort.abort(e);}});pending.set(n,task);}};
 const aborted=new Promise<null>(resolve=>{if(abort.signal.aborted)resolve(null);else abort.signal.addEventListener('abort',()=>resolve(null),{once:true});});
 return new ReadableStream<Uint8Array>({async pull(controller){if(closed)return;try{
 if(initial){initial=false;controller.enqueue(encode({type:'progress',completed,total:months.length}));return;}
 if(progress){progress=false;controller.enqueue(encode({type:'progress',completed,total:months.length}));return;}
 if(!abort.signal.aborted)fill();if(!ready.length&&pending.size&&!abort.signal.aborted)await Promise.race([...pending.values(),aborted]);
 if(closed)return;
 if(ready.length){const r=ready.shift()!;pending.delete(r.index);completed++;progress=true;controller.enqueue(encode({type:'results',hits:r.hits}));return;}
 controller.enqueue(encode({type:'done',completed,total:months.length,timedOut}));cleanup();controller.close();
 }catch(e){if(closed)return;if(abort.signal.aborted){controller.enqueue(encode({type:'done',completed,total:months.length,timedOut}));cleanup();controller.close();}else{cleanup();controller.error(e);}}},cancel(){cleanup();}},{highWaterMark:1});
}
