import type { Audio } from './types';
export type SearchToken={kind:'bare';v:string}|{kind:'field';field:string;v:string};
export type SearchHit={audio:Audio;line:string|null};
export function parseQuery(q:string):SearchToken[]{return q.trim().split(/\s+/).filter(Boolean).map(t=>{const m=/^([A-Za-z_]+):(.+)$/.exec(t);return m?{kind:'field',field:m[1].toLowerCase(),v:m[2]}:{kind:'bare',v:t.toLowerCase()};});}
export function audioClock(audio:Audio){const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(audio.startAt*1000));const get=(t:string)=>parts.find(p=>p.type===t)?.value??'';return {hm:get('hour')+':'+get('minute'),date:get('year')+'-'+get('month')+'-'+get('day')};}
function minute(v:string){const m=/^(\d{1,2}):(\d{2})$/.exec(v);return m&&+m[1]<24&&+m[2]<60?+m[1]*60 + +m[2]:null;}
function matchTime(v:string,hm:string){const cur=minute(hm);const r=/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(v);if(r){const a=minute(r[1]),b=minute(r[2]);return cur!==null&&a!==null&&b!==null&&cur>=a&&cur<=b;}return minute(v)!==null&&minute(v)===cur;}
function matchDate(v:string,date:string){v=v.replace(/\//g,'-');return /^\d{4}-\d{2}-\d{2}$/.test(v)?v===date:/^\d{2}-\d{2}$/.test(v)&&date.endsWith('-'+v);}
/** One shared iterator keeps sync/client and cooperative/server matching identical. */
function* scanAudios(audios:Audio[],query:string):Generator<SearchHit|null>{
 const tokens=parseQuery(query);if(!tokens.length)return;
 for(const audio of audios){yield null;const {hm,date}=audioClock(audio);const dateText=date+' '+date.slice(5).replace('-','/');let line:string|null=null,matched=true;
 for(const tok of tokens){yield null;const v=tok.v.toLowerCase();let lyric:Audio['lyrics'][number]|undefined;
 // Preserve first matching lyric and AND token order, including the returned line.
 if(tok.kind==='bare'||tok.field==='lyrics')for(const l of audio.lyrics??[]){yield null;if(l.text.toLowerCase().includes(v)){lyric=l;break;}}
 let ok=false;
 if(tok.kind==='bare'){const title=audio.title.toLowerCase().includes(v);if(lyric&&!title)line??=lyric.text;ok=title||!!lyric||dateText.includes(v);}
 else if(tok.field==='title')ok=audio.title.toLowerCase().includes(v);
 else if(tok.field==='lyrics'){if(lyric)line=lyric.text;ok=!!lyric;}
 else if(tok.field==='date')ok=matchDate(v,date);
 else if(tok.field==='time')ok=matchTime(v,hm);
 if(!ok){matched=false;break;}}
 if(matched)yield {audio,line};}
}
export function searchAudios(audios:Audio[],query:string):SearchHit[]{
 const hits:SearchHit[]=[];for(const hit of scanAudios(audios,query))if(hit)hits.push(hit);return hits;
}
export type SearchBudget={signal?:AbortSignal;deadline?:number;now?:()=>number;batchSize?:number;yieldTask?:()=>Promise<void>};
export function checkSearchBudget({signal,deadline=Infinity,now=()=>performance.now()}:SearchBudget){
 signal?.throwIfAborted();if(now()>=deadline)throw new DOMException('Search deadline exceeded','TimeoutError');
}
/** Yield a macrotask, not a microtask: timers and disconnects must get a turn. */
export async function searchAudiosAsync(audios:Audio[],query:string,budget:SearchBudget={}):Promise<SearchHit[]>{
 const hits:SearchHit[]=[];let steps=0;const batch=Math.max(1,Math.floor(budget.batchSize??128));
 const yieldTask=budget.yieldTask??(()=>new Promise<void>(resolve=>setTimeout(resolve,0)));
 checkSearchBudget(budget);
 const scan=scanAudios(audios,query);
 while(true){checkSearchBudget(budget);const next=scan.next();checkSearchBudget(budget);if(next.done)break;if(next.value)hits.push(next.value);
 if(++steps>=batch){steps=0;await yieldTask();checkSearchBudget(budget);}}
 return hits;
}
