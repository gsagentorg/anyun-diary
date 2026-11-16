import {env} from '$env/dynamic/private';
import {json} from '@sveltejs/kit';
import {readCatalog} from '$lib/server/catalog';
import {queryMonths,maxQueryMonths} from '$lib/server/months.mjs';
import {configuredStore} from '$lib/server/storage.mjs';
import type {RequestHandler} from './$types';
export const prerender=false;
export const GET:RequestHandler=async({request})=>{try{const m=await readCatalog(configuredStore(env),AbortSignal.any([request.signal,AbortSignal.timeout(15000)]));const allowed=new Set(queryMonths(m.months,Date.now()/1000,maxQueryMonths(env.MAX_QUERY_MONTHS)).map((v:{id:string})=>v.id));return json({...m,months:m.months.map(v=>({...v,available:v.available&&allowed.has(v.id)}))},{headers:{'cache-control':'no-store'}});}catch{return json({error:'Catalog unavailable'},{status:503});}};
