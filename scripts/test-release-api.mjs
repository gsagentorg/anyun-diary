import assert from 'node:assert/strict';
import {localStore} from '../src/lib/server/storage.mjs';
import {publishMonths,digest} from '../src/lib/server/publisher.mjs';
import {monthBounds,monthIdAt,shiftMonthId} from '../src/lib/month.js';
const base=process.env.TEST_URL,store=localStore(process.env.TEST_DATA_DIR),now=Date.now()/1000,current=monthIdAt(now),old=shiftMonthId(current,-4),bytes='OggSfixture',key='audio/'+digest(bytes)+'.opus';await store.write(key,bytes);
const rows=[old,current].map(id=>({id,file:'fixture',opus:key,title:'permission fixture',startAt:monthBounds(id).startAt+1,monthId:id,duration:1,lyrics:[]}));
const m=await publishMonths(rows,store,{now});
const audio=await fetch(base+'/api/'+key,{headers:{range:'bytes=1-3'}});assert.equal(audio.status,206);assert.equal(await audio.text(),bytes.slice(1,4));assert.equal(audio.headers.get('content-range'),'bytes 1-3/'+bytes.length);
let r=await fetch(base+'/api/current');assert.equal(r.status,200);const etag=r.headers.get('etag');assert(etag);assert.equal((await fetch(base+'/api/current',{headers:{'If-None-Match':etag}})).status,304);
const catalog=await(await fetch(base+'/api/catalog')).json();assert.equal(catalog.queryMonthLimit,2);assert.equal(catalog.months.find(e=>e.id===old).available,false);
assert.equal((await fetch(base+'/api/month/'+old+'?release='+m.revision)).status,404);
assert.equal((await fetch(base+'/api/month/'+current+'?release='+m.revision)).status,200);
const stream=await(await fetch(base+'/api/search?q=permission&release='+m.revision)).text();assert(!stream.includes('"id":"'+old+'"'));assert(stream.includes('"id":"'+current+'"'));
// Hostile presentation flags cannot widen the server calendar permission window.
const poisoned={...m,queryMonthLimit:0,months:m.months.map(e=>({...e,available:true}))};const revision=digest(JSON.stringify(poisoned.months));await store.write('releases/'+revision+'/manifest.json',JSON.stringify({...poisoned,revision}));
assert.equal((await fetch(base+'/api/month/'+old+'?release='+revision)).status,404);
await store.write('current.json','{}');assert.equal((await fetch(base+'/api/current')).status,503);
console.log('HTTP API: conditional current 304, limited catalog, explicit old release month denied, search cannot include old month, malformed current 503 passed');
