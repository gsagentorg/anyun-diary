import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {localStore} from '../src/lib/server/storage.mjs';
import {publishMonths,digest} from '../src/lib/server/publisher.mjs';
import {monthBounds,monthIdAt as monthId,shiftMonthId} from '../src/lib/month.js';
// Load the real client catalog layer eagerly: the app module under test must be compiled before the
// harness spawns its server, never lazily mid-run.
import * as app from '../src/lib/backend.svelte.ts';
const root=fileURLToPath(new URL('..',import.meta.url));
// Build once when the adapter-node output is absent; the test itself never rebuilds,
// so anything the running server serves after publication must come from runtime storage.
if(!existsSync(join(root,'build','index.js'))){const built=spawnSync(process.execPath,[join(root,'node_modules','vite','bin','vite.js'),'build'],{cwd:root,stdio:'inherit',env:{...process.env,DEPLOY_TARGET:'node'}});if(built.status!==0)throw Error('vite build failed');}
const fingerprint=async()=>{const parts=[];for(const name of ['index.js','handler.js','env.js','server/manifest.js']){const p=join(root,'build',name);if(existsSync(p)){const b=await readFile(p);parts.push(name+':'+b.length+':'+createHash('sha256').update(b).digest('hex'));}}return parts.join('|');};
async function main(){
 const beforeFingerprint=await fingerprint();
 const freePort=()=>new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>resolve(port));});});
 const dataDir=await mkdtemp(join(tmpdir(),'diary-local-app-')),base='http://127.0.0.1:'+(await freePort());
 const store=localStore(dataDir);
 const now=Date.now()/1000,current=monthId(now),prior=shiftMonthId(current,-1);
 const audioBytes='OggSfixture-local-runtime',audioKey='audio/'+digest(audioBytes)+'.opus';
 await store.write(audioKey,audioBytes);
 const row=(id,title,month)=>({id,file:id+'.opus',opus:audioKey,title,startAt:monthBounds(month).startAt+3600,monthId:month,duration:30,lyrics:[{t:0,text:title}]});
 const rows=title=>[row('current-'+title,title,current),row('prior-'+title,title,prior)];
 // v1 is published to the isolated fixture before the app starts: the running app's own view of it
 // can then only come from runtime storage.
 const v1=await publishMonths(rows('v1'),store,{now,maxMonths:0});
 const server=spawn(process.execPath,[join(root,'build','index.js')],{cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:new URL(base).port,HOST:'127.0.0.1',ORIGIN:base,CATALOG_STORAGE:'local',CATALOG_LOCAL_DIR:dataDir,MAX_QUERY_MONTHS:'0'}});
 let logs='';server.stdout.on('data',d=>{logs+=d;});server.stderr.on('data',d=>{logs+=d;});
 const json=async path=>{const r=await fetch(base+path,{headers:{'cache-control':'no-store',connection:'close'}});return {status:r.status,body:await r.json().catch(()=>null),etag:r.headers.get('etag')};};
 const wait=async()=>{for(let i=0;i<150;i++){try{if((await json('/api/current')).status===200)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('server did not become ready: '+logs);};
 const realFetch=globalThis.fetch;
 globalThis.fetch=(input,init)=>{const url=typeof input==='string'&&input.startsWith('/')?base+input:input;return realFetch(url,init);};
 const seen=async()=>({revision:app.backend.manifest?.revision??null,title:app.backend.months[current]?.[0]?.title??null});
 try{
  await wait();
  const served=await json('/api/catalog');assert.equal(served.status,200);assert.equal(served.body.revision,v1.revision);
  const v1month=await json('/api/month/'+current+'?release='+v1.revision);assert.equal(v1month.status,200);assert.equal(v1month.body.audios[0].title,'v1');
  // The running application (real client module) sees the runtime catalog with no rebuild/restart.
  await app.fetchIndex();assert.deepEqual(await seen(),{revision:v1.revision,title:'v1'});assert.equal(app.backend.error,'');
  // Publish v2 into the SAME live fixture: new immutable months + release, current pointer last.
  const v2=await publishMonths(rows('v2'),store,{now,maxMonths:0});assert.notEqual(v2.revision,v1.revision);
  assert.equal(await fingerprint(),beforeFingerprint,'no build artifacts changed');
  assert.equal((await json('/api/catalog')).body.revision,v2.revision);
  assert.equal((await json('/api/month/'+current+'?release='+v2.revision)).body.audios[0].title,'v2');
  assert.equal((await json('/api/month/'+current+'?release='+v1.revision)).body.audios[0].title,'v1','old release stays immutable');
  await app.fetchIndex();assert.deepEqual(await seen(),{revision:v2.revision,title:'v2'});
  // Incomplete update (1): publication interrupted at the pointer commit leaves immutable objects
  // behind, but the last valid catalog keeps being served, online and in the running app.
  const pointerBefore=await readFile(join(dataDir,'current.json'),'utf8');
  const interrupted={async read(k,o){return store.read(k,o);},async write(k,b){if(k==='current.json')throw Error('interrupted before pointer commit');return store.write(k,b);},async remove(k){return store.remove(k);}};
  await assert.rejects(publishMonths(rows('v3'),interrupted,{now,maxMonths:0}),/interrupted/);
  assert.equal(await readFile(join(dataDir,'current.json'),'utf8'),pointerBefore);
  assert.equal((await json('/api/catalog')).body.revision,v2.revision);
  await app.fetchIndex();assert.deepEqual(await seen(),{revision:v2.revision,title:'v2'});assert.equal(app.backend.error,'');
  // Incomplete update (2): a pointer switched out-of-band to a release whose month object is missing.
  // The server must never fabricate or serve partial month data, and the running app must keep its
  // last valid catalog instead of replacing it with the broken revision.
  const missing=digest(JSON.stringify(['never-written']));
  const brokenEntries=v2.months.map(e=>({...e,revision:missing,key:'months/'+e.id+'/'+missing+'.json'}));
  const brokenRevision=digest(JSON.stringify(brokenEntries));
  await store.write('releases/'+brokenRevision+'/manifest.json',JSON.stringify({schemaVersion:2,timezone:'Asia/Shanghai',generatedAt:Math.floor(now),revision:brokenRevision,months:brokenEntries}));
  await writeFile(join(dataDir,'current.json'),JSON.stringify({schemaVersion:2,releaseId:brokenRevision,key:'releases/'+brokenRevision+'/manifest.json'}));
  assert.equal((await json('/api/current')).body.releaseId,brokenRevision);
  assert.equal((await json('/api/catalog')).status,200,'manifest itself is readable');
  const brokenMonth=await json('/api/month/'+current+'?release='+brokenRevision);
  assert.equal(brokenMonth.status,503);assert.deepEqual(brokenMonth.body,{error:'Month unavailable'});
  await app.fetchIndex();assert.deepEqual(await seen(),{revision:v2.revision,title:'v2'},'last valid catalog kept');assert.ok(app.backend.error,'refresh reports the failure');
  // Truncated pointer (partial write): the server refuses cleanly instead of guessing a catalog.
  await writeFile(join(dataDir,'current.json'),'{"schemaVersion":2,"releaseId":');
  assert.equal((await json('/api/current')).status,503);assert.equal((await json('/api/catalog')).status,503);
  assert.equal((await json('/api/month/'+current)).status,503);
  assert.equal(server.exitCode,null,'server stayed up');
  // Restoring the last valid pointer recovers the running app with no restart.
  await writeFile(join(dataDir,'current.json'),pointerBefore);
  await app.fetchIndex();assert.deepEqual(await seen(),{revision:v2.revision,title:'v2'});assert.equal(app.backend.error,'');
  assert.equal(await fingerprint(),beforeFingerprint,'no rebuild happened end to end');
  assert.equal(server.exitCode,null,'same server process served every revision');
  console.log(JSON.stringify({v1:v1.revision,broken:brokenRevision,v2:v2.revision,months:v2.months.length}));
  console.log('local runtime catalog: publication without rebuild, interrupted publish keeps pointer, broken release keeps last valid catalog, truncated pointer refused, recovery passed');
 }finally{
  globalThis.fetch=realFetch;
  server.kill('SIGKILL');
  await new Promise(resolve=>{if(server.exitCode!==null||server.signalCode)return resolve();server.once('exit',resolve);setTimeout(resolve,5000).unref();});
  server.stdout.destroy();server.stderr.destroy();
  await rm(dataDir,{recursive:true,force:true});
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
