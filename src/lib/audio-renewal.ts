/** Ephemeral delivery state only; the queue continues to own the stable audio key. */
export function attachAudioRenewal(a: HTMLAudioElement, identity: () => string, fail: (message:string)=>void) {
 const play=a.play.bind(a),pause=a.pause.bind(a),load=a.load.bind(a);
 let stable='',resolved='',expiresAt:number|null=null,epoch=0,intent=false,replacing=false,attempts=0,pending:Promise<void>|undefined,controller:AbortController|undefined;
 const stableSource=()=>{const raw=a.getAttribute?.('src')||a.src||'';return /\/api\/audio\/[a-f0-9]{64}\.opus$/.test(raw)?raw:'';};
 const expired=()=>expiresAt!==null&&Date.now()+5000>=expiresAt;
 const valid=(v:number,id:string)=>v===epoch&&id===identity();
 async function renew(force=false) {
  const next=stableSource();if(next&&next!==resolved&&next!==stable){stable=next;expiresAt=null;attempts=0;}
  if(!stable||(!force&&resolved&& !expired()))return;
  if(pending)return pending;if(expired()&&!a.error)attempts=0;if(attempts>=2)throw Error('音频地址更新失败，请重新选播');
  const version=epoch,id=identity();attempts++;controller=new AbortController();
  pending=(async()=>{const response=await fetch(stable+'?resolve=1',{cache:'no-store',signal:controller!.signal});if(!response.ok)throw Error('音频地址更新失败');const value=await response.json();if(typeof value.url!=='string'||!(value.expiresAt===null||Number.isFinite(value.expiresAt)))throw Error('音频地址无效');if(!valid(version,id))return;
   const url=new URL(value.url,location.href);if(!['https:','http:'].includes(url.protocol))throw Error('音频地址无效');
   const position=Number.isFinite(a.currentTime)?a.currentTime:0;expiresAt=value.expiresAt;resolved=url.href;const rate=a.playbackRate,volume=a.volume,muted=a.muted;replacing=true;pause();a.src=resolved;load();
   await new Promise<void>((resolve,reject)=>{const done=()=>{clean();resolve();},bad=()=>{clean();reject(Error('音频加载失败'));},clean=()=>{a.removeEventListener('loadedmetadata',done);a.removeEventListener('error',bad);clearTimeout(timer);};const timer=setTimeout(bad,15000);a.addEventListener('loadedmetadata',done,{once:true});a.addEventListener('error',bad,{once:true});});
   if(!valid(version,id))return;a.playbackRate=rate;a.volume=volume;a.muted=muted;if(position>0)a.currentTime=position;
  })().finally(()=>{if(version===epoch){replacing=false;pending=undefined;}});return pending;
 }
 a.load=()=>{epoch++;controller?.abort();pending=undefined;replacing=false;stable=stableSource();resolved='';expiresAt=null;attempts=0;intent=false;load();};
 a.pause=()=>{intent=false;pause();};
 a.play=()=>{intent=true;if(!stable|| (resolved&&!expired()&&!pending))return play();const version=epoch,id=identity();return renew().then(()=>{if(valid(version,id)&&intent)return play();}).catch(error=>{if((error as DOMException)?.name==='NotAllowedError')intent=false;if((error as DOMException)?.name!=='AbortError')throw error;});};
 let progress=0;a.addEventListener('timeupdate',()=>{if(!replacing&&a.currentTime>progress+5){attempts=0;progress=a.currentTime;}});
 a.addEventListener('seeking',()=>{if(!replacing&&expired())void recover();});
 a.addEventListener('error',()=>{if(!replacing&&expiresAt!==null)void recover();});
 async function recover(){const id=identity(),version=epoch;try{await renew(true);if(valid(version,id)&&intent)await play();}catch(e){if(!valid(version,id)||(e as DOMException)?.name==='AbortError')return;if((e as DOMException)?.name==='NotAllowedError')intent=false;fail((e as Error).message||'音频恢复失败');}}
 return {renew,inspect:()=>({stable,expiresAt,attempts})};
}
