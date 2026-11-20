#!/usr/bin/env node
// 品牌图发布：把仓库 assets/brand/ 下的头像/封面上传到「当前配置的存储」（local / blob / s3），
// 键为 brand/<file>，与运行时同源 /brand/<file> 路由、S3/BLOB 适配器共用同一条白名单。
// 复用既有发布纪律：只写内容变化的键，写后复读摘要校验；校验失败即中止，不自动重试。
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {configuredStore} from '../src/lib/server/storage.mjs';
import {BRAND_CONTENT_TYPES,brandKey} from '../src/lib/server/brand.mjs';

const MAGIC = {'avatar.png':Buffer.from('89504e470d0a1a0a','hex'),'cover.jpg':Buffer.from('ffd8ff','hex')};

export function digest(bytes){return createHash('sha256').update(bytes).digest('hex');}

function validImage(file,bytes){
  const magic=MAGIC[file];
  return Boolean(bytes?.length)&&bytes.subarray(0,magic.length).equals(magic);
}

export async function publishBrand(store,files){
  const results=[];
  for(const file of Object.keys(BRAND_CONTENT_TYPES)){
    const bytes=files[file];
    if(!validImage(file,bytes))throw Error('Invalid brand image bytes: '+file);
    const key=brandKey(file),existing=await store.read(key);
    if(existing.status===404)await store.write(key,bytes,BRAND_CONTENT_TYPES[file]);
    else if(!existing.ok)throw Error('Brand object unavailable: '+file);
    else{const current=Buffer.from(await existing.arrayBuffer());if(digest(current)!==digest(bytes))await store.write(key,bytes,BRAND_CONTENT_TYPES[file]);}
    const check=await store.read(key);
    if(!check.ok||digest(Buffer.from(await check.arrayBuffer()))!==digest(bytes))throw Error('Brand verification failed: '+file);
    results.push({key,bytes:bytes.length,digest:digest(bytes)});
  }
  return results;
}

export async function run(args=process.argv.slice(2),env=process.env){
  let dir=join(dirname(fileURLToPath(import.meta.url)),'..','assets','brand');
  for(let i=0;i<args.length;i++){
    if(args[i]!=='--dir'||!args[i+1]||args[i+1].startsWith('--'))throw Error('Usage: [--dir DIRECTORY]');
    dir=args[++i];
  }
  const store=configuredStore(env),files={};
  for(const file of Object.keys(BRAND_CONTENT_TYPES))files[file]=await readFile(join(dir,file));
  console.log(JSON.stringify({brand:await publishBrand(store,files)}));
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))run().catch(()=>{console.error('Brand publish failed; storage objects are unchanged unless the failure happened after a write (re-read brand/<file> before retrying).');process.exitCode=1;});