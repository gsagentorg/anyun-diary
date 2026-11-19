import {readFile,mkdir,writeFile,rename,unlink} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createS3Store,s3Options} from './s3-store.mjs';
export function s3Store(env,client){return createS3Store(s3Options(env),validKey,client);}
export function validKey(key){if(typeof key!=='string'||! /^((?:current|manifest)\.json|releases\/[a-f0-9]{64}\/manifest\.json|months\/\d{4}-(0[1-9]|1[0-2])\/[a-f0-9]{64}\.json|audio\/[a-f0-9]{64}\.opus)$/.test(key))throw Error('Invalid storage key');return key;}
export function localStore(root){const path=key=>resolve(root,validKey(key));return {
 async read(key,{signal}={}){signal?.throwIfAborted();try{return new Response(await readFile(path(key),{signal}));}catch(e){if(e.code==='ENOENT')return new Response(null,{status:404});throw e;}},
 async write(key,bytes){const target=path(key);await mkdir(dirname(target),{recursive:true});const temp=target+'.'+randomUUID()+'.tmp';try{await writeFile(temp,bytes);await rename(temp,target);}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}},
 async remove(key){await unlink(path(key)).catch(e=>{if(e.code!=='ENOENT')throw e;});}
};}
export function blobStore({baseUrl,token,access='public',fetcher=fetch,sdk}){const base=new URL(baseUrl);if(!['https:','http:'].includes(base.protocol)||base.username||base.password||base.search||base.hash)throw Error('Invalid Blob base');const url=key=>new URL(validKey(key),base.href.replace(/\/?$/,'/')).href;return {
 async read(key,{signal}={}){if(access==='private'){const api=sdk??await import('@vercel/blob');if(typeof api.get!=='function')throw Error('Private Blob SDK read unsupported');const result=await api.get(validKey(key),{access:'private',token,abortSignal:signal,useCache:false});return result?new Response(result.stream):new Response(null,{status:404});}return fetcher(url(key),{signal,cache:'no-store',redirect:'error'});},
 async write(key,bytes,type='application/json'){const api=sdk??await import('@vercel/blob');await api.put(validKey(key),bytes,{token,access,addRandomSuffix:false,allowOverwrite:true,contentType:type,cacheControlMaxAge:['current.json','manifest.json'].includes(key)?1:31536000});},
 async remove(key){const api=sdk??await import('@vercel/blob');await api.del(url(key),{token});}
};}
export function configuredStore(env){if(env.CATALOG_STORAGE==='s3')return s3Store(env);if(!env.CATALOG_STORAGE||env.CATALOG_STORAGE==='local')return localStore(env.CATALOG_LOCAL_DIR||'.diary-data');if(env.CATALOG_STORAGE==='blob'&&env.BLOB_BASE_URL)return blobStore({baseUrl:env.BLOB_BASE_URL,token:env.BLOB_READ_WRITE_TOKEN,access:env.BLOB_ACCESS||'public'});throw Error('Unsupported catalog storage');}
