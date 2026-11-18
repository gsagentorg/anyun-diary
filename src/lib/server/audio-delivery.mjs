import {S3Client,GetObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {s3Options,s3ObjectKey} from './s3-store.mjs';

export function audioKey(key){if(typeof key!=='string'||!/^audio\/[a-f0-9]{64}\.opus$/.test(key))throw Error('Invalid audio key');return key;}
export function publicAudioUrl(base,key){if(typeof key!=='string'||! /^(?:[A-Za-z0-9_-]+\/)*[a-f0-9]{64}\.opus$/.test(key))throw Error('Invalid public audio key');if(typeof base!=='string'||/%|\\/.test(base))throw Error('Invalid public audio base');const u=new URL(base);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||/%|\\/.test(u.pathname))throw Error('Invalid public audio base');return u.href.replace(/\/+$/,'')+'/'+key;}
export async function resolveAudioDelivery(env,key,{now=Date.now,signS3=getSignedUrl,s3Client,blobSdk}={}){
 audioKey(key);const kind=env.CATALOG_STORAGE||'local';if(kind==='local')return null;
 const ttl=Number(env.AUDIO_URL_TTL_SECONDS??env.S3_URL_TTL_SECONDS??env.AUDIO_S3_URL_TTL_SECONDS??900);if(!Number.isInteger(ttl)||ttl<1||ttl>604800)throw Error('Invalid AUDIO_URL_TTL_SECONDS');
 if(kind==='s3'){const options=s3Options(env);if(env.S3_AUDIO_PUBLIC_BASE)return {url:publicAudioUrl(env.S3_AUDIO_PUBLIC_BASE,s3ObjectKey(options,key)),expiresAt:null};
 const expiresAt=now()+ttl*1000;const url=await signS3(s3Client??new S3Client(options.clientOptions),new GetObjectCommand({Bucket:options.bucket,Key:s3ObjectKey(options,key)}),{expiresIn:ttl,signingDate:new Date(now())});return {url,expiresAt};}
 if(kind==='blob'){const access=env.BLOB_ACCESS||'public';if(access==='public')return {url:publicAudioUrl(env.BLOB_BASE_URL,key),expiresAt:null};if(access!=='private')throw Error('Invalid BLOB_ACCESS');
 const sdk=blobSdk??await import('@vercel/blob');if(typeof sdk.issueSignedToken!=='function'||typeof sdk.presignUrl!=='function')throw Error('Installed Blob SDK does not support private direct GET');
 const expiresAt=now()+ttl*1000;const delegation=await sdk.issueSignedToken({pathname:key,operations:['get'],validUntil:expiresAt,token:env.BLOB_READ_WRITE_TOKEN});const signed=await sdk.presignUrl(delegation,{operation:'get',pathname:key,access:'private',validUntil:expiresAt});return {url:signed.presignedUrl,expiresAt};}
 throw Error('Unsupported audio storage');
}

/** Local bytes only. Remote audio must never enter the storage read path.
 * @param {any} env
 * @param {string} key
 * @param {Request} request
 * @param {{store?: {read: Function}, resolve?: Function}} options
 */
export async function audioResponse(env,key,request,{store=undefined,resolve=resolveAudioDelivery}={}){
 try{audioKey(key);}catch{return new Response(null,{status:404});}
 try{const target=await resolve(env,key);if(new URL(request.url).searchParams.get('resolve')==='1')return Response.json(target??{url:new URL(request.url).pathname,expiresAt:null},{headers:{'cache-control':'private, no-store','referrer-policy':'no-referrer'}});if(target)return new Response(null,{status:307,headers:{location:target.url,'cache-control':'private, no-store','referrer-policy':'no-referrer'}});
 const r=await store.read(key,{signal:request.signal});if(!r.ok)return new Response(null,{status:r.status});const bytes=new Uint8Array(await r.arrayBuffer()),size=bytes.length;const headers={'content-type':'audio/ogg','accept-ranges':'bytes','cache-control':'public,max-age=31536000,immutable'};
 const invalid=()=>new Response(null,{status:416,headers:{'content-range':'bytes */'+size,'accept-ranges':'bytes'}});const range=request.headers.get('range');if(range){const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m||(!m[1]&&!m[2]))return invalid();const first=Number(m[1]),last=Number(m[2]);if((m[1]&&!Number.isSafeInteger(first))||(m[2]&&!Number.isSafeInteger(last))||(!m[1]&&last===0))return invalid();const start=m[1]?first:Math.max(0,size-last),end=m[1]?(m[2]?Math.min(last,size-1):size-1):size-1;if(start>end||start>=size)return invalid();headers['content-range']='bytes '+start+'-'+end+'/'+size;headers['content-length']=String(end-start+1);return new Response(bytes.slice(start,end+1),{status:206,headers});}headers['content-length']=String(size);return new Response(bytes,{headers});
 }catch{return new Response(null,{status:503,headers:{'cache-control':'no-store'}});}
}
