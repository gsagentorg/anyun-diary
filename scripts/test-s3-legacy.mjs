import assert from 'node:assert/strict';
import {s3Options,s3ObjectKey} from '../src/lib/server/s3-store.mjs';
import {s3Store} from '../src/lib/server/storage.mjs';
import {resolveAudioDelivery,audioResponse} from '../src/lib/server/audio-delivery.mjs';
import {publishMonths,rollbackRelease,digest} from '../src/lib/server/publisher.mjs';
import {monthId,monthBounds} from '../src/lib/server/months.mjs';
const legacy={CATALOG_STORAGE:'s3',AUDIO_S3_ENDPOINT:'https://example.invalid',AUDIO_S3_REGION:'YOUR-REGION-HERE',AUDIO_S3_BUCKET:'YOUR-BUCKET-HERE',AUDIO_S3_ACCESS_KEY_ID:'YOUR-KEY-HERE',AUDIO_S3_SECRET_ACCESS_KEY:'YOUR-SECRET-HERE',AUDIO_S3_KEY_PREFIX:'old/audio/',AUDIO_S3_URL_TTL_SECONDS:'3600',S3_PREFIX:'catalog/v2'};
const bytes=Buffer.from('OggSlegacy'),hash=digest(bytes),key='audio/'+hash+'.opus',physical='objects/'+hash+'.opus';
for(const style of ['0','1']){const o=s3Options({...legacy,AUDIO_S3_PATH_STYLE:style});assert.equal(o.clientOptions.forcePathStyle,style==='1');assert.equal(s3ObjectKey(o,key),physical);assert.equal(s3ObjectKey(o,'current.json'),'catalog/v2/current.json');}
for(const style of ['true','false','1','0'])assert.equal(s3Options({...legacy,AUDIO_S3_PATH_STYLE:'1',S3_FORCE_PATH_STYLE:style}).clientOptions.forcePathStyle,['true','1'].includes(style));
for(const field of ['ENDPOINT','REGION','BUCKET','ACCESS_KEY_ID','SECRET_ACCESS_KEY','SESSION_TOKEN']){const o=s3Options({...legacy,['AUDIO_S3_'+field]:'YOUR-OLD-HERE',['S3_'+field]:field==='ENDPOINT'?'https://example.invalid':'YOUR-NEW-HERE'});const actual=field==='BUCKET'?o.bucket:field==='REGION'?o.clientOptions.region:field==='ENDPOINT'?o.clientOptions.endpoint:o.clientOptions.credentials[{ACCESS_KEY_ID:'accessKeyId',SECRET_ACCESS_KEY:'secretAccessKey',SESSION_TOKEN:'sessionToken'}[field]];assert.equal(actual,field==='ENDPOINT'?'https://example.invalid':'YOUR-NEW-HERE');}
assert.throws(()=>s3Options({...legacy,S3_ACCESS_KEY_ID:''}),/Missing/);
for(const prefix of ['../','/root/','a//b/','a%2fb/','a\\b/'])assert.throws(()=>s3Options({...legacy,S3_AUDIO_KEY_PREFIX:prefix}));
assert.equal(s3ObjectKey(s3Options({...legacy,S3_AUDIO_KEY_PREFIX:'existing/'}),key),'existing/'+hash+'.opus');
let signed;const resolve={s3Client:{},now:()=>1000,signS3:async(c,command,o)=>{signed={i:command.input,o};return 'https://example.invalid/signed';}};
await resolveAudioDelivery(legacy,key,resolve);assert.equal(signed.i.Key,physical);assert.equal(signed.o.expiresIn,3600);assert.equal(signed.i.Range,undefined);
await resolveAudioDelivery({...legacy,S3_URL_TTL_SECONDS:'120'},key,resolve);assert.equal(signed.o.expiresIn,120);
await resolveAudioDelivery({...legacy,S3_URL_TTL_SECONDS:'120',AUDIO_URL_TTL_SECONDS:'60'},key,resolve);assert.equal(signed.o.expiresIn,60);
assert.equal((await resolveAudioDelivery({...legacy,S3_AUDIO_PUBLIC_BASE:'https://example.invalid/bucket'},key)).url,'https://example.invalid/bucket/'+physical);
const objects=new Map([[physical,bytes],['manifest.json',Buffer.from('legacy-directory-pointer')]]),calls=[];
const client={async send(c){const i=c.input;calls.push(c);if(c.constructor.name==='PutObjectCommand'){objects.set(i.Key,Buffer.from(i.Body));return {};}if(!objects.has(i.Key))throw {$metadata:{httpStatusCode:404}};return {Body:{transformToByteArray:async()=>objects.get(i.Key)}};}};
const store=s3Store(legacy,client),now=Date.now()/1000,id=monthId(now),row={id:'fixture',file:'fixture',opus:key,title:'Fixture',startAt:monthBounds(id).startAt+1,monthId:id,duration:1,lyrics:[]};
const first=await publishMonths([row],store,{now});await publishMonths([{...row,title:'Changed'}],store,{now});await rollbackRelease(store,first.revision);
assert.equal(objects.get('manifest.json').toString(),'legacy-directory-pointer');assert.deepEqual(objects.get(physical),bytes);assert(!calls.some(c=>c.constructor.name==='PutObjectCommand'&&c.input.Key.includes(hash+'.opus')));assert(calls.filter(c=>c.constructor.name==='PutObjectCommand').every(c=>c.input.Key.startsWith('catalog/v2/')));
for(const status of [403,416])assert.equal((await s3Store(legacy,{send:async()=>{throw {$metadata:{httpStatusCode:status}};}}).read(key)).status,status);
const response=await audioResponse({...legacy,S3_BUCKET:''},key,new Request('https://example.invalid'));assert.equal(response.status,503);assert.equal(await response.text(),'');
console.log('legacy S3: aliases/explicit precedence/style/TTL, stable objects mapping, separate data root, public/private signing, publish/references/rollback without audio PUT or legacy pointer overwrite passed');
