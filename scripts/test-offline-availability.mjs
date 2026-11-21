/** Synthetic-only behavior + SSR row assertions. Run with vite-node. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const resolveModule = createRequire(import.meta.url).resolve;
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { createOfflineAvailability, offlineRowHint, webMediaStatus, isCompleteWebCacheResponse, resolveBrowseAudios } from '../src/lib/offline-availability.ts';
import { nativeMediaStatus, clearNativeCache, subscribeNativeCacheChanges, setNativeCachePolicy } from '../src/lib/native-cache.ts';
import { createLatestOperation } from '../src/lib/interactions.js';
import { __resetWebAudioCacheStateForTest, invalidateCachedAudio } from '../src/lib/web-audio-cache.ts';
Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}}});
let checks = 0;
const eq = (a,b,m) => { assert.deepEqual(a,b,m); checks++; };
const ok = (v,m) => { assert.ok(v,m); checks++; };
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise,resolve}; };
const waitFor = async fn => { for (let i=0;i<100;i++) { if(fn()) return; await turn(); } throw Error('condition did not settle'); };

const urls = Array.from({length:205},(_,i)=>'https://fixture.invalid/api/audio/'+i+'.opus');
const batches = [];
const native = await nativeMediaStatus([...urls,urls[0]], {mediaStatus:async ({urls}) => {
  batches.push(urls); return {statuses:urls.map((url,i)=>({url,cached:i%2===0}))};
}});
eq(batches.map(b=>b.length),[100,100,5],'native batch limit and dedup');
eq(batches.flat(),urls,'native receives exact stable URLs');
eq(native[urls[0]],'cached','complete native entry');
eq(native[urls[1]],'missing','native miss');
eq(await nativeMediaStatus([urls[0]],null),{[urls[0]]:'unknown'},'no plugin unknown');
eq(await nativeMediaStatus([urls[0]],{}),{[urls[0]]:'unknown'},'old shell unknown');
eq(await nativeMediaStatus([urls[0]],{mediaStatus:async()=>{throw Error('UNIMPLEMENTED');}}),{[urls[0]]:'unknown'},'rejected method unknown');
const malformed = await nativeMediaStatus(urls.slice(0,4), {mediaStatus:async()=>({statuses:[{url:urls[0],cached:true},{url:urls[0],cached:false},{url:urls[1],cached:'false'},{url:'other',cached:true},{url:urls[2],cached:false}]})});
eq(Object.values(malformed),['unknown','unknown','missing','unknown'],'bad duplicate/omitted rows never misses');
let notices=0; const stopNotice=subscribeNativeCacheChanges(()=>notices++);
const settings={clear:async()=>({entries:1,freedBytes:1}),setPolicy:async({policy})=>({policy})};
await clearNativeCache('json',settings); eq(notices,0,'JSON clear does not invalidate media');
await clearNativeCache('media',settings); eq(notices,1,'media clear invalidates');
await setNativeCachePolicy({},settings); eq(notices,2,'policy invalidates'); stopNotice();

let online=true, network, cacheChanged, snapshot, calls=[], releaseListeners=0;
const store=createOfflineAvailability({online:()=>online,query:async batch=>{calls.push(batch); return Object.fromEntries(batch.map((u,i)=>[u,i?'missing':'cached']));},listenNetwork:fn=>{network=fn;return()=>releaseListeners++;},listenCache:fn=>{cacheChanged=fn;return()=>releaseListeners++;}});
store.setTargets([...urls,urls[0]],'backend-a');
const stop=store.subscribe(s=>snapshot=s); await turn(); eq(calls.length,0,'online performs no cache IO');
online=false; network(); await waitFor(()=>Object.keys(snapshot.statuses).length===205);
eq(calls.map(b=>b.length),[100,100,5],'controller batches serially');
eq(snapshot.statuses[urls[0]],'cached','offline known cached');
eq(offlineRowHint(snapshot,urls[0]),'','cached rows no hint');
ok(offlineRowHint(snapshot,urls[1]).includes('未完整缓存'),'miss is explicit');
ok(offlineRowHint(snapshot,'not queried').includes('未知'),'unknown is separate');
store.setTargets([...urls,urls[0]],'backend-a'); await turn(); eq(calls.length,3,'same context/list has no IO');
cacheChanged(); eq(snapshot.statuses,{},'cache event immediately retires old verdicts'); await waitFor(()=>calls.length===6);
store.setTargets([urls[0]],'backend-b'); eq(snapshot.statuses,{},'backend generation invalidates'); await waitFor(()=>calls.length===7);
online=true; network(); eq(snapshot.statuses,{},'online removes all decorations');
eq(offlineRowHint(snapshot,urls[1]),'','online hint suppressed'); stop(); eq(releaseListeners,2,'subscriptions cleaned');

// Late old list/backend replies cannot overwrite new targets; only one IO slot.
let staleSnapshot, change, ownedCalls=[]; const old=deferred();
const ownedStore=createOfflineAvailability({online:()=>false,listenCache:fn=>{change=fn;return()=>{};},query:async batch=>{ownedCalls.push(batch);return ownedCalls.length===1?old.promise:{[batch[0]]:'missing'};}});
ownedStore.setTargets(['old'],'a'); const stopOwned=ownedStore.subscribe(s=>staleSnapshot=s); await turn();
ownedStore.setTargets(['new'],'b'); change(); await turn(); eq(ownedCalls.length,1,'replacement cannot fan out IO');
old.resolve({old:'cached'}); await waitFor(()=>staleSnapshot.statuses.new==='missing');
eq(staleSnapshot.statuses,{new:'missing'},'old reply discarded, latest generation committed'); stopOwned();

// Hung queries: unknown UI, no retry/fan-out; late timeout result discarded.
let timeoutSnapshot, invalidate, hungCalls=0; const hung=deferred();
const timeoutStore=createOfflineAvailability({online:()=>false,timeoutMs:5,listenCache:fn=>{invalidate=fn;return()=>{};},query:async()=>{hungCalls++;return hung.promise;}});
timeoutStore.setTargets(['hung']); const stopTimeout=timeoutStore.subscribe(s=>timeoutSnapshot=s);
await new Promise(r=>setTimeout(r,12)); eq(timeoutSnapshot.statuses,{},'timeout never becomes missing');
invalidate(); invalidate(); await turn(); eq(hungCalls,1,'timed out bridge still owns the slot');
stopTimeout(); hung.resolve({hung:'cached'}); await turn(); eq(hungCalls,1,'unmount retires pending work');

let failureSnapshot; const failureStore=createOfflineAvailability({online:()=>false,query:async()=>{throw Error('fixture IO');}});
failureStore.setTargets(['failed']); const stopFailure=failureStore.subscribe(s=>failureSnapshot=s);
await waitFor(()=>failureSnapshot.statuses.failed==='unknown'); stopFailure();

// Snapshot playback fallback must not swallow Abort or cross-backend results.
const retained=[{id:'one',monthId:'fixture-month',opus:'stable-one'},{id:'two',monthId:'fixture-month',opus:'stable-two'}];
let monthReads=0;
eq(await resolveBrowseAudios(retained,async()=>{monthReads++;throw Error('network offline');},{isCurrent:()=>true}),retained,'month failure preserves retained playable metadata');
eq(monthReads,1,'day replacement loads same month once');
eq(await resolveBrowseAudios(retained,async()=>[{...retained[0],lyrics:['full']}],{isCurrent:()=>true}),[{...retained[0],lyrics:['full']},retained[1]],'full metadata preferred; absent ID retains snapshot');
await assert.rejects(resolveBrowseAudios(retained,async()=>{throw new DOMException('stop','AbortError');},{isCurrent:()=>true}),{name:'AbortError'}); checks++;
const cancelled=new AbortController();cancelled.abort();let cancelledReads=0;
await assert.rejects(resolveBrowseAudios(retained,async()=>{cancelledReads++;return [];},{signal:cancelled.signal,isCurrent:()=>true}),{name:'AbortError'}); checks++;
eq(cancelledReads,0,'already aborted request never loads/falls back');
for(const reject of [false,true]) {
 let current=true;const delayed=deferred();
 const result=resolveBrowseAudios(retained,()=>delayed.promise,{isCurrent:()=>current});
 await turn();current=false;
 if(reject)delayed.resolve(Promise.reject(Error('late network failure')));else delayed.resolve(retained);
 await assert.rejects(result,{name:'AbortError'});checks++;
}
const playbackOp=createLatestOperation(), commits=[]; const older=deferred();
const first=playbackOp.run(signal=>resolveBrowseAudios([retained[0]],()=>older.promise,{signal,isCurrent:()=>true}),full=>commits.push(full[0].id)).catch(e=>{if(e.name!=='AbortError')throw e;});
await turn();
await playbackOp.run(signal=>resolveBrowseAudios([retained[1]],async()=>{throw Error('offline');},{signal,isCurrent:()=>true}),full=>commits.push(full[0].id));
older.resolve(retained);await first;eq(commits,['two'],'latest playback intent wins even when old month resolves late');

// Native-style polling is lifecycle-bounded and remains idle online/without rows.
let pollOnline=true, pollCalls=0, pollSnapshot;
const pollStore=createOfflineAvailability({online:()=>pollOnline,pollMs:5,query:async batch=>{pollCalls++;return {[batch[0]]:'cached'};}});
pollStore.setTargets(['poll']); const stopPoll=pollStore.subscribe(s=>pollSnapshot=s);
await new Promise(r=>setTimeout(r,12)); eq(pollCalls,0,'native polling does no IO online');
// Network ownership must be notified by a real network event; changing the list
// simulates the same invalidation for this injected environment.
pollOnline=false; pollStore.setTargets(['poll'],'offline'); await waitFor(()=>pollCalls>=2);
eq(pollSnapshot.statuses.poll,'cached','native polling refreshes rows');
pollStore.setTargets([]); const beforeEmpty=pollCalls; await new Promise(r=>setTimeout(r,12));
eq(pollCalls,beforeEmpty,'hidden/empty list does not poll IO'); stopPoll();
await new Promise(r=>setTimeout(r,12)); eq(pollCalls,beforeEmpty,'poll interval disposed');

// Existing web cache API, actual synthetic CacheStorage, and denied storage.
globalThis.location={href:'https://fixture.invalid/'};
const key='https://fixture.invalid/api/audio/'+'a'.repeat(64)+'.opus';
const miss='https://fixture.invalid/api/audio/'+'b'.repeat(64)+'.opus';
let body=new Response('SYNTHETIC',{headers:{'content-type':'audio/ogg','x-anyun-bytes':'9','x-anyun-stored-at':'1'}});
let keysCalls=0, active=0, peak=0, denied=false;
const fakeCache={
  keys:async()=>{keysCalls++;return body?[{url:key}]:[];},
  matchAll:async()=>body?[body.clone()]:[],
  match:async url=>{active++;peak=Math.max(peak,active);await turn();active--;if(denied)throw Error('SecurityError');return url===key&&body?body.clone():undefined;},
  delete:async()=>{body=null;return true;},
};
globalThis.caches={open:async()=>fakeCache,delete:async()=>true};
__resetWebAudioCacheStateForTest();
eq(await webMediaStatus([key,miss]),{[key]:'cached',[miss]:'missing'},'web complete vs missing');
await webMediaStatus([key,miss]); eq(keysCalls,1,'warm UI query does not rescan full index');
await webMediaStatus(Array.from({length:25},(_,i)=>'https://fixture.invalid/api/audio/'+i.toString(16).padStart(64,'0')+'.opus'));
ok(peak<=8,'web query concurrency bounded to 8');
denied=true; eq((await webMediaStatus([miss]))[miss],'unknown','denied reads are not misses'); denied=false;
const good=body;
body=null;eq((await webMediaStatus([key]))[key],'unknown','warm stale sizes cannot claim OS-evicted file cached');body=good;
const fullHeaders={'content-type':'audio/ogg','x-anyun-bytes':'9','x-anyun-stored-at':'1'};
ok(isCompleteWebCacheResponse(new Response('SYNTHETIC',{headers:fullHeaders})),'writer-created full response accepted');
for(const [name,status,headers] of [
 ['partial',206,fullHeaders],['html',200,{...fullHeaders,'content-type':'text/html'}],
 ['missing-marker',200,{'content-type':'audio/ogg'}],['zero-size',200,{...fullHeaders,'x-anyun-bytes':'0'}],
 ['too-big',200,{...fullHeaders,'x-anyun-bytes':'999999999'}],['fractional',200,{...fullHeaders,'x-anyun-bytes':'1.2'}],
 ['length-mismatch',200,{...fullHeaders,'content-length':'8'}],['range-header',200,{...fullHeaders,'content-range':'bytes 0-8/99'}],
 ['bad-time',200,{...fullHeaders,'x-anyun-stored-at':'0'}],
]) {
 body=new Response('SYNTHETIC',{status,headers});
 ok(!isCompleteWebCacheResponse(body),name+' is not a complete cache response');
 eq((await webMediaStatus([key]))[key],'unknown',name+' existence alone cannot produce cached');
}
body=good;
await invalidateCachedAudio(key); eq((await webMediaStatus([key]))[key],'missing','eviction rechecked');
globalThis.caches={open:async()=>{throw Error('SecurityError');},delete:async()=>true};
eq((await webMediaStatus([key]))[key],'unknown','denied open unknown');
Object.defineProperty(globalThis,'caches',{configurable:true,get(){throw Error('SecurityError getter');}});
eq((await webMediaStatus([key]))[key],'unknown','denied CacheStorage getter unknown');
delete globalThis.caches; eq((await webMediaStatus([key]))[key],'unknown','unsupported browser unknown');
eq((await webMediaStatus(['blob:fixture']))['blob:fixture'],'unknown','unsupported URL unknown');

// Compile the real row markup (not a duplicated UI implementation) as an SSR
// harness. Synthetic props isolate it from real catalog/player/audio data.
for(const [file,needle,occurrence,action] of [
 ['src/lib/Playlist.svelte','{#each preview.slice(0,20) as',0,'addOne(audio)'],
 ['src/lib/components/QueueOverlay.svelte','{#each list as',0,'playAt(i)'],
 ['src/lib/DayStrip.svelte','{#each songs as',0,'play(audio)'],
 ['src/lib/Timeline.svelte','{#each lane.songs as',0,'playSong(b)'],
 ['src/lib/Timeline.svelte','{#each lane.songs as',1,'playSong(b)'],
 ['src/lib/components/SearchPanel.svelte','{#each hits as',0,'playAudio(hit.audio)'],
]) {
  const source=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
  let start=source.indexOf(needle);
  for(let i=0;i<occurrence;i++)start=source.indexOf(needle,start+1);
  const end=source.indexOf('{/each}',start)+'{/each}'.length;
  const row=source.slice(start,end);
  ok(row.includes('audioUrl('),'UI uses actual playback source resolver: '+file);
  ok(!row.includes('disabled='),'offline availability never disables row: '+file);
  ok(row.includes(action),'original play/add action retained: '+file);
  ok(source.includes('backend.generation')&&source.includes('backend.base'),'backend changes observed: '+file);
  const script='<script>let { snapshot, audios }=$props(); const availability={subscribe(fn){fn(snapshot);return ()=>{};}}; const preview=audios;const list=audios.map((audio,i)=>({audio,queueEntryId:String(i)}));const songs=audios;const hits=audios.map(audio=>({audio,line:"fixture-line"}));const lane={dayStart:0,songs:audios.map(audio=>({audio,start:0,end:1}))};const rects=audios.map((_,i)=>({left:i*100,width:90}));const xPct=()=>0,hueOf=()=>0,clock=()=>"12:00",visibleTitle=x=>x;const HIT_PAD=6;const player={pos:-1};const dragMode=false,dragIdx=-1,dragDelta=0;let wasDragged=false;const added=null;const Check=()=>{},Plus=()=>{},X=()=>{};const audioUrl=x=>x;const fmtDur=()=>"0:01";const offlineRowHint='+offlineRowHint.toString()+';</script>';
  const compiled=compile(script+row,{generate:'server',filename:'offline-row-fixture.svelte'}).js.code;
  // data modules need absolute URLs for the compiler's runtime imports.
  const code=compiled.replace(/from ['"](svelte[^'"]*)['"]/g,(_,name)=>'from '+JSON.stringify(pathToFileURL(resolveModule(name)).href));
  const component=(await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))).default;
  const audios=['cached','missing','unknown'].map((id,i)=>({id,title:'fixture-'+id,opus:urls[i],duration:1}));
  const offline={online:false,statuses:{[urls[0]]:'cached',[urls[1]]:'missing',[urls[2]]:'unknown'}};
  const html=render(component,{props:{snapshot:offline,audios}}).body;
  eq((html.match(/offline-missing/g)||[]).length,1,'only confirmed miss dimmed: '+file);
  ok(html.includes('data-offline-availability="cached"'),'cached row remains: '+file);
  ok(html.includes('未完整缓存')&&html.includes('离线可用性未知'),'distinct visible labels: '+file);
  const normal=render(component,{props:{snapshot:{...offline,online:true},audios}}).body;
  ok(!normal.includes('offline-missing')&&!normal.includes('data-offline-availability'),'online rows undecorated: '+file);
  ok(!normal.includes('未完整缓存')&&!normal.includes('未知'),'no online cache labels: '+file);
}
const daySource=fs.readFileSync(new URL('../src/lib/DayStrip.svelte',import.meta.url),'utf8');
const timelineSource=fs.readFileSync(new URL('../src/lib/Timeline.svelte',import.meta.url),'utf8');
const searchSource=fs.readFileSync(new URL('../src/lib/components/SearchPanel.svelte',import.meta.url),'utf8');
ok(daySource.includes('days.filter(([day])=>day===expanded)'),'collapsed day songs are not queried');
ok(timelineSource.includes('laneWidth>0?visibleLanes'),'unlaid-out timeline does not query');
ok(searchSource.includes('open?hits.map'),'closed search does not query');
for(const source of [daySource,timelineSource]) {
 ok(source.includes('resolveBrowseAudios(songs,loadMonth'),'browse click uses guarded metadata fallback');
 ok(source.includes('playbackOperation.cancel()'),'retired backend/component cancels playback intent');
}
console.log('offline-availability: '+checks+' checks passed (synthetic behavior + compiled SSR rows; no native execution)');
