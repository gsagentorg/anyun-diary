import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {localStore,blobStore,validKey} from '../src/lib/server/storage.mjs';
import {publishMonths} from '../src/lib/server/publisher.mjs';
import {monthId,monthBounds,queryMonths} from '../src/lib/server/months.mjs';
const now=Date.parse('2026-11-17T00:00:00+08:00')/1000;
assert.equal(monthId(Date.parse('2026-11-07T00:00:00+08:00')/1000),'2026-11');
assert.equal(monthId(Date.parse('2026-11-07T00:00:00+08:00')/1000-.001),'2026-10');
const map=new Map(),events=[];const store={async read(k){return map.has(k)?new Response(map.get(k)):new Response(null,{status:404});},async write(k,b){events.push(['write',k]);map.set(k,b);},async remove(k){events.push(['remove',k]);map.delete(k);}};
const row={id:'one',file:'fixture.opus',opus:'audio/fixture.opus',title:'Fixture',startAt:monthBounds('2026-08').startAt+1,duration:5,lyrics:[],monthId:'2026-08'};
const first=await publishMonths([row],store,{now});assert.equal(first.months.length,4);assert.equal(first.months.at(-1).count,0);
events.length=0;await publishMonths([row],store,{now});assert.equal(events.length,0);
const limited=await publishMonths([row],store,{now,maxMonths:2});assert.deepEqual(limited.months.filter(m=>m.available).map(m=>m.id),['2026-10','2026-11']);assert.equal(limited.months[0].count,1);
const manifestIndex=events.findIndex(e=>e[0]==='write'&&e[1]==='manifest.json');assert(manifestIndex>=0);assert(events.filter(e=>e[0]==='remove').every(e=>events.indexOf(e)>manifestIndex));assert(events.every(e=>!e[1].startsWith('audio/')));
assert.equal(queryMonths(limited.months,now,2).length,2);
const root=await mkdtemp(join(tmpdir(),'diary-storage-test-'));try{await localStore(root).write('manifest.json','{}');assert.equal(await(await localStore(root).read('manifest.json')).text(),'{}');assert.throws(()=>validKey('../secret'));}finally{await rm(root,{recursive:true,force:true});}
const calls=[];const blob=blobStore({baseUrl:'https://example.invalid/fixtures/',sdk:{async put(...a){calls.push(a)},async del(...a){calls.push(a)}},fetcher:async(url)=>new Response(JSON.stringify({url}))});await blob.write('manifest.json','{}');assert.equal(calls[0][2].addRandomSuffix,false);assert.equal(calls[0][2].allowOverwrite,true);assert.equal(calls[0][2].cacheControlMaxAge,60);assert((await(await blob.read('manifest.json')).json()).url.endsWith('/fixtures/manifest.json'));
console.log('monthly publisher/storage mock tests passed');

// Changed blocks commit before removal, and invalid pointers cannot authorize deletion.
const recent={...row,id:'recent',startAt:monthBounds('2026-11').startAt+3,monthId:'2026-11'};
events.length=0;const changed=await publishMonths([row,recent],store,{now,maxMonths:2});
assert.equal(events.filter(e=>e[0]==='write'&&e[1].startsWith('months/')).length,1);
assert(events.findIndex(e=>e[1]==='manifest.json')>events.findIndex(e=>e[1].startsWith('months/')));
const committed=map.get('manifest.json');let deletes=0;const failStore={...store,async write(k,b){if(k==='manifest.json')throw Error('mock commit failure');return store.write(k,b)},async remove(){deletes++}};
await assert.rejects(publishMonths([{...recent,title:'changed'}],failStore,{now,maxMonths:2}),/commit failure/);
assert.equal(map.get('manifest.json'),committed);assert.equal(deletes,0);
await assert.rejects(publishMonths([],store,{now,previous:{...changed,months:[{...changed.months[0],key:'audio/'+ 'a'.repeat(64)+'.opus'}]}}),/previous month key/);
console.log('publisher: incremental blocks, commit failure and deletion boundary passed');

// Preparation and direct publication both apply retention before touching media.
const {preparePublicationAudio,publish,retainedAudios}=await import('./publish-data.mjs');
const boundary=monthBounds('2026-11').startAt;
assert.deepEqual(retainedAudios([row,recent],{now:boundary,maxMonths:1}).map(a=>a.id),['recent']);
assert.deepEqual(retainedAudios([row,recent],{now:boundary-.001,maxMonths:1}).map(a=>a.id),[]);
const scratch=await mkdtemp(join(tmpdir(),'diary-retention-test-'));
try{
 const source=join(scratch,'recent.opus');await writeFile(source,'OggSfixture');
 const sources={one:join(scratch,'missing-history.m4a'),recent:source};
 let prepared=0;
 const media=await preparePublicationAudio([row,recent],sources,scratch,{now,maxMonths:2},async(selected,inputs,temp)=>{
  prepared++;assert.deepEqual(selected.map(a=>a.id),['recent']);assert.equal(inputs,sources);assert.equal(temp,scratch);return new Map([['recent',source]]);
 });
 assert.equal(prepared,1);
 const mediaAccess=[];const guardedMedia={get(id){mediaAccess.push(id);assert.equal(id,'recent');return media.get(id);}};
 events.length=0;
 const result=await publish([row,recent],guardedMedia,store,{now,maxMonths:2});
 assert.deepEqual(mediaAccess,['recent']);
 assert.equal(result.months.find(m=>m.id==='2026-08').count,1);
 assert.equal(result.months.find(m=>m.id==='2026-08').available,false);
 assert.deepEqual(result.months.filter(m=>m.available).map(m=>m.id),['2026-10','2026-11']);
 const audioKeys=[...map.keys()].filter(k=>k.startsWith('audio/'));assert.equal(audioKeys.length,1);
 const removed=await publish([recent],guardedMedia,store,{now,maxMonths:2});
 assert.equal(removed.months.find(m=>m.id==='2026-08').count,0);
 assert.equal(removed.months.find(m=>m.id==='2026-08').available,false);
 assert.deepEqual([...map.keys()].filter(k=>k.startsWith('audio/')),audioKeys);
 assert(events.filter(e=>e[0]==='remove').every(e=>!e[1].startsWith('audio/')));
}finally{await rm(scratch,{recursive:true,force:true});}
console.log('publisher: early retention, historical counts, authoritative empty months and immutable audio passed');
