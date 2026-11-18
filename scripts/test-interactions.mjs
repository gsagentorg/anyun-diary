import assert from 'node:assert/strict';
import {createLatestOperation} from '../src/lib/interactions.js';
import {createMonthSupply} from '../src/lib/supply.js';
const tick=()=>new Promise(r=>setTimeout(r,0));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const op=createLatestOperation(),queue=['existing'];let commits=0;
const commit=v=>{commits++;queue.unshift(...v);};
for(const reason of ['cancel','range change','close']){const d=deferred();let signal;const p=op.run(s=>{signal=s;return d.promise;},commit);op.cancel();assert.equal(signal.aborted,true,reason);d.resolve(['stale']);await p;assert.deepEqual(queue,['existing']);}
const old=deferred(),latest=deferred();const p=op.run(()=>old.promise,commit),q=op.run(()=>latest.promise,commit);old.resolve(['old']);await p;assert.equal(commits,0);latest.resolve(['new']);await q;assert.equal(commits,1);assert.deepEqual(queue,['new','existing']);await assert.rejects(op.run(()=>Promise.reject(Error('month failure')),commit));assert.equal(commits,1);
let transportSignal,cancelled=false,stream;
const supply=createMonthSupply({fetch:async(url,{signal})=>{if(url==='/api/catalog')return {ok:true,json:async()=>({schemaVersion:2,timezone:'Asia/Shanghai',generatedAt:1,revision:'fixture',months:[]})};transportSignal=signal;return {ok:true,body:new ReadableStream({start(c){stream=c;},cancel(){cancelled=true;}})};}});
const messages=[];const searchOp=createLatestOperation();const task=searchOp.run(async(signal,guard)=>{await supply.search('first',{signal,onMessage:guard(m=>messages.push(m))});},()=>{}).catch(e=>assert.equal(e.name,'AbortError'));
await tick();stream.enqueue(new TextEncoder().encode(JSON.stringify({type:'progress',completed:1})+'\n'));await tick();assert.equal(messages.length,1);searchOp.cancel();await task;assert.equal(transportSignal.aborted,true);assert.equal(cancelled,true);assert.equal(messages.length,1);
let sharedSignal;const wait=deferred();const shared=createMonthSupply({fetch:async(url,{signal})=>{sharedSignal=signal;return wait.promise;}});const a=new AbortController(),b=new AbortController();const x=shared.manifest({signal:a.signal}).catch(e=>e.name),y=shared.manifest({signal:b.signal}).catch(e=>e.name);await tick();a.abort();assert.equal(sharedSignal.aborted,false);b.abort();assert.equal(sharedSignal.aborted,true);assert.equal(await x,'AbortError');assert.equal(await y,'AbortError');wait.resolve({ok:true,json:async()=>({})});await tick();
console.log('interaction tests passed: latest-only atomic prepend, failure unchanged, search exit abort, shared last-subscriber abort');
