/** Run with vite-node. Isolated clock/audio/storage; no media, network or real catalog. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Capacitor } from '@capacitor/core';
import { DEFAULT_SLEEP_CUSTOM as defaults, SLEEP_CUSTOM_VERSION, SLEEP_CUSTOM_FIELDS, validateSleepCustom, sleepCustomSnapshot, parseSleepCustom, sleepCustomWindow, sleepGain, sleepCurvePoint, sleepCurvePath, sleepStage } from '../src/lib/sleep-curves.ts';
import { SleepAudio } from '../src/lib/sleep-audio.ts';
let checks = 0;
const ok = (v, message) => { assert.ok(v, message); checks++; };
const near = (a,b, message, tolerance=1e-12) => ok(Math.abs(a-b) < tolerance, message);
const parameterSets = [];
for (const holdPercent of [0,30,90]) for (const endDb of [-60,-24,0]) for (const exponent of [.25,2,4]) for (const tailPercent of [0,10,30]) parameterSets.push({holdPercent,endDb,exponent,tailPercent});
for (const p of parameterSets) {
  let previous=1;
  const window=sleepCustomWindow(p);
  ok(window.fade >= .049999 && window.tail <= (1-window.hold)/2, 'overlap reserves fade');
  for (let i=0;i<=2000;i++) {
    const t=i/2000, gain=sleepGain('custom', t, p);
    ok(Number.isFinite(gain) && gain >= 0 && gain <= previous+1e-12 && gain <= 1, 'bounded monotone custom grid');
    previous=gain;
    if (t <= window.hold) near(gain,1,'hold unity');
  }
  near(sleepGain('custom',1-window.tail-1e-10,p),10**(p.endDb/20),'end dB before tail',1e-7);
  ok(sleepGain('custom',1,p) === 0, 'deadline zero');
  if (!p.tailPercent) ok(sleepGain('custom',1-1e-10,p) > .0009,'no tail stays audible to cut');
  for(let i=0;i<=60;i++) {
    const point=sleepCurvePoint('custom',i/60,p);
    ok(sleepCurvePath('custom',p).includes((i ? 'L' : 'M')+point.x+','+point.y),'preview and marker same formula');
  }
}
for(const t of [NaN,Infinity,-Infinity,-1]) near(sleepGain('custom',t),1,'invalid progress safe');
for(const p of [null,[],{},true, {...defaults,holdPercent:'30'}, {...defaults,endDb:NaN}, {...defaults,exponent:Infinity}, {...defaults,tailPercent:-1}, {...defaults,holdPercent:91}, {...defaults,exponent:0}, {...defaults,endDb:1}]) {
  ok(validateSleepCustom(p) === null,'strict invalid rejected');
  assert.deepEqual(sleepCustomSnapshot(p), defaults); checks++;
}
for(const raw of [null,'{','[]','null','true',JSON.stringify({version:2,parameters:defaults}),JSON.stringify({version:1,parameters:{...defaults,exponent:'2'}})]) { assert.deepEqual(parseSleepCustom(raw), defaults); checks++; }
assert.deepEqual(parseSleepCustom(JSON.stringify({version:1,parameters:parameterSets[0]})),parameterSets[0]); checks++;
near(sleepCustomWindow({ ...defaults, holdPercent:90,tailPercent:30 }).tail,.05,'overlap explicit clamp');
ok(sleepStage('custom',.1,defaults)==='保持音量' && sleepStage('custom',.95,defaults)==='归零尾段','custom stages');
let now=100000;
Date.now=()=>now;
const timers=new Map();let timerId=0;
globalThis.setInterval=fn=>{timers.set(++timerId,fn);return timerId;};
globalThis.clearInterval=id=>timers.delete(id);
const storage=new Map();
globalThis.window={localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},addEventListener(){}};
globalThis.document={hidden:false,visibilityState:'visible',addEventListener(){}};
Object.defineProperty(globalThis,'navigator',{value:{mediaSession:{setActionHandler(){},setPositionState(){}}},configurable:true});
const events=[];
class AudioStub {
  crossOrigin='anonymous'; paused=true; volume=.7; currentTime=0; duration=120; src=''; listeners=new Map();
  addEventListener(type,fn){const all=this.listeners.get(type)??[];all.push(fn);this.listeners.set(type,all);}
  removeEventListener(){} load(){} removeAttribute(){} setAttribute(){}
  pause(){events.push('pause');this.paused=true;for(const fn of this.listeners.get('pause')??[])fn();}
  play(){this.paused=false;for(const fn of this.listeners.get('play')??[])fn();return Promise.resolve();}
}
globalThis.Audio=AudioStub;globalThis.MediaMetadata=class {};
const curves=[];
const param={value:1,cancelScheduledValues(){},setValueAtTime(v){events.push('gain:'+v);this.value=v;},linearRampToValueAtTime(v){this.value=v;},setValueCurveAtTime(values,time,duration){curves.push({values,duration});this.value=values[0];}};
let context;
class Context {
  state='running';currentTime=0;destination={};constructor(){context=this;}
  resume(){this.state='running';return Promise.resolve();}
  createGain(){return {gain:param,connect(){}};}
  createMediaElementSource(){return {connect(){}};}
}
globalThis.AudioContext=Context;
const { sleep, initSleep, setSleepCustom, resetSleepCustom, setSleepPreset, startSleep, cancelSleep, syncSleep, seekSleepProgress, adjustSleepEnd, getAudio, canStartCustomSleep, onTrackEnded }=await import('../src/lib/player.svelte.ts');
const settle=async()=>{await Promise.resolve();await Promise.resolve();};
const first={holdPercent:20,endDb:-18,exponent:3,tailPercent:15};
setSleepPreset('custom');ok(setSleepCustom(first),'valid edit accepted');
assert.deepEqual(JSON.parse(storage.get('anyun-sleep-custom-v1')),{version:SLEEP_CUSTOM_VERSION,parameters:first});checks++;
first.endDb=-3;ok(sleep.custom.endDb===-18,'editor owns copied value');
startSleep(10);await settle();
const original={...sleep.activeCustom};const deadline=sleep.until;
setSleepCustom({...defaults,exponent:.25});
ok(sleep.activeCustom.endDb===-18 && sleep.custom.endDb===-24,'preview separated from active run');
for(let i=0;i<301;i++) near(curves.at(-1).values[i],sleepGain('custom',i/300,original),'automation uses snapshot',1e-6);
now+=300000;syncSleep();near(param.value,sleepGain('custom',.5,original),'resume formula snapshot',1e-6);
seekSleepProgress(.7);near(param.value,sleepGain('custom',.7,original),'drag uses snapshot',1e-6);
adjustSleepEnd(180);assert.deepEqual(sleep.activeCustom,original);checks++;
resetSleepCustom();assert.deepEqual(sleep.custom,defaults);assert.deepEqual(sleep.activeCustom,original);checks+=2;
setSleepPreset('gentle');ok(sleep.mode==='custom' && sleep.until!==null,'selection is next plan only');
getAudio().pause();await getAudio().play();ok(sleep.until!==null,'pause and resume keep countdown');
context.state='suspended';await getAudio().play();await settle();ok(context.state==='running','interruption recovery resumes context');
events.length=0;now=sleep.until+100000;syncSleep();
ok(sleep.fired && sleep.until===null && getAudio().paused,'late expiry stops');
ok(events.indexOf('pause') < events.indexOf('gain:1'),'stop before restoring normal gain');
setSleepPreset('custom');setSleepCustom({...defaults,tailPercent:0});startSleep(1);await settle();
now=sleep.until-1;syncSleep();ok(!sleep.fired && param.value>0,'cut not early');
now=sleep.until;onTrackEnded();ok(sleep.fired,'deadline before next track');
startSleep(1);await settle();cancelSleep();ok(param.value===1 && sleep.until===null,'cancel restores');
setSleepCustom(original);storage.set('anyun-sleep-custom-v1','{"version":999}');initSleep();assert.deepEqual(sleep.custom,defaults);checks++;
setSleepCustom(original);initSleep();assert.deepEqual(sleep.custom,original);checks++;
ok(!setSleepCustom({...defaults,exponent:'4'}) && sleep.custom.endDb===original.endDb,'bad edit preserves prior plan');
setSleepCustom({...defaults,holdPercent:0});startSleep(2);await settle();ok(sleep.activeCustom.holdPercent===0,'restart snapshots latest');
storage.set('anyun-sleep-custom-v1','bad');initSleep();ok(sleep.activeCustom.holdPercent===0,'restoring next plan never mutates running');
cancelSleep();
const platform=Capacitor.getPlatform;Capacitor.getPlatform=()=> 'ios';
sleep.supportsCustomSleep=null;ok(!canStartCustomSleep(),'unknown shell unsupported');
sleep.until=now+100000;sleep.started=now;const untouched=sleep.until;
startSleep(1);ok(sleep.until===untouched && sleep.notice.includes('更新'),'old shell refuses without destroying active timer');
sleep.supportsCustomSleep=false;ok(!canStartCustomSleep(),'old shell unsupported');
sleep.supportsCustomSleep=true;ok(canStartCustomSleep(),'advertised custom supported');
Capacitor.getPlatform=platform;cancelSleep();
delete globalThis.AudioContext;
const audio=new AudioStub();const fallback=new SleepAudio(audio);await fallback.prepare();
for(let i=0;i<=100;i++) {fallback.tick('custom',i/100,original);near(audio.volume,.7*sleepGain('custom',i/100,original),'fallback uses same formula');}
fallback.restore();near(audio.volume,.7,'fallback restores');
const editor=readFileSync(new URL('../src/lib/components/SleepCurveEditor.svelte',import.meta.url),'utf8');
ok(editor.includes('type="range"') && editor.includes('type="number"') && editor.includes('{#each SLEEP_CUSTOM_FIELDS'),'four paired accessible controls');
for(const f of SLEEP_CUSTOM_FIELDS) ok(f.label.length>0,'labels defined');
ok(editor.includes('aria-label=') && editor.includes('恢复默认参数') && editor.includes('sleepCurvePath(\'custom\', parameters)'),'editor preview/reset contracts');
console.log('sleep-custom: '+checks+' assertions passed (clock/audio/storage mocks; browser runs only with --browser; no Swift execution)');

// Optional real Chromium component/Player-state behavior, isolated Vite middleware.
// Uses no app build, server config, dependencies installation, media or catalog.
if (process.argv.includes('--browser')) {
  const { PLAYWRIGHT_MODULE, CHROMIUM_PATH } = process.env;
  assert.ok(PLAYWRIGHT_MODULE && CHROMIUM_PATH, 'browser mode requires existing Playwright/Chromium');
  const { chromium } = await import(PLAYWRIGHT_MODULE);
  const { createServer } = await import('vite');
  const { svelte } = await import('@sveltejs/vite-plugin-svelte');
  const { compile } = await import('svelte/compiler');
  const { createServer: httpServer } = await import('node:http');
  const { fileURLToPath } = await import('node:url');
  const root=fileURLToPath(new URL('../',import.meta.url));
  const harness = '<script>import Editor from "/src/lib/components/SleepCurveEditor.svelte"; import {sleep, initSleep, setSleepCustom, resetSleepCustom, setSleepPreset, startSleep, cancelSleep} from "/src/lib/player.svelte.ts"; import {sleepCurvePath} from "/src/lib/sleep-curves.ts"; initSleep(); window.fixture={sleep,startSleep,cancelSleep,setSleepPreset};</script><Editor parameters={sleep.custom} onchange={setSleepCustom} onreset={resetSleepCustom} running={sleep.until !== null}/><button onclick={()=>{setSleepPreset("custom"); startSleep(10)}}>Fixture start</button><svg data-active><path d={sleepCurvePath(sleep.mode,sleep.activeCustom)}/></svg>';
  const vite=await createServer({root,configFile:false,plugins:[svelte({configFile:false}),{
    name:'sleep-harness',resolveId(id){if(id==='$env/dynamic/public')return '\0sleep-env';if(id==='/__sleep.svelte')return '\0sleep-harness';},
    load(id){if(id==='\0sleep-env')return 'export const env = {};';if(id==='\0sleep-harness')return compile(harness,{filename:root+'/src/lib/SleepFixture.svelte',generate:'client',dev:true}).js.code;}
  }],optimizeDeps:{include:['@capacitor/core']},server:{middlewareMode:true,hmr:false},appType:'custom'});
  const server=httpServer((req,res)=>{
    if(req.url==='/') {res.setHeader('content-type','text/html'); void vite.transformIndexHtml('/', '<!doctype html><div id="app"></div><script type="module">import {mount} from "svelte"; import Harness from "/__sleep.svelte"; mount(Harness,{target:document.querySelector("#app")});</script>').then(html=>res.end(html)); return;}
    vite.middlewares(req,res,()=>{res.statusCode=404;res.end();});
  });
  let browser;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({executablePath:CHROMIUM_PATH,headless:true,args:['--no-sandbox']});
    const context=await browser.newContext({serviceWorkers:'block'});
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin ? route.continue() : route.abort());
    const page=await context.newPage();page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',error=>{errors.push(error.message); console.error('browser pageerror:', error.stack);}); page.on('console',m=>{if(m.type()==='error')console.error('browser console:',m.text());});
    await page.goto(origin);
    await page.locator('[data-sleep-editor]').waitFor();
    assert.equal(await page.getByRole('slider').count(),4);
    assert.equal(await page.getByRole('spinbutton').count(),4);
    const preview=page.locator('[data-sleep-custom-preview] path').last();
    const originalPath=await preview.getAttribute('d');
    const hold=page.getByRole('slider',{name:'保持原音量（%）滑块',exact:true});
    await hold.focus();await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('spinbutton',{name:'保持原音量（%）数值',exact:true}).inputValue(),'31');
    assert.notEqual(await preview.getAttribute('d'),originalPath);
    await page.getByRole('spinbutton',{name:'渐弱终点（dB）数值',exact:true}).fill('-12');
    await page.getByRole('button',{name:'Fixture start'}).click();
    const active=page.locator('[data-active] path');const runningPath=await active.getAttribute('d');
    await page.getByRole('spinbutton',{name:'渐弱终点（dB）数值',exact:true}).fill('-36');
    assert.equal(await active.getAttribute('d'),runningPath);
    assert.notEqual(await preview.getAttribute('d'),runningPath);
    assert.ok((await page.locator('legend').textContent()).includes('下次启动'));
    await page.getByRole('button',{name:'恢复默认参数'}).click();
    assert.equal(await active.getAttribute('d'),runningPath);
    assert.equal(await page.getByRole('spinbutton',{name:'保持原音量（%）数值',exact:true}).inputValue(),'30');
    const exponentInput=page.getByRole('spinbutton',{name:'下降指数数值',exact:true});
    const safePreview=await preview.getAttribute('d');
    await exponentInput.fill('9');
    assert.equal(await preview.getAttribute('d'),safePreview);
    await hold.focus();
    assert.equal(await exponentInput.inputValue(),'2');
    await exponentInput.fill('');
    await hold.focus();
    assert.equal(await exponentInput.inputValue(),'2');
    await page.getByRole('spinbutton',{name:'保持原音量（%）数值',exact:true}).fill('90');
    await page.getByRole('spinbutton',{name:'归零尾段（%）数值',exact:true}).fill('30');
    assert.ok((await page.locator('[aria-live=polite]').textContent()).includes('归零 5.0%'));
    await page.getByRole('button',{name:'恢复默认参数'}).click();
    await page.getByRole('button',{name:'Fixture start'}).click();
    assert.equal(await active.getAttribute('d'),await preview.getAttribute('d'));
    await page.reload();await page.locator('[data-sleep-editor]').waitFor();
    assert.equal(await page.getByRole('spinbutton',{name:'渐弱终点（dB）数值',exact:true}).inputValue(),'-24');
    await page.evaluate(()=>localStorage.setItem('anyun-sleep-custom-v1','{"version":1,"parameters":{"endDb":999}}'));
    await page.reload();await page.locator('[data-sleep-editor]').waitFor();
    assert.equal(await page.getByRole('spinbutton',{name:'渐弱终点（dB）数值',exact:true}).inputValue(),'-24');
    assert.deepEqual(errors,[]);
    console.log('sleep-custom browser: actual Chromium 4x range/number, keyboard edit, live SVG, next-vs-active snapshot, reset/restart, reload/bad-storage passed (isolated component harness, not full App/iPhone)');
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));await vite.close();}
}
