/** Run after a Node build. Only synthetic data is served, bound to a temporary loopback port. */
import assert from 'node:assert/strict';
import http from 'node:http';
import {monthBounds,monthIdAt} from '../src/lib/month.js';
const {PLAYWRIGHT_MODULE,CHROMIUM_PATH}=process.env;
if(!PLAYWRIGHT_MODULE||!CHROMIUM_PATH) throw Error('Set PLAYWRIGHT_MODULE and CHROMIUM_PATH; this test must not silently skip');
const {chromium}=await import(PLAYWRIGHT_MODULE);
const {handler}=await import('../build/handler.js');
const id=monthIdAt(Date.now()/1000),bounds=monthBounds(id),hash='c'.repeat(64);
const audio={id:'offline-fixture',file:'synthetic.wav',opus:'audio/'+hash+'.opus',title:'Offline integration fixture',startAt:Math.floor(Date.now()/1000)-3600,duration:8,monthId:id,lyrics:[{t:0,text:'Synthetic offline lyric'}]};
const month={schemaVersion:2,id,revision:'fixture-month',audios:[audio]};
const manifest={schemaVersion:2,timezone:'Asia/Shanghai',generatedAt:Date.now()/1000,revision:'fixture-release',months:[{id,...bounds,count:1,revision:month.revision,key:'months/fixture.json',available:true}]};
const samples=8000*8,wav=Buffer.alloc(44+samples*2);
wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*2,40);
for(let i=0;i<samples;i++)wav.writeInt16LE(Math.round(1000*Math.sin(i*2*Math.PI*440/8000)),44+i*2);
let apiReads=0;
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://fixture.invalid');
 const json=v=>{res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');res.end(JSON.stringify(v));};
 if(u.pathname==='/api/current'){apiReads++;return json({schemaVersion:2,releaseId:'d'.repeat(64),key:'releases/'+ 'd'.repeat(64)+'/manifest.json'});}
 if(u.pathname==='/api/catalog'){apiReads++;return json(manifest);}
 if(u.pathname.startsWith('/api/month/')){apiReads++;return json(month);}
 if(u.pathname==='/api/audio/'+hash+'.opus'){
  if(u.searchParams.get('resolve')==='1')return json({url:u.pathname+'?delivery=fixture',expiresAt:null});
  res.setHeader('content-type','audio/wav');res.setHeader('content-length',wav.length);res.setHeader('cache-control','no-store');return res.end(wav);
 }
 if(u.pathname.startsWith('/api/')||u.pathname.startsWith('/brand/')){res.statusCode=404;return res.end();}
 handler(req,res);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({executablePath:CHROMIUM_PATH,headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
try{
 const context=await browser.newContext();
 // No external telemetry, configured live endpoint, or other real service may be reached.
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin,{waitUntil:'networkidle'});
 await page.waitForSelector('[data-continuous-browse][data-cached-months="1"]');
 await page.locator('button[title="用这一天的歌替换播放列表"]').first().click();
 await page.waitForFunction(()=>[window.__anyunAudio].filter(Boolean).some(a=>!a.paused&&a.currentTime>0.2));
 await page.waitForFunction(async()=>{const c=await caches.open('anyun-web-audio-v1');return(await c.keys()).length===1;});
 await page.waitForFunction(async()=>{await navigator.serviceWorker.ready;return !!navigator.serviceWorker.controller;});
 await page.waitForFunction(async()=>{const names=await caches.keys();for(const name of names.filter(n=>n.startsWith('anyun-catalog-offline-'))){const c=await caches.open(name);if((await c.keys()).length>=3)return true;}return false;});
 // Pause online, then close the tab: discard every in-memory audio/blob/catalog reference.
 await page.getByRole('button',{name:'暂停',exact:true}).click();
 await page.close();
 await context.setOffline(true);
 const cold=await context.newPage();await cold.goto(origin,{waitUntil:'domcontentloaded'});
 await cold.waitForSelector('[data-continuous-browse][data-cached-months="1"]');
 assert.ok(await cold.getByRole('status').filter({hasText:'离线目录'}).count()>0);
 await cold.getByRole('button',{name:'播放',exact:true}).click();
 await cold.waitForFunction(()=>[window.__anyunAudio].filter(Boolean).some(a=>a.src.startsWith('blob:')&&!a.paused&&a.currentTime>0.2));
 const state=await cold.evaluate(()=>{const a=[window.__anyunAudio].filter(Boolean).find(a=>!a.paused);return {blob:a.src.startsWith('blob:'),time:a.currentTime};});
 assert.equal(state.blob,true);
 console.log('offline app browser: PASS',JSON.stringify({coldShell:true,coldCatalog:true,coldPlayback:state,apiReads,onlinePageErrors:errors}));
 await context.close();
}finally{await browser.close();await new Promise(r=>server.close(r));}
