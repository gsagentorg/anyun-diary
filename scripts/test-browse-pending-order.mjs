// Issue #53: while an older month is still loading, its placeholder must live inside the browse flow:
// loaded lanes -> loading block (month label + a row of muted ghost blocks) -> legend. Chromium synthetic fixture only.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {monthBounds,shiftMonthId,monthIdAt} from '../src/lib/month.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??'playwright-core');
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox']});
const dir=process.env.SCREENSHOT_DIR??process.env.HOME+'/.openclaw/workspace/artifacts/anyun-browse-pending';await mkdir(dir,{recursive:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const current=monthIdAt(Date.now()/1000);
const ids=[current,shiftMonthId(current,-1)];
const months=ids.map((id,i)=>({...monthBounds(id),count:i===0?7:4,revision:'fixture-'+i,key:'months/'+id+'.json',available:true}));
const pendingId=ids[1];
const block=m=>({schemaVersion:2,id:m.id,revision:m.revision,audios:Array.from({length:m.count},(_,i)=>({id:m.id+'-'+i,monthId:m.id,file:m.id+'-'+i,opus:'audio/fixture',title:'fixture '+i,startAt:m.startAt+i*86400+3600,duration:60,lyrics:[]}))});
let releasePending;const gate=new Promise(resolve=>{releasePending=resolve;});
await page.route('**/api/current',r=>r.fulfill({headers:{etag:'"fixture"'},json:{schemaVersion:2,releaseId:'fixture'}}));
await page.route('**/api/catalog',r=>r.fulfill({json:{schemaVersion:2,timezone:'Asia/Shanghai',generatedAt:Date.now()/1000,revision:'fixture',queryMonthLimit:0,months}}));
await page.route('**/api/month/*',async r=>{
  const id=new URL(r.request().url()).pathname.split('/').pop();
  const m=months.find(v=>v.id===id);
  if(id===pendingId)await gate; // keep this month pending until the assertions below have run
  return r.fulfill({json:block(m)});
});
const report={};
try{
 await page.goto(process.env.TEST_URL??'http://127.0.0.1:5173');
 await page.waitForSelector('[data-continuous-browse] [role=button]');
 // Reveal the next month block so its placeholder renders while its request is still in flight.
 await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));
 await page.mouse.wheel(0,900);
 await page.waitForSelector('[data-browse-skeleton]',{timeout:8000});
 await page.waitForTimeout(600);
 await page.screenshot({path:dir+'/pending.png',fullPage:true});

 const snap=await page.evaluate(()=>{
  const host=document.querySelector('[data-continuous-browse]');
  const kids=[...host.children];
  const legend=host.querySelector('[data-timeline-legend]');
  const skeleton=host.querySelector('[data-browse-skeleton]');
  const chart=host.querySelector('[data-timeline-container]');
  const label=skeleton.querySelector('[data-browse-skeleton-label]');
  const bars=skeleton.querySelector('[data-browse-skeleton-bars]');
  const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,top:r.top+scrollY,bottom:r.bottom+scrollY,left:r.left+scrollX,right:r.right+scrollX};};
  // Bars column of the loaded lanes: the flex child that is not the w-24 date column.
  const loadedBarsHost=chart.querySelector('.flex > .min-w-0');
  const lanes=[...chart.querySelectorAll('[role=button]')];
  const lastLane=lanes.length?rect(lanes.at(-1)):null;
  return {
   childTags:kids.map(el=>({tag:el.tagName.toLowerCase(),attrs:[...el.attributes].map(a=>a.name).filter(n=>n.startsWith('data-')||n==='aria-hidden'),cls:(el.getAttribute('class')??'').slice(0,40)})),
   chartIndex:kids.indexOf(chart),skeletonIndex:kids.indexOf(skeleton),legendIndex:kids.indexOf(legend),
   skeletonParentIsHost:skeleton.parentElement===host,
   skeletonPrevAriaHidden:skeleton.previousElementSibling?.getAttribute('aria-hidden')===null?false:skeleton.previousElementSibling?.getAttribute('aria-hidden')==='true',
   skeletonNextIsLegend:skeleton.nextElementSibling===legend,
   legendIsLast:legend===host.lastElementChild&&legend.parentElement===host,
   status:{role:skeleton.getAttribute('role'),label:skeleton.getAttribute('aria-label')},
   skeleton:rect(skeleton),chart:rect(chart),legend:rect(legend),
   labelRect:rect(label),barsRect:rect(bars),
   labelText:label.textContent.replace(/\s+/g,' ').trim(),
   blockRects:[...bars.querySelectorAll('[data-browse-skeleton-block]')].map(rect),
   barsColumnLeft:loadedBarsHost?rect(loadedBarsHost).left:null,
   lastLane,
   laneCount:lanes.length,
  };
 });
 report.pending=snap;
 // 1) the placeholder is a child of the browse flow, not a section after it
 assert.ok(snap.skeletonParentIsHost,'pending placeholder must render inside [data-continuous-browse]');
 // 2) DOM order: loaded chart -> pending block -> legend
 assert.ok(snap.chartIndex>=0&&snap.skeletonIndex>snap.chartIndex,'placeholder must come after the loaded timeline');
 assert.ok(snap.legendIndex>snap.skeletonIndex,'legend must follow the pending block, so the block is sandwiched');
 assert.equal(snap.childTags[snap.skeletonIndex].tag,'div');
 assert.ok(snap.skeletonPrevAriaHidden,'pending block sits after the chart tail spacer');
 assert.ok(snap.skeletonNextIsLegend,'pending block is adjacent to the legend');
 assert.ok(snap.legendIsLast,'legend stays the last element of the flow');
 // 3) vertical sandwich, measured in page coordinates
 assert.ok(snap.skeleton.top>=snap.chart.bottom-1,'placeholder starts after the loaded lanes');
 assert.ok(snap.legend.top>=snap.skeleton.bottom-1,'legend stays below the placeholder');
 assert.ok(snap.lastLane&&snap.lastLane.bottom<=snap.skeleton.top+1,'no loaded lane falls inside the placeholder band');
 // 4) month label and its ghost bars are one unit: same row, label left, bars right
 assert.equal(snap.status.role,'status');
 assert.match(snap.status.label,/正在加载/);
 assert.equal(snap.childTags[snap.skeletonIndex].attrs.includes('data-browse-skeleton-lane'),true,'pending block uses the lane layout');
 assert.match(snap.labelText,/^\d{4}-\d{2}\s*加载中…$/,'label carries the pending month id');
 assert.ok(snap.blockRects.length>=4,'placeholder renders a row of muted song blocks');
 // One row, like loaded songs: all blocks share the same top band and song-block height (h-5 = 20px).
 const tops=snap.blockRects.map(b=>b.top);
 assert.ok(Math.max(...tops)-Math.min(...tops)<=2,'ghost blocks sit on a single row, not stacked: tops='+tops.map(Math.round));
 assert.ok(snap.blockRects.every(b=>b.h>=16&&b.h<=24),'ghost blocks use the loaded song-block height: '+snap.blockRects.map(b=>Math.round(b.h)));
 // Varied widths with real gaps between neighbours, and the row does not run full-bleed.
 assert.ok(new Set(snap.blockRects.map(b=>Math.round(b.w))).size>=3,'ghost block widths vary: '+snap.blockRects.map(b=>Math.round(b.w)));
 const gaps=snap.blockRects.slice(1).map((b,i)=>b.left-snap.blockRects[i].right);
 assert.ok(gaps.every(g=>g>=2),'ghost blocks are separated by gaps: '+gaps.map(Math.round));
 assert.ok(snap.blockRects.every(b=>b.left>=snap.barsRect.left-1&&b.right<=snap.barsRect.right+1),'ghost blocks stay inside the bars column');
 assert.ok(snap.barsRect.right-snap.blockRects.at(-1).right>=8,'the ghost row leaves a trailing gap instead of filling the lane');
 assert.ok(Math.abs(snap.labelRect.top-snap.barsRect.top)<snap.skeleton.h,'label and bars share one row');
 assert.ok(snap.labelRect.left<snap.barsRect.left,'label is left of its bars');
 assert.ok(snap.labelRect.bottom<=snap.skeleton.bottom+1&&snap.barsRect.bottom<=snap.skeleton.bottom+1);
 // 5) the placeholder uses the same bars column as the loaded lanes
 assert.ok(Math.abs(snap.barsRect.left-snap.barsColumnLeft)<=2,'ghost bars align with the loaded lane column, left='+snap.barsRect.left+' lane='+snap.barsColumnLeft);

 // 6) once the month arrives the placeholder leaves the flow and the legend stays last
 releasePending();
 await page.waitForFunction(()=>!document.querySelector('[data-browse-skeleton]'));
 await page.waitForTimeout(800);
 const after=await page.evaluate(()=>{
  const host=document.querySelector('[data-continuous-browse]');
  return {legendIsLast:host.querySelector('[data-timeline-legend]')===host.lastElementChild,skeletons:host.querySelectorAll('[data-browse-skeleton]').length,lanes:host.querySelectorAll('[data-timeline-container] [role=button]').length};
 });
 report.after=after;
 assert.equal(after.skeletons,0,'placeholder disappears when the month resolves');
 assert.ok(after.legendIsLast,'legend remains the last element of the flow');
 assert.ok(after.lanes>report.pending.laneCount,'loaded lanes grow into the space the placeholder held');
 assert.deepEqual(errors,[]);
 await page.screenshot({path:dir+'/resolved.png',fullPage:true});
 await writeFile(dir+'/report.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({ok:true,pending:{chartIndex:snap.chartIndex,skeletonIndex:snap.skeletonIndex,legendIndex:snap.legendIndex,labelText:snap.labelText,blockWidths:snap.blockRects.map(b=>Math.round(b.w)),barsLeft:Math.round(snap.barsRect.left),laneLeft:Math.round(snap.barsColumnLeft),skeletonTop:Math.round(snap.skeleton.top),chartBottom:Math.round(snap.chart.bottom),legendTop:Math.round(snap.legend.top)},after,screenshots:dir}));
}finally{await browser.close();}
