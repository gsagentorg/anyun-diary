import assert from 'node:assert/strict';
import {monthBounds,monthIdAt,shiftMonthId} from '../src/lib/month.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox']});
const page=await browser.newPage();let version=1,fail=false,moduleUrl='',catalogReads=0,pointerReads=0;
const ids=[monthIdAt(Date.now()/1000),shiftMonthId(monthIdAt(Date.now()/1000),-1)];
page.on('request',r=>{if(new URL(r.url()).pathname==='/src/lib/backend.svelte.ts')moduleUrl=r.url();});
await page.route('**/api/current',r=>{pointerReads++;const etag='"v'+version+'"';return r.request().headers()['if-none-match']===etag?r.fulfill({status:304,headers:{etag}}):r.fulfill({headers:{etag},json:{schemaVersion:2,releaseId:'v'+version}});});
await page.route('**/api/catalog',r=>{catalogReads++;return r.fulfill({json:{schemaVersion:2,timezone:'Asia/Shanghai',generatedAt:1,revision:'v'+version,months:ids.map(id=>({...monthBounds(id),count:1,revision:'v'+version,key:id,available:true}))}});});
await page.route('**/api/month/*',async r=>{const u=new URL(r.request().url()),id=u.pathname.split('/').pop(),v=u.searchParams.get('release');if(fail&&v==='v2')return r.fulfill({status:503});return r.fulfill({json:{schemaVersion:2,id,revision:v,audios:[{id:id+v,file:'fixture',opus:'fixture',title:'Release '+v,startAt:monthBounds(id).startAt+1,duration:1,lyrics:[],monthId:id}]}});});
try{await page.goto(process.env.TEST_URL);await page.waitForSelector('[data-continuous-browse] [role=button]');
const state=()=>page.evaluate(async url=>{const m=await import(url);return {revision:m.backend.manifest.revision,titles:Object.values(m.backend.summaries).flat().map(a=>a.title),error:m.backend.error};},moduleUrl);
assert.equal((await state()).revision,'v1');const count=catalogReads;
await page.evaluate(async url=>(await import(url)).fetchIndex(),moduleUrl);assert.equal(catalogReads,count,'unchanged pointer must not fetch manifest');
version=2;fail=true;await page.evaluate(async url=>(await import(url)).fetchIndex(),moduleUrl);assert.equal((await state()).revision,'v1');assert((await state()).titles.every(t=>t==='Release v1'));assert((await state()).error);
fail=false;await page.evaluate(async url=>(await import(url)).fetchIndex(),moduleUrl);assert.equal((await state()).revision,'v2');assert((await state()).titles.every(t=>t==='Release v2'));
// range captures its release before a concurrent browser update
await page.evaluate(async({url,from,to})=>{const m=await import(url);window.oldRange=m.audiosInRange(from,to);},{url:moduleUrl,from:monthBounds(ids[1]).startAt,to:monthBounds(ids[0]).endAt});
version=3;await page.evaluate(async url=>(await import(url)).fetchIndex(),moduleUrl);const result=await page.evaluate(async()=> (await window.oldRange).map(a=>a.title));assert(result.every(t=>t==='Release v2'));assert.equal((await state()).revision,'v3');
console.log(JSON.stringify({transactionalFailureRetainsOld:true,retryCommitsNew:true,rangeFixedRelease:true,conditionalManifestReads:catalogReads,pointerReads}));}finally{await browser.close();}
