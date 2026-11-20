import {S3Client,GetObjectCommand,PutObjectCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
// Never include configuration values or SDK errors in browser-visible responses/logs.
export function s3Options(env){
 const pick=(name,legacy)=>env[name]!==undefined?env[name]:env[legacy];
 const values={};for(const field of ['ENDPOINT','REGION','BUCKET','ACCESS_KEY_ID','SECRET_ACCESS_KEY','SESSION_TOKEN'])values[field]=pick('S3_'+field,'AUDIO_S3_'+field);
 for(const field of ['REGION','BUCKET','ACCESS_KEY_ID','SECRET_ACCESS_KEY'])if(!values[field]?.trim())throw Error('Missing S3 configuration: S3_'+field+' (or AUDIO_S3_'+field+')');
 const prefix=env.S3_PREFIX??'';
 if(prefix&&!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\/?$/.test(prefix))throw Error('Invalid S3_PREFIX');
 const style=pick('S3_FORCE_PATH_STYLE','AUDIO_S3_PATH_STYLE');
 if(style!==undefined&&!['true','false','1','0'].includes(style))throw Error('Invalid S3_FORCE_PATH_STYLE / AUDIO_S3_PATH_STYLE');
 if(values.ENDPOINT){try{const u=new URL(values.ENDPOINT);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error();}catch{throw Error('Invalid S3_ENDPOINT');}}
 // ebbddc0 immutable objects bypassed AUDIO_S3_KEY_PREFIX entirely.
 const legacy=env.AUDIO_S3_KEY_PREFIX!==undefined||['ENDPOINT','REGION','BUCKET','ACCESS_KEY_ID','SECRET_ACCESS_KEY'].some(f=>env['AUDIO_S3_'+f]!==undefined);
 const audioPrefix=env.S3_AUDIO_KEY_PREFIX??(legacy?'objects/':prefix.replace(/\/$/,'')+(prefix?'/':'')+'audio/');
 if(audioPrefix&&!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\/$/.test(audioPrefix))throw Error('Invalid S3_AUDIO_KEY_PREFIX');
 return {bucket:values.BUCKET,prefix:prefix.replace(/\/$/,'')+(prefix?'/':''),audioPrefix,clientOptions:{region:values.REGION,...(values.ENDPOINT?{endpoint:values.ENDPOINT}:{}),forcePathStyle:['true','1'].includes(style),credentials:{accessKeyId:values.ACCESS_KEY_ID,secretAccessKey:values.SECRET_ACCESS_KEY,...(values.SESSION_TOKEN?{sessionToken:values.SESSION_TOKEN}:{})}}};
}
export function s3ObjectKey(options,key){if(/^audio\/[a-f0-9]{64}\.opus$/.test(key))return options.audioPrefix+key.slice(6);return options.prefix+key;}
export function objectCacheControl(key){if(key.startsWith('brand/'))return 'public, max-age=600, must-revalidate';return ['current.json','manifest.json'].includes(key)?'no-cache, max-age=0, must-revalidate':'public, max-age=31536000, immutable';}
export function createS3Store(options,validKey,client=new S3Client(options.clientOptions)){
 const object=key=>({Bucket:options.bucket,Key:s3ObjectKey(options,validKey(key))});
 return {
 async read(key,{signal,range}={}){signal?.throwIfAborted();if(range&&!/^bytes=(?:\d+-\d*|-\d+)$/.test(range))throw Error('Invalid byte range');try{
 const value=await client.send(new GetObjectCommand({...object(key),...(range?{Range:range}:{})}),{abortSignal:signal});
 const headers=new Headers();for(const [field,header]of [['ContentType','content-type'],['ContentLength','content-length'],['ContentRange','content-range'],['CacheControl','cache-control'],['ETag','etag'],['AcceptRanges','accept-ranges']])if(value[field]!==undefined)headers.set(header,String(value[field]));
 if(value.LastModified)headers.set('last-modified',value.LastModified.toUTCString());
 const bytes=value.Body?await value.Body.transformToByteArray():new Uint8Array();signal?.throwIfAborted();return new Response(bytes,{status:value.ContentRange?206:200,headers});
 }catch(e){if(signal?.aborted)signal.throwIfAborted();const status=e.$metadata?.httpStatusCode;if(status===404||e.name==='NoSuchKey')return new Response(null,{status:404});if([403,416].includes(status))return new Response(null,{status});throw Error('S3 read failed');}},
 async write(key,bytes,type='application/json'){try{await client.send(new PutObjectCommand({...object(key),Body:bytes,ContentType:type,CacheControl:objectCacheControl(key)}));}catch{throw Error('S3 write failed');}},
 async remove(key){try{await client.send(new DeleteObjectCommand(object(key)));}catch{throw Error('S3 remove failed');}}
 };
}
