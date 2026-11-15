import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {run} from './migrate-audio.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const audio=Buffer.from('OggS mock opus'),key='objects/'+hash(audio)+'.opus';
const payload=Buffer.from(JSON.stringify({generatedAt:1,timezone:'Asia/Shanghai',recordings:[{file:'r',start:1,duration:null,segments:[],clips:[{file:'c',title:'t',offsetStart:0,offsetEnd:1,seg:null,opus:key}]}]},null,2));
const snapshot='catalogs/'+hash(payload)+'.json',pointer=Buffer.from(JSON.stringify({schemaVersion:1,key:snapshot}));
const source=new Map([['catalog/current.json',pointer],[snapshot,payload],[key,audio]]),target=new Map();
let writes=[],mode='';
const server=createServer(async(req,res)=>{
  const u=new URL(req.url,'http://mock');assert(u.searchParams.has('X-Amz-Signature'));
  const [,bucket,...parts]=u.pathname.split('/'),k=parts.join('/');assert(!k.startsWith('audio/'));
  const store=bucket==='source'?source:target;
  if(bucket==='source')assert.equal(req.method,'GET');
  if(req.method==='PUT'){
    writes.push(k);const chunks=[];try{for await(const c of req)chunks.push(c);}catch{return;}
    if(mode==='interrupt'&&k===key){res.destroy();return;}
    store.set(k,Buffer.concat(chunks));
    if(mode==='pointer-timeout'&&k==='catalog/current.json')return;
    res.end();return;
  }
  if(!store.has(k)){res.writeHead(404);res.end();return;}res.end(store.get(k));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const env={};for(const [prefix,bucket] of [['SOURCE_S3_','source'],['AUDIO_S3_','target']])for(const [k,v] of Object.entries({ENDPOINT:'http://127.0.0.1:'+server.address().port,REGION:'test',BUCKET:bucket,ACCESS_KEY_ID:'YOUR-KEY-HERE',SECRET_ACCESS_KEY:'YOUR-SECRET-HERE',PATH_STYLE:'1'}))env[prefix+k]=v;
const call=(...args)=>run(['catalog','--timeout-ms','500',...args],env,'/nonexistent');
const reset=()=>{target.clear();writes=[];mode='';};
try{
  await call('--dry-run');assert.deepEqual(writes,[]);
  await call();assert.deepEqual(target.get(snapshot),payload);assert.equal(writes.at(-1),'catalog/current.json');assert.deepEqual(target.get(key),audio);
  writes=[];await call();assert.deepEqual(writes,['catalog/current.json']);
  reset();source.delete(key);await assert.rejects(call(),/pointer not written/);assert(!writes.includes('catalog/current.json'));source.set(key,audio);
  reset();target.set(key,Buffer.from('OggS wrong'));await assert.rejects(call(),/pointer not written/);assert.deepEqual(writes,[]);
  reset();target.set(snapshot,Buffer.from('{}'));await assert.rejects(call(),/snapshot conflict/);assert(!writes.includes('catalog/current.json'));
  reset();mode='interrupt';await assert.rejects(call(),/pointer not written/);assert(!writes.includes('catalog/current.json'));
  reset();mode='pointer-timeout';await call();assert.equal(writes.filter(k=>k==='catalog/current.json').length,1);assert.deepEqual(target.get('catalog/current.json'),pointer);
  reset();source.set(snapshot,Buffer.from('{}'));await assert.rejects(call(),/Source snapshot integrity/);assert.deepEqual(writes,[]);source.set(snapshot,payload);
  console.log('catalog migration tests passed');
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
