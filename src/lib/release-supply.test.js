import test from 'node:test';
import assert from 'node:assert/strict';
import {createMonthSupply} from './supply.js';
import {monthBounds} from './month.js';
test('hot refresh preserves in-flight release and invalid refresh preserves last good catalog',async()=>{
const entries=['2026-10','2026-11'].map(id=>({...monthBounds(id),count:1,revision:'old',key:id,available:true}));
let current={schemaVersion:2,timezone:'Asia/Shanghai',generatedAt:1,revision:'release-old',months:entries},gate,entered;
const started=new Promise(r=>entered=r),blocked=new Promise(r=>gate=r),calls=[];
const supply=createMonthSupply({monthUrl:(e,m)=>e.id+'/'+m.revision,fetch:async url=>{calls.push(url);if(url==='/api/catalog')return new Response(JSON.stringify(current));const [id,release]=url.split('/');if(id==='2026-11'&&release==='release-old'){entered();await blocked;}return new Response(JSON.stringify({schemaVersion:2,id,revision:release==='release-old'?'old':'new',audios:[{id:release+id,file:'fixture.opus',opus:'fixture.opus',title:release,startAt:monthBounds(id).startAt,duration:1,lyrics:[],monthId:id}]}));}});
const operation=supply.range({startAt:entries[0].startAt,endAt:entries[1].endAt});await started;
current={...current,revision:'release-new',months:entries.map(e=>({...e,revision:'new'}))};await supply.manifest({refresh:true});gate();
assert((await operation).every(a=>a.title==='release-old'));assert(calls.includes('2026-10/release-old'));
assert.equal((await supply.month('2026-11')).revision,'new');
current={};await assert.rejects(supply.manifest({refresh:true}),/manifest/);assert.equal((await supply.manifest()).revision,'release-new');
});
