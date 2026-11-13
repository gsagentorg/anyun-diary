import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, presign } from './migrate-audio.mjs';
const dir=await mkdtemp(join(tmpdir(),'audio-migration-'));
const name='中文 space.opus', audio=Buffer.from('OggShello streamed audio');
let target=null,puts=0,mode='',requests=0,sourceGets=0,targetGets=0,events=[],conditional=false;
let corsXml=null,corsPuts=0,corsMode='';
const xmlError=(res,code,status)=>{res.writeHead(status,{'content-type':'application/xml'});res.end('<Error><Code>'+code+'</Code></Error>');};
const server=createServer(async(req,res)=>{
  requests++;const u=new URL(req.url,'http://localhost');
  if(u.searchParams.has('cors')){
    events.push(req.method+':cors');assert.equal(u.pathname,'/bucket/');
    assert.match(req.headers.authorization,/^AWS4-HMAC-SHA256 /);assert.ok(req.headers['x-amz-date']);
    if(corsMode==='denied'){xmlError(res,'AccessDenied',403);return;}
    if(corsMode==='unsupported'){xmlError(res,'NotImplemented',501);return;}
    if(req.method==='PUT'){corsPuts++;let body='';for await(const c of req)body+=c;assert.match(body,/<CORSConfiguration/);assert.match(body,/<AllowedMethod>HEAD<\/AllowedMethod>/);assert.match(body,/<AllowedHeader>Range<\/AllowedHeader>/);corsXml=body;if(corsMode==='mismatch')corsMode='mismatch-read';res.end();return;}
    if(!corsXml){xmlError(res,'NoSuchCORSConfiguration',404);return;}
    res.setHeader('content-type','application/xml');res.end(corsMode==='mismatch-read'?'<CORSConfiguration/>':corsXml);return;
  }
  if(u.pathname==='/api/audio-url'){res.writeHead(302,{location:'/audio/'+encodeURIComponent(name)});res.end();return;}
  if(u.pathname.startsWith('/audio/')){
    events.push(req.method+':source:'+decodeURIComponent(u.pathname.slice(7)));
    if(req.method==='GET')sourceGets++;
    if(mode==='404'){res.writeHead(404);res.end();return;}
    res.writeHead(200,mode==='length'?{}:{'content-length':audio.length});res.end(req.method==='HEAD'?undefined:audio);return;
  }
  if(req.method==='HEAD'&&mode==='target-head-error'){res.writeHead(503);res.end();return;}
  if(req.method==='HEAD'&&mode==='target-length'){res.writeHead(200);res.end();return;}
  if(req.method==='GET')targetGets++;
  if(req.method==='PUT'){events.push('PUT:target');assert.equal(req.headers['if-none-match'],conditional?'*':undefined, 'conditional PUT follows explicit switch');puts++;const chunks=[];for await(const c of req)chunks.push(c);target=Buffer.concat(chunks);if(mode==='corrupt')target[5]^=1;res.end();return;}
  if(!target){res.writeHead(404);res.end();return;}res.writeHead(200,{'content-length':target.length});res.end(req.method==='HEAD'?undefined:target);
});
try{
  await mkdir(join(dir,'src/lib'),{recursive:true});await writeFile(join(dir,'src/lib/data.json'),JSON.stringify({recordings:[{clips:[{opus:name}]}]}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  const env={SOURCE_AUDIO_BASE:base,AUDIO_S3_ENDPOINT:base,AUDIO_S3_REGION:'test',AUDIO_S3_BUCKET:'bucket',AUDIO_S3_ACCESS_KEY_ID:'YOUR-ACCESS-HERE',AUDIO_S3_SECRET_ACCESS_KEY:'YOUR-SECRET-HERE',AUDIO_S3_PATH_STYLE:'1'};
  const call=(...args)=>run(['transfer',...args],env,dir);
  const origin='https://your-playback-host-here', origin2='https://your-second-host-here';
  const cors=(...args)=>run(['configure-cors','--cors-origin',origin,...args],env,dir);
  const beforeCors=requests;
  for(const bad of ['*','https://host/path','https://host/','https://*.host','null','ftp://host','https://host?x=1','https://user:pass@host'])await assert.rejects(run(['configure-cors','--cors-origin',bad],env,dir),/origin/);
  await assert.rejects(run(['configure-cors'],env,dir),/Required/);assert.equal(requests,beforeCors);
  await cors('--dry-run');assert.equal(corsPuts,0);
  await cors();assert.equal(corsPuts,1);assert.match(corsXml,/<ExposeHeader>Content-Range<\/ExposeHeader>/);
  await cors();assert.equal(corsPuts,1);
  await cors('--cors-origin',origin2);assert.equal(corsPuts,2);assert.ok(corsXml.includes(origin)&&corsXml.includes(origin2));
  corsXml=corsXml.replace('</CORSConfiguration>','<CORSRule><ID>unrelated&amp;rule</ID><AllowedOrigin>https://OTHER-HOST-HERE</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedHeader>*</AllowedHeader><MaxAgeSeconds>42</MaxAgeSeconds></CORSRule></CORSConfiguration>');
  await cors('--cors-origin','https://third-host-here');assert.equal(corsPuts,3);assert.ok(corsXml.includes('unrelated&amp;rule')&&corsXml.includes('<MaxAgeSeconds>42</MaxAgeSeconds>'));
  const savedCors=corsXml;
  for(const failure of ['denied','unsupported']){corsMode=failure;const n=requests;await assert.rejects(cors(),/HTTP (403|501)/);assert.equal(requests,n+1);assert.equal(corsPuts,3);}
  corsMode='denied';events=[];await assert.rejects(call('--configure-cors','--cors-origin',origin),/403/);assert.deepEqual(events,['GET:cors']);
  corsMode='mismatch';await assert.rejects(cors('--cors-origin','https://fourth-host-here'),/mismatch/);assert.equal(corsPuts,4);
  corsMode='';corsXml=savedCors;events=[];
  await call('--configure-cors','--cors-origin',origin,'--dry-run');assert.equal(events[0],'GET:cors');assert.ok(events.indexOf('GET:cors')<events.findIndex(x=>x.startsWith('HEAD:source')));assert.equal(corsPuts,4);
  corsXml=null;events=[];await call('--configure-cors','--cors-origin',origin);assert.ok(events.indexOf('PUT:cors')<events.findIndex(x=>x.startsWith('HEAD:source')));assert.equal(corsPuts,5);
  target=null;puts=0;sourceGets=0;targetGets=0;
  await call('--dry-run','--verify-full');assert.equal(puts,0);assert.equal(sourceGets,0);assert.equal(targetGets,0);
  await call();assert.deepEqual(target,audio);assert.equal(puts,1);assert.equal(sourceGets,1);assert.equal(targetGets,0);
  target[5]^=1;await call('--source-api');assert.equal(puts,1);assert.equal(sourceGets,1);assert.equal(targetGets,0); // size-only resume deliberately skips same-size corruption
  await assert.rejects(call('--verify-full'),/Destination differs/);
  const writes=puts;
  await assert.rejects(call('--verify-full','--overwrite'),/Destination differs/);assert.equal(puts,writes);
  target=Buffer.from('OggSdifferent');await call();assert.equal(puts,writes);
  await call('--overwrite');assert.equal(puts,writes); // existing key always skipped, even differing length
  target=null;mode='corrupt';await assert.rejects(call('--verify-full'),/integrity mismatch/);
  mode='target-head-error';await assert.rejects(call(),/503/);
  mode='target-length';await call();assert.equal(puts,writes+1);
  mode='length';await assert.rejects(call(),/Content-Length/);
  mode='404';await assert.rejects(call(),/404/);mode='';
  target=null;conditional=true;await call('--conditional-put');assert.deepEqual(target,audio);conditional=false;
  const before=requests;await assert.rejects(call('--concurrency=0'),/concurrency/);assert.equal(requests,before);
  await assert.rejects(call('--concurrency','wat'),/concurrency/);
  target=null;events=[];await writeFile(join(dir,'src/lib/data.json'),JSON.stringify({recordings:[{clips:[{opus:name},{opus:'second.opus'}]}]}));
  await call('--concurrency=1','--overwrite');assert.ok(events.indexOf('PUT:target')<events.indexOf('HEAD:source:second.opus'));
  assert.deepEqual(await readdir(dir),['src']);
  const cfg={ep:'https://s3.amazonaws.com',region:'us-east-1',bucket:'examplebucket',ak:'AKIAIOSFODNN7EXAMPLE',sk:'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',prefix:'',key:'test.txt',ttl:86400,method:'GET',now:new Date('2013-05-24T00:00:00Z')};
  const signed=new URL(presign(cfg));assert.equal(signed.host,'examplebucket.s3.amazonaws.com');
  assert.equal(signed.searchParams.get('X-Amz-Signature'),'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  const unicode=new URL(presign({...cfg,key:name}));assert.equal(decodeURIComponent(unicode.pathname),'/'+name);
  await writeFile(join(dir,'src/lib/data.json'),JSON.stringify({recordings:[{clips:[{opus:'../bad.opus'}]}]}));await assert.rejects(call(),/Unsafe/);
  console.log('migration tests passed');
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
