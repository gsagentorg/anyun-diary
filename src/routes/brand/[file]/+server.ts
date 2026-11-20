import {env} from '$env/dynamic/private';
import {configuredStore} from '$lib/server/storage.mjs';
import {brandResponse} from '$lib/server/brand.mjs';
import type {RequestHandler} from './$types';
export const prerender=false;
// 同源品牌图端点：品牌图是运行时数据（存储 brand/ 前缀），不进构建产物。
// 文件名白名单 + 15s 超时；错误只回状态码，不回显存储配置/错误详情。
export const GET:RequestHandler=async({params,request})=>{if(!/^(?:avatar\.png|cover\.jpg)$/.test(params.file))return new Response('Not found',{status:404,headers:{'cache-control':'no-store'}});try{return await brandResponse(configuredStore(env),params.file,{signal:AbortSignal.any([request.signal,AbortSignal.timeout(15000)])});}catch{return new Response(null,{status:503,headers:{'cache-control':'no-store'}});}};