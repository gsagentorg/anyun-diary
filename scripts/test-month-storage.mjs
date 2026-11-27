import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {localStore,blobStore,validKey} from '../src/lib/server/storage.mjs';
import {publishMonths,rollbackRelease,digest} from '../src/lib/server/publisher.mjs';
import {monthBounds,queryMonths} from '../src/lib/server/months.mjs';
const now=monthBounds('2026-11').startAt+100;
const map=new Map(),events=[];const store={async read(k){return map.has(k)?new Response(map.get(k)):new Response(null,{status:404});},async write(k,b){events.push(k);map.set(k,b);}};
const bytes='OggSfixture',audioKey='audio/'+digest(bytes)+'.opus';map.set(audioKey,bytes);
const row={id:'one',file:'fixture.opus',opus:audioKey,title:'Fixture',startAt:monthBounds('2026-08').startAt+1,duration:5,lyrics:[],monthId:'2026-08'};
const first=await publishMonths([row],store,{now,maxMonths:2});assert.equal(first.months.length,4);assert(first.months.every(m=>m.available));assert.equal(queryMonths(first.months,now,2).length,2);
assert.equal(events.at(-1),'current.json');assert(events.at(-2).startsWith('releases/'));events.length=0;
// An incremental republish reads nothing back: unchanged month blocks are proven by
// their revision, and content-addressed audio keys are never fetched.
const reads={audio:0,month:0};const counted={...store,async read(k){if(k.startsWith('audio/'))reads.audio++;else if(k.startsWith('months/'))reads.month++;return store.read(k);}};
const again=await publishMonths([row],counted,{now});assert.equal(events.length,0);assert.equal(again.revision,first.revision);assert.equal(reads.audio,0,'no audio object is read back');assert.equal(reads.month,0,'unchanged month blocks are not read');
const pointer=map.get('current.json');const recent={...row,id:'recent',monthId:'2026-11',startAt:now};
const failing={...store,async write(k,b){if(k==='current.json')throw Error('mock commit failure');return store.write(k,b);}};
await assert.rejects(publishMonths([row,recent],failing,{now}),/commit failure/);assert.equal(map.get('current.json'),pointer);
const changed=await publishMonths([row,recent],store,{now});assert.notEqual(first.revision,changed.revision);assert(map.has(first.months[0].key));
await rollbackRelease(store,first.revision);assert.equal(map.get('current.json'),pointer);
// A block written by this run must read back; a store that drops the write is caught
// before the pointer moves.
const dropping={...store,async write(k,b){if(k.startsWith('months/'))return;return store.write(k,b);}};
await assert.rejects(publishMonths([{...row,title:'Dropped'}],dropping,{now}),/reference/);assert.equal(map.get('current.json'),pointer);
map.set('current.json','{}');await assert.rejects(publishMonths([],store,{now}),/pointer/);
const root=await mkdtemp(join(tmpdir(),'diary-storage-test-'));try{const local=localStore(root);await local.write('current.json',pointer);assert.equal(await(await local.read('current.json')).text(),pointer);assert.throws(()=>validKey('../secret'));}finally{await rm(root,{recursive:true,force:true});}
const calls=[];const blob=blobStore({baseUrl:'https://example.invalid/fixtures/',sdk:{async put(...a){calls.push(a)}},fetcher:async()=>new Response('{}')});await blob.write('current.json',pointer);assert.equal(calls[0][2].cacheControlMaxAge,1);await blob.write('releases/'+first.revision+'/manifest.json','{}');assert.equal(calls[1][2].cacheControlMaxAge,31536000);
console.log('release publication: incremental reuse/verification (no audio read-back), atomic failure, rollback, no deletion, local/Blob cache passed');
