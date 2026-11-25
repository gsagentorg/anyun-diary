import { acquireCachedAudio, hasCachedAudioSync, invalidateCachedAudio, prepareWebAudio, primeWebAudioCacheIndex } from './web-audio-cache.ts';

/** Ephemeral delivery state only; the queue continues to own the stable audio key.
 *  Web 离线缓存（docs/web-offline-cache.md）：换源前先查完整缓存命中（Blob URL 直接播，无需在线 resolve）；
 *  未命中走原有 resolve 流程，成功后才在后台发起完整下载——完成时由缓存层广播「本曲可离线」。
 *  原生壳（App）的音频走稳定 HTTPS，由 AVPlayer 自己查磁盘且不经本包装（ensureAudio 只在 web 分支 attach）。 */
 export function attachAudioRenewal(a: HTMLAudioElement, identity: () => string, fail: (message:string)=>void) {
 primeWebAudioCacheIndex(); // 预热缓存索引：让后续换曲能同步判定命中、彻底跳过 resolve 请求。
 const play=a.play.bind(a),pause=a.pause.bind(a),load=a.load.bind(a);
 let stable='',resolved='',expiresAt:number|null=null,epoch=0,intent=false,replacing=false,attempts=0,pending:Promise<void>|undefined,controller:AbortController|undefined,blob:{url:string,release:()=>void}|null=null;
 const stableSource=()=>{const raw=a.getAttribute?.('src')||a.src||'';if(/\/api\/audio\/[a-f0-9]{64}\.opus$/.test(raw))return raw;try{const u=new URL(raw);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash&&/\.(?:opus|ogg|oga|mp3|m4a|aac|wav|weba|flac)$/i.test(u.pathname)?raw:'';}catch{return '';}};
 const expired=()=>expiresAt!==null&&Date.now()+5000>=expiresAt;
 const valid=(v:number,id:string)=>v===epoch&&id===identity();
 async function renew(force=false) {
  const next=stableSource();if(next&&next!==resolved&&next!==stable){stable=next;expiresAt=null;attempts=0;}
  if(!stable||(!force&&resolved&& !expired()))return;
  if(pending)return pending;if(expired()&&!a.error)attempts=0;if(attempts>=2)throw Error('音频地址更新失败，请重新选播');
  const version=epoch,id=identity();attempts++;controller=new AbortController();const myController=controller;
  const swap=async(url:string)=>{
   const position=Number.isFinite(a.currentTime)?a.currentTime:0;const rate=a.playbackRate,volume=a.volume,muted=a.muted;replacing=true;pause();a.src=url;load();
   await new Promise<void>((resolve,reject)=>{const done=()=>{clean();resolve();},bad=()=>{clean();reject(Error('音频加载失败'));},clean=()=>{a.removeEventListener('loadedmetadata',done);a.removeEventListener('error',bad);clearTimeout(timer);};const timer=setTimeout(bad,15000);a.addEventListener('loadedmetadata',done,{once:true});a.addEventListener('error',bad,{once:true});});
   if(!valid(version,id))return false;
   a.playbackRate=rate;a.volume=volume;a.muted=muted;if(position>0)a.currentTime=position;return true;
  };
  pending=(async()=>{
   // Legacy direct public audio has no resolve endpoint, but can still be cached.
   if(!/\/api\/audio\/[a-f0-9]{64}\.opus$/.test(stable)){
    const prepared=await prepareWebAudio(stable,{signal:myController.signal});
    if(!valid(version,id)){prepared.release();return;}
    resolved=prepared.url;expiresAt=null;
    if(prepared.cached){if(await swap(prepared.url)){const previous=blob;blob=prepared;previous?.release();}else prepared.release();}
    else prepared.release();
    return;
   }
   // ① 先发起同步可见的探测准备：索引/Blob 注册表已知命中时完全不碰网络；否则立即启动 resolve fetch
   //   （保持调用方对「play 同步发出首个请求」的既有语义），后台并行查缓存，命中则中止该请求、改用 Blob。
   const cachedPromise=acquireCachedAudio(stable).catch(()=>null);
   const startResolve=()=>{const c=new AbortController();let timedOut=false;myController.signal.addEventListener('abort',()=>c.abort(),{once:true});
    const t=setTimeout(()=>{timedOut=true;c.abort();},12000);
    const p=fetch(stable+'?resolve=1',{cache:'no-store',signal:c.signal}).catch(error=>{if(timedOut&&(error as DOMException)?.name==='AbortError')throw Error('音频地址更新超时');throw error;}).finally(()=>clearTimeout(t));
    void p.catch(()=>{}); return {promise:p,controller:c};};
   let attempt=hasCachedAudioSync(stable)?null:startResolve();
   const handle=await cachedPromise;
   if(handle){
    if(attempt){void attempt.promise.catch(()=>{});attempt.controller.abort();attempt=null;}
    if(!valid(version,id)){handle.release();return;}
    let served=false;
    try{served=await swap(handle.url);}catch{/* 缓存条目读坏/加载失败 → 丢弃后落回在线路径 */}
    if(served&&valid(version,id)){const previous=blob;blob=handle;previous?.release();resolved=handle.url;expiresAt=null;attempts=0;return;}
    handle.release();await invalidateCachedAudio(stable).catch(()=>{});
    if(!valid(version,id))return;
    attempt=startResolve();
   }
   // ② 在线 resolve（有超时/abort 上限，防后台挂起）。
   if(!attempt)attempt=startResolve();
   try{
    const response=await attempt.promise;
    if(!response.ok)throw Error('音频地址更新失败');const value=await response.json();if(typeof value.url!=='string'||!(value.expiresAt===null||Number.isFinite(value.expiresAt)))throw Error('音频地址无效');if(!valid(version,id))return;
    const url=new URL(value.url,location.href);if(!['https:','http:'].includes(url.protocol))throw Error('音频地址无效');
    expiresAt=value.expiresAt;resolved=url.href;
    if(!await swap(url.href))return;
    // ③ 播放链路已就绪，才在后台发起完整下载；去重与并发上限在缓存层内部；换曲（本 epoch 的 controller 被 abort）自动取消。
    void prepareWebAudio(stable,{signal:myController.signal}).then(prepared=>prepared.release()).catch(()=>{});
   } finally {attempt=null;}
  })().finally(()=>{if(version===epoch){replacing=false;pending=undefined;}});return pending;
 }
 a.load=()=>{epoch++;controller?.abort();pending=undefined;replacing=false;stable=stableSource();resolved='';expiresAt=null;attempts=0;intent=false;if(blob){const stale=blob;blob=null;stale.release();}load();};
 a.pause=()=>{intent=false;pause();};
 a.play=()=>{intent=true;if(!stable|| (resolved&&!expired()&&!pending))return play();const version=epoch,id=identity();return renew().then(()=>{if(valid(version,id)&&intent)return play();}).catch(error=>{if((error as DOMException)?.name==='NotAllowedError')intent=false;if((error as DOMException)?.name!=='AbortError')throw error;});};
 let progress=0;a.addEventListener('timeupdate',()=>{if(!replacing&&a.currentTime>progress+5){attempts=0;progress=a.currentTime;}});
 a.addEventListener('seeking',()=>{if(!replacing&&expired())void recover();});
 a.addEventListener('error',()=>{if(replacing)return;if(expiresAt!==null){void recover();return;}
  // Blob 源中途报错（如缓存条目损坏）：作废该条目并落回在线恢复；attempts 上限防循环。
  if(blob&&resolved===blob.url){const broken=blob,version=epoch,id=identity();blob=null;void ((async()=>{broken.release();await invalidateCachedAudio(stable).catch(()=>{});if(valid(version,id)){resolved='';void recover();}})());}});
 async function recover(){const id=identity(),version=epoch;try{await renew(true);if(valid(version,id)&&intent)await play();}catch(e){if(!valid(version,id)||(e as DOMException)?.name==='AbortError')return;if((e as DOMException)?.name==='NotAllowedError')intent=false;
  // 用户已暂停（intent=false）时后台重试失败不是「当前播放失败」：不出声、不复活横幅。
  if(!intent)return;fail((e as Error).message||'音频恢复失败');}}
 return {renew,inspect:()=>({stable,expiresAt,attempts,fromCache:blob!==null})};
}
