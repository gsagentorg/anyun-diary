import assert from 'node:assert/strict';
// Reuse SDK mock publication setup, then test the actual application readers.
import './test-s3-storage.mjs';
import {s3Store} from '../src/lib/server/storage.mjs';
import {publishMonths,digest} from '../src/lib/server/publisher.mjs';
import {readCatalog,readMonth} from '../src/lib/server/catalog.ts';
import {searchStream} from '../src/lib/server/search-stream.ts';
import {monthId,monthBounds,queryMonths} from '../src/lib/server/months.mjs';
const env={S3_REGION:'YOUR-REGION-HERE',S3_BUCKET:'YOUR-BUCKET-HERE',S3_ACCESS_KEY_ID:'YOUR-KEY-HERE',S3_SECRET_ACCESS_KEY:'YOUR-SECRET-HERE'},objects=new Map();
const store=s3Store(env,{async send(c){const i=c.input;if(c.constructor.name==='PutObjectCommand'){objects.set(i.Key,Buffer.from(i.Body));return {};}if(!objects.has(i.Key))throw {$metadata:{httpStatusCode:404}};return {Body:{transformToByteArray:async()=>objects.get(i.Key)}};}});
const now=Date.now()/1000,id=monthId(now),key='audio/'+digest('OggSfixture')+'.opus';await store.write(key,'OggSfixture');const row={id:'fixture',file:'fixture',opus:key,title:'S3 search fixture',startAt:monthBounds(id).startAt+1,monthId:id,duration:1,lyrics:[]};const first=await publishMonths([row],store,{now});await publishMonths([{...row,title:'New version'}],store,{now});
const fixed=await readCatalog(store,undefined,first.revision);assert.equal((await readMonth(store,fixed.months[0])).audios[0].title,row.title);assert.equal((await readCatalog(store)).revision===first.revision,false);const stream=await new Response(searchStream(store,queryMonths(fixed.months,now,2),'fixture')).text();assert(stream.includes('fixture'));console.log('S3 application readers/search use fixed immutable release passed');
