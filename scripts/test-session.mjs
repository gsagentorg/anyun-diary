import assert from 'node:assert/strict';
const store = new Map();
const ls = { getItem:k=>store.get(k)??null, setItem:(k,v)=>store.set(k,String(v)), removeItem:k=>store.delete(k) };
globalThis.window={localStorage:ls,addEventListener(){},removeEventListener(){}};
globalThis.document={addEventListener(){},removeEventListener(){},visibilityState:'visible'};
Object.defineProperty(globalThis,'navigator',{value:{mediaSession:{setActionHandler(){},setPositionState(){}}},configurable:true});
globalThis.MediaMetadata=class {};
globalThis.Audio=class extends EventTarget { paused=true;currentTime=0;duration=100;src='';load(){} play(){this.paused=false;return Promise.resolve()} pause(){this.paused=true} removeAttribute(){this.src=''} };
// Test-only vite runner stubs the runtime environment; no real storage/network.
const { ViteNodeRunner } = await import('vite-node/client');
const original = ViteNodeRunner.prototype.dependencyRequest;
ViteNodeRunner.prototype.dependencyRequest = function(id, fsPath, callstack) {
  if (id === '$env/dynamic/public' || String(fsPath).includes('env/dynamic/public')) return Promise.resolve({env:{}});
  return original.call(this,id,fsPath,callstack);
};
let nativeMode=false; let nativeState; let nativeUpdate; const nativeSyncs=[]; const nativeCommands=[];
class NativeStub extends EventTarget {
  constructor(config,update){super();this.config=config;nativeUpdate=update;this.paused=false;this.currentTime=19;this.ready=Promise.resolve().then(()=>{update(nativeState);return nativeState;});}
  refresh(){return Promise.resolve();} sync(){nativeSyncs.push(structuredClone(this.config()));return Promise.resolve();}
  clear(cfg){nativeSyncs.push(structuredClone(cfg));return Promise.resolve();}
  command(action){nativeCommands.push(action);return Promise.resolve();}
  // Media-element surface used by clearQueue/stopCurrent (the real adapter has the same three).
  pause(){this.paused=true;nativeCommands.push('pause');} load(){} removeAttribute(){}
}
const stubbed = ViteNodeRunner.prototype.dependencyRequest;
ViteNodeRunner.prototype.dependencyRequest = function(id,fsPath,callstack) {
  if (String(id).endsWith('/native-audio') || String(fsPath).endsWith('/native-audio.ts')) return Promise.resolve({NativeAudio:NativeStub,usesNativeAudio:()=>nativeMode});
  return stubbed.call(this,id,fsPath,callstack);
};
const m=await import('../src/lib/player.svelte.ts');
const audio=id=>({id,file:id+'.wav',opus:id+'.opus',title:id,startAt:1700000000,duration:100,lyrics:[],monthId:'2023-11'});
const [a,b,c]=['a','b','c'].map(audio);
// Every queue-growth path shares the byte guard; failure preserves current/history.
const oversized={...a,id:'large',lyrics:[{t:0,text:'字'.repeat(1100000)}]};
for(const change of [()=>m.adopt([m.makeTrack(oversized)],0),()=>m.prependTracks([oversized]),()=>m.playAudio(oversized)]){
 const before=JSON.stringify({queue:m.player.playlist,pos:m.player.pos,history:m.player.history});change();assert.equal(JSON.stringify({queue:m.player.playlist,pos:m.player.pos,history:m.player.history}),before);assert.match(m.player.error,/缩小日期范围/);
}
const medium={...a,id:'medium',lyrics:[{t:0,text:'字'.repeat(600000)}]};m.adopt([m.makeTrack(medium)],0);
const once=JSON.stringify({queue:m.player.playlist,pos:m.player.pos,history:m.player.history});m.prependTracks([medium]);assert.equal(JSON.stringify({queue:m.player.playlist,pos:m.player.pos,history:m.player.history}),once,'repeated insertion also rejects atomically');
m.player.playlist=[];m.player.pos=-1;m.player.track=null;m.player.history=[];m.player.shuffleRedo=[];m.player.error='';
m.playAudio(a);m.playAudio(b);m.playAudio(a);
assert.deepEqual(m.player.playlist.map(t=>t.audio.id),['a','b']);assert.equal(m.player.pos,0);
m.prependTracks([a,c]);assert.deepEqual(m.player.playlist.map(t=>t.audio.id),['a','c','a','b']);assert.equal(m.player.pos,0);
assert.equal(new Set(m.player.playlist.map(t=>t.queueEntryId)).size,4);
m.player.history=[2,3];m.player.shuffleRedo=[1];const history=m.player.history.map(i=>m.player.playlist[i].queueEntryId);m.moveTrack(2,0);
assert.deepEqual(m.player.history.map(i=>m.player.playlist[i].queueEntryId),history);
m.player.history=[1,2];m.removeAt(1);assert.deepEqual(m.player.history,[1]);
const queue=m.player.playlist.map(t=>JSON.parse(JSON.stringify(t)));
store.set('anyun-session-v2',JSON.stringify({v:2,queue,cur:1,t:42,rate:1.25}));m.__resetSessionGuardForTest();m.setPlayerCatalog([]);
assert.equal(m.player.pos,1);assert.equal(m.player.track.queueEntryId,queue[1].queueEntryId);assert.equal(m.getAudio().paused,true);assert.equal(m.player.playlist.length,queue.length);
assert.equal(m.player.track.audio.monthId,'2023-11');
// Migration reads only supplied blocks and preserves the original bytes.
const fresh = () => { store.clear(); m.player.playlist=[]; m.player.track=null; m.player.pos=-1; m.__resetSessionGuardForTest(); };
fresh();
const late=audio('late-month'); late.monthId='2024-01';
const legacy=JSON.stringify({v:1,queue:[a.file,late.opus,a.file],cur:2,t:37,rate:1.5,shuffle:true,history:[0,1],redo:[2],played:['a']});
store.set('anyun-session-v1',legacy);
m.setPlayerCatalog([a]);
assert.equal(store.get('anyun-session-v1'),legacy);
assert.equal(store.has('anyun-session-v2'),false,'missing month must not produce a shortened snapshot');
assert.equal(m.player.playlist.length,0);
m.sleep.until=Date.now()+60000; const until=m.sleep.until;
m.setPlayerCatalog([late]);
assert.equal(m.player.playlist.length,3);
assert.equal(m.player.pos,2,'duplicate current entry keeps its position');
assert.equal(new Set(m.player.playlist.map(t=>t.queueEntryId)).size,3);
assert.deepEqual(m.player.history,[0,1]);assert.deepEqual(m.player.shuffleRedo,[2]);
assert.equal(m.getAudio().paused,true);assert.equal(m.sleep.until,until);
assert.equal(store.get('anyun-session-v1'),legacy);
const migrated=store.get('anyun-session-v2');
late.title='mutated source';m.setPlayerCatalog([late]);
assert.equal(store.get('anyun-session-v2'),migrated,'migration happens once');
assert.notEqual(m.player.playlist[1].audio.title,late.title,'snapshot is independent');
fresh();store.set('anyun-session-v1',legacy);
store.set('anyun-session-v2',migrated);m.setPlayerCatalog([a]);
assert.equal(store.get('anyun-session-v2'),migrated,'v2 wins over v1');
assert.equal(m.player.playlist.length,3);
fresh();store.set('anyun-session-v1',JSON.stringify({v:1,queue:[{recFile:'recording',clipFile:'clip.wav'}],cur:0,t:0}));
m.setPlayerCatalog([{...audio('structured'),file:'recording/clip.wav'}]);
assert.equal(m.player.playlist[0].audio.id,'structured');
fresh();nativeMode=true;
const nativeTrack=m.makeTrack(audio('native-owned'));
nativeState={queue:[{id:nativeTrack.queueEntryId,audio:nativeTrack.audio}],pos:0,history:[0],redo:[0],played:['native-owned'],shuffle:true,skipSame:true,rate:1.2,playing:true,loading:false,error:'',sleepRevision:'owned',sleepUntil:Date.now()+90000,sleepStarted:Date.now(),sleepMode:'gentle',afterTrack:false,sleepFired:false};
store.set('anyun-session-v1',legacy);store.set('anyun-session-v2',migrated);
m.setPlayerCatalog([a]);await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(m.player.track.audio.id,'native-owned','native queue wins over both web snapshots');
assert.equal(m.player.playing,true);assert.equal(m.sleep.until,nativeState.sleepUntil);
assert.deepEqual(m.player.history,[0]);assert.deepEqual(m.player.shuffleRedo,[0]);
assert.equal(store.get('anyun-session-v2'),migrated);
nativeUpdate({...nativeState,shuffle:false,repeatOne:true});
assert.equal(m.player.mode,'repeat-one','native cold restoration retains repeat-one instead of replacing it with sequential');
nativeUpdate({...nativeState,shuffle:false,repeatOne:false});
assert.equal(m.player.mode,'sequential','native sequential snapshot clears stale repeat-one UI');
nativeUpdate({...nativeState,shuffle:true,repeatOne:false});
assert.equal(m.player.mode,'random','native random snapshot wins over non-random flags');
// Real old Swift state: no audio snapshot and duplicate ids; snapshot() strips lyrics.
const oldItem={id:'duplicate',url:'https://audio.example/legacy.opus',title:'Legacy song',key:'Legacy song',clipDuration:91};
nativeState={...nativeState,queue:[oldItem,{...oldItem}],pos:1,playing:false,loading:false,position:43};
nativeUpdate(nativeState);
assert.equal(m.player.playlist.length,2);
assert.equal(new Set(m.player.playlist.map(t=>t.queueEntryId)).size,2);
const oldIds=m.player.playlist.map(t=>t.queueEntryId);
assert.equal(m.player.track.audio.opus,oldItem.url);
assert.equal(m.player.track.audio.title,oldItem.title);
assert.equal(m.player.track.audio.duration,91);
assert.equal(m.player.track.audio.startAt,undefined);
assert.equal(m.player.track.audio.monthId,undefined);
assert.deepEqual(m.player.track.audio.lyrics,[],'old Swift summary has no lyrics to invent');
assert.equal(m.player.playing,false,'external pause remains paused');
nativeUpdate({...nativeState,pos:0,playing:true,history:[1],redo:[],position:54});
assert.deepEqual(m.player.playlist.map(t=>t.queueEntryId),oldIds,'duplicate entry identity survives progress/advance events');
assert.equal(m.player.pos,0);assert.equal(m.player.playing,true);assert.deepEqual(m.player.history,[1]);
m.scheduleSessionSave();
assert.equal(nativeSyncs.at(-1).queue.length,2,'sync cannot erase a restored old queue');
assert.equal(nativeSyncs.at(-1).queue[1].url,oldItem.url);
assert.equal(nativeSyncs.at(-1).queue[0].id,oldItem.id,'sync preserves native currentID so settings do not reload/pause background audio');
const syncCount=nativeSyncs.length;
nativeUpdate({...nativeState,queue:[{id:'unmapped'}]});
m.scheduleSessionSave();
assert.equal(nativeSyncs.length,syncCount,'incomplete mapping blocks native configure');
// issue #25 真机：UI 上有当前曲时点清空，必须同时发 pause 并推空队列（不能只暂停+归零）。
assert.ok(m.player.track,'precondition: a current track is loaded before clear');
const cmdsBefore=nativeCommands.length, syncsBefore=nativeSyncs.length;
m.clearQueue();
assert.ok(nativeCommands.slice(cmdsBefore).includes('pause'),'explicit clear sends pause to native');
assert.equal(nativeSyncs.at(-1).queue.length,0,'explicit clear pushes an empty queue to native from a populated state');
assert.equal(nativeSyncs.length>syncsBefore,true,'explicit clear performs a native configure');
assert.equal(m.player.playlist.length,0,'explicit clear empties the web queue');
assert.equal(m.player.track,null,'explicit clear drops the current track');
m.player.track=null;m.player.pos=-1;m.clearQueue();
assert.equal(nativeSyncs.at(-1).queue.length,0,'explicit user clear permits replacing an unmapped queue');
console.log('session: snapshots, duplicate identity, history/redo, atomic legacy migration, delayed months and v2 priority passed');process.exit(0);
