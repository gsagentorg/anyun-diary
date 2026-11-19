import test from 'node:test';
import assert from 'node:assert/strict';
import { monthBounds,monthIdAt,selectMonths,subtractCalendarMonths } from './month.js';
import { validateManifest,validateMonth,validateAudio } from './catalog-schema.js';
import { createMonthSupply } from './supply.js';
const epoch=s=>Date.parse(s)/1000;
const at=epoch('2026-11-17T00:00:00+08:00');
function fixture(){
 const months=['2026-09','2026-10','2026-11'].map(id=>({...monthBounds(id),count:id==='2026-10'?0:1,revision:'r1',key:id+'.json',available:true}));
 const manifest={schemaVersion:2,timezone:'Asia/Shanghai',generatedAt:at,revision:'m1',months};
 const blocks=Object.fromEntries(months.map(m=>[m.key,{schemaVersion:2,id:m.id,revision:m.revision,audios:m.count?[{id:m.id,file:'sample.wav',opus:'sample.opus',title:'sample',startAt:m.startAt,duration:null,lyrics:[{t:0,text:'line'}],monthId:m.id}]:[]}]));
 return {manifest,blocks};
}
test('Shanghai boundary is left closed, right open, including year rollover',()=>{
 const b=monthBounds('2026-11'); assert.equal(b.startAt,epoch('2026-11-07T00:00:00+08:00'));
 assert.equal(monthIdAt(b.startAt-1),'2026-10');assert.equal(monthIdAt(b.startAt),'2026-11');assert.equal(monthIdAt(b.endAt),'2026-12');
 assert.equal(monthIdAt(epoch('2027-01-01T00:00:00+08:00')),'2026-12');
});
test('calendar cap never skips empty months; zero unlimited; rolling clamp',()=>{
 const {manifest}=fixture();assert.deepEqual(selectMonths(manifest,{now:at,maxMonths:2}).map(m=>m.id),['2026-10','2026-11']);
 assert.equal(selectMonths(manifest,{now:at,maxMonths:0}).length,3);
 assert.equal(subtractCalendarMonths(epoch('2024-03-31T12:34:56+08:00'),1),epoch('2024-02-29T12:34:56+08:00'));
});
test('schema validates empty blocks and rejects wrong month, duplicates, revision/count',()=>{
 const {manifest,blocks}=fixture();validateManifest(manifest);validateMonth(blocks['2026-10.json'],manifest.months[1]);
 assert.throws(()=>validateMonth({...blocks['2026-10.json'],revision:'wrong'},manifest.months[1]));
 const a=blocks['2026-11.json'].audios[0];assert.throws(()=>validateAudio({...a,monthId:'2026-10'}));
 assert.throws(()=>validateMonth({...blocks['2026-11.json'],audios:[a,a]}));
});
test('cold start one block; concurrent dedupe; cache revision and range/resolve',async()=>{
 const {manifest,blocks}=fixture(),calls=[];
 const supply=createMonthSupply({now:()=>at,fetch:async url=>{calls.push(url);await new Promise(r=>setTimeout(r,2));return {ok:true,json:async()=>structuredClone(url==='/api/catalog'?manifest:blocks[url])};}});
 await Promise.all([supply.coldStart(),supply.coldStart()]);assert.deepEqual(calls,['/api/catalog','2026-11.json']);
 assert.equal((await supply.resolve('2026-11','2026-11')).id,'2026-11');assert.equal(calls.length,2);
 assert.equal((await supply.range({maxMonths:2})).length,1);assert.deepEqual(calls.slice(2),['2026-10.json']);
 manifest.months[2].revision='r2';blocks['2026-11.json'].revision='r2';manifest.revision='m2';
 await supply.manifest({refresh:true});assert.equal((await supply.month('2026-11')).revision,'r2');assert.equal(calls.filter(x=>x==='2026-11.json').length,2);
 await assert.rejects(supply.resolve('id'),/monthId/);
});
test('abort subscriber does not break shared request; failed fetch retries',async()=>{
 const {manifest}=fixture();let calls=0;
 const supply=createMonthSupply({fetch:async()=>{calls++;await new Promise(r=>setTimeout(r,10));return {ok:true,json:async()=>manifest};}});
 const c=new AbortController(),p=supply.manifest({signal:c.signal}),other=supply.manifest();c.abort();
 await assert.rejects(p,{name:'AbortError'});await other;assert.equal(calls,1);
 const dead=new AbortController();dead.abort();await assert.rejects(supply.month('2026-11',{signal:dead.signal}),{name:'AbortError'});assert.equal(calls,1);
 let n=0;const retry=createMonthSupply({fetch:async()=>{if(!n++)throw new Error('offline');return {ok:true,json:async()=>manifest};}});
 await assert.rejects(retry.manifest(),/offline/);await retry.manifest();assert.equal(n,2);
});
