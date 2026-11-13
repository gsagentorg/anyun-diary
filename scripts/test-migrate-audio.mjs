import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, presign } from './migrate-audio.mjs';
const dir=await mkdtemp(join(tmpdir(),'audio-migration-'));
const name='中文 space.opus', audio=Buffer.from('OggShello streamed audio');
let target=null,puts=0,mode='',requests=0;
const server=createServer(async(req,res)=>{
  requests++;const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/api/audio-url'){res.writeHead(302,{location:'/audio/'+encodeURIComponent(name)});res.end();return;}
  if(u.pathname.startsWith('/audio/')){
    assert.equal(decodeURIComponent(u.pathname.slice(7)),name);
    if(mode==='404'){res.writeHead(404);res.end();return;}
    res.writeHead(200,mode==='length'?{}:{'content-length':audio.length});res.end(req.method==='HEAD'?undefined:audio);return;
  }
  if(req.method==='PUT'){puts++;const chunks=[];for await(const c of req)chunks.push(c);target=Buffer.concat(chunks);if(mode==='corrupt')target[5]^=1;res.end();return;}
  if(!target){res.writeHead(404);res.end();return;}res.writeHead(200,{'content-length':target.length});res.end(target);
});
try{
  await mkdir(join(dir,'src/lib'),{recursive:true});await writeFile(join(dir,'src/lib/data.json'),JSON.stringify({recordings:[{clips:[{opus:name}]}]}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  const env={SOURCE_AUDIO_BASE:base,AUDIO_S3_ENDPOINT:base,AUDIO_S3_REGION:'test',AUDIO_S3_BUCKET:'bucket',AUDIO_S3_ACCESS_KEY_ID:'YOUR-ACCESS-HERE',AUDIO_S3_SECRET_ACCESS_KEY:'YOUR-SECRET-HERE',AUDIO_S3_PATH_STYLE:'1'};
  const call=(...args)=>run(['transfer',...args],env,dir);
  await call('--dry-run');assert.equal(puts,0);
  await call();assert.deepEqual(target,audio);assert.equal(puts,1);
  await call('--source-api');assert.equal(puts,1); // resume checks full target
  target=Buffer.from('OggSdifferent');await assert.rejects(call(),/Destination differs/);assert.equal(puts,1);
  await call('--overwrite');assert.deepEqual(target,audio);
  target=null;mode='corrupt';await assert.rejects(call(),/integrity mismatch/);
  mode='length';await assert.rejects(call(),/Content-Length/);
  mode='404';await assert.rejects(call(),/404/);mode='';
  const before=requests;await assert.rejects(call('--concurrency=0'),/concurrency/);assert.equal(requests,before);
  await assert.rejects(call('--concurrency','wat'),/concurrency/);
  assert.deepEqual(await readdir(dir),['src']);
  const cfg={ep:'https://s3.amazonaws.com',region:'us-east-1',bucket:'examplebucket',ak:'AKIAIOSFODNN7EXAMPLE',sk:'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',prefix:'',key:'test.txt',ttl:86400,method:'GET',now:new Date('2013-05-24T00:00:00Z')};
  const signed=new URL(presign(cfg));assert.equal(signed.host,'examplebucket.s3.amazonaws.com');
  assert.equal(signed.searchParams.get('X-Amz-Signature'),'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  const unicode=new URL(presign({...cfg,key:name}));assert.equal(decodeURIComponent(unicode.pathname),'/'+name);
  await writeFile(join(dir,'src/lib/data.json'),JSON.stringify({recordings:[{clips:[{opus:'../bad.opus'}]}]}));await assert.rejects(call(),/Unsafe/);
  console.log('migration tests passed');
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
