import {env} from '$env/dynamic/private';
import {configuredStore} from '$lib/server/storage.mjs';
import {audioResponse} from '$lib/server/audio-delivery.mjs';
import type {RequestHandler} from './$types';
export const GET:RequestHandler=async({params,request})=>audioResponse(env,'audio/'+params.hash,request,{store:(!env.CATALOG_STORAGE||env.CATALOG_STORAGE==='local')?configuredStore(env):undefined});
