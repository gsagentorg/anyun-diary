import {env} from '$env/dynamic/private';
import {json} from '@sveltejs/kit';
import {readCatalog} from '$lib/server/catalog';
import {configuredStore} from '$lib/server/storage.mjs';
import {queryMonths,maxQueryMonths} from '$lib/server/months.mjs';
import {searchStream} from '$lib/server/search-stream';
import type {RequestHandler} from './$types';
export const prerender=false;
export const GET:RequestHandler=async({url,request})=>{const q=url.searchParams.get('q')?.trim()??'';if(!q||q.length>1000)return json({error:'Query required (maximum 1000 characters)'},{status:400});try{const store=configuredStore(env);const manifest=await readCatalog(store,AbortSignal.any([request.signal,AbortSignal.timeout(15000)]));return new Response(searchStream(store,queryMonths(manifest.months,Date.now()/1000,maxQueryMonths(env.MAX_QUERY_MONTHS)),q,{signal:request.signal}),{headers:{'content-type':'application/x-ndjson; charset=utf-8','cache-control':'no-store','x-accel-buffering':'no'}});}catch{return json({error:'Search unavailable'},{status:503});}};
