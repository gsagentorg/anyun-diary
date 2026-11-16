import {readFile,mkdir,writeFile,rename,unlink} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
export function validKey(key){if(typeof key!=='string'||! /^(manifest\.json|months\/\d{4}-(0[1-9]|1[0-2])\/[a-f0-9]{64}\.json|audio\/[a-f0-9]{64}\.opus)$/.test(key))throw Error('Invalid storage key');return key;}
export function localStore(root){const path=key=>resolve(root,validKey(key));return {
 async read(key,{signal}={}){signal?.throwIfAborted();try{return new Response(await readFile(path(key),{signal}));}catch(e){if(e.code==='ENOENT')return new Response(null,{status:404});throw e;}},
 async write(key,bytes){const target=path(key);await mkdir(dirname(target),{recursive:true});const temp=target+'.'+randomUUID()+'.tmp';try{await writeFile(temp,bytes);await rename(temp,target);}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}},
 async remove(key){await unlink(path(key)).catch(e=>{if(e.code!=='ENOENT')throw e;});}
};}
export function blobStore({baseUrl,token,fetcher=fetch,sdk}){const base=new URL(baseUrl);if(!['https:','http:'].includes(base.protocol)||base.username||base.password||base.search||base.hash)throw Error('Invalid Blob base');const url=key=>new URL(validKey(key),base.href.replace(/\/?$/,'/')).href;return {
 read(key,{signal}={}){return fetcher(url(key),{signal,cache:'no-store',redirect:'error'});},
 async write(key,bytes,type='application/json'){const api=sdk??await import('@vercel/blob');await api.put(validKey(key),bytes,{token,access:'public',addRandomSuffix:false,allowOverwrite:true,contentType:type,cacheControlMaxAge:key==='manifest.json'?60:31536000});},
 async remove(key){const api=sdk??await import('@vercel/blob');await api.del(url(key),{token});}
};}
export function configuredStore(env){if(!env.CATALOG_STORAGE||env.CATALOG_STORAGE==='local')return localStore(env.CATALOG_LOCAL_DIR||'.diary-data');if(env.CATALOG_STORAGE==='blob'&&env.BLOB_BASE_URL)return blobStore({baseUrl:env.BLOB_BASE_URL,token:env.BLOB_READ_WRITE_TOKEN});throw Error('Unsupported catalog storage');}
