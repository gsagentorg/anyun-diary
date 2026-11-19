import {env} from '$env/dynamic/private';
import {json} from '@sveltejs/kit';
import {readCatalog,readMonth} from '$lib/server/catalog';
import {configuredStore} from '$lib/server/storage.mjs';
import {queryMonths,maxQueryMonths} from '$lib/server/months.mjs';
import type {RequestHandler} from './$types';
export const prerender=false;
export const GET:RequestHandler=async({params,request,url})=>{if(!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(params.id))return json({error:'Invalid month'},{status:400});try{const signal=AbortSignal.any([request.signal,AbortSignal.timeout(15000)]),store=configuredStore(env),manifest=await readCatalog(store,signal,url.searchParams.get("release")??undefined);const entry=queryMonths(manifest.months,Date.now()/1000,maxQueryMonths(env.MAX_QUERY_MONTHS)).find((e:{id:string})=>e.id===params.id);if(!entry)return json({error:'Month unavailable'},{status:404});return json(await readMonth(store,entry,signal),{headers:{'cache-control':'no-store'}});}catch{return json({error:'Month unavailable'},{status:503});}};
