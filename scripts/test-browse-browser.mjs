import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core');
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox']});
const dir=process.env.SCREENSHOT_DIR??process.env.HOME+'/.openclaw/workspace/artifacts/anyun-browse-regression';await mkdir(dir,{recursive:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[],requests=[],loadedCounts=new Map();
page.on('response',async r=>{if(new URL(r.url()).pathname.startsWith('/api/month/')&&r.ok()){const block=await r.json();loadedCounts.set(block.id,block.audios.length);}});
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text()+' '+m.location().url);});page.on('request',r=>{if(r.url().includes('/api/month/'))requests.push(new URL(r.url()).pathname);});
try{
await page.goto(process.env.TEST_URL??'http://127.0.0.1:5173');await page.waitForSelector('[data-continuous-browse] [role=button]');await page.waitForTimeout(1200);
const initial=[...requests];assert.equal(new Set(initial).size,1,'first screen only newest month');
assert.equal(await page.locator('select[aria-label="浏览月份"]').count(),0);
await page.screenshot({path:dir+'/timeline.png',fullPage:true});
await page.mouse.wheel(0,900);await page.waitForTimeout(1200);
const afterBottom=[...requests];assert.ok(new Set(afterBottom).size>1,'bottom requests older month');
// Traverse every manifest month before accepting screenshots or legend counts.
for(let i=0;i<10;i++){await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));await page.mouse.wheel(0,900);await page.waitForTimeout(350);}
const catalog=await (await page.request.get((process.env.TEST_URL??'http://127.0.0.1:5173')+'/api/catalog')).json();
assert.equal(new Set(requests).size,catalog.months.filter(m=>m.available).length,'all month blocks requested');
const expected=catalog.months.reduce((n,m)=>n+m.count,0);assert.equal(expected,587,'real full catalog fixture');assert.equal([...loadedCounts.values()].reduce((a,b)=>a+b,0),expected,'all 587 audio entities received across three month blocks');
async function capturePositions(name){
 for(const [position,fraction] of [['top',0],['middle',.5],['bottom',1]]){
  await page.evaluate(v=>scrollTo(0,(document.documentElement.scrollHeight-innerHeight)*v),fraction);await page.waitForTimeout(650);if(fraction===1){await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));await page.waitForTimeout(650);}
  if(name==='heatmap'){assert.equal(await page.locator('[data-heat-controls]').count(),1);assert.equal(await page.locator('[data-heat-legend]').count(),1);await page.locator('[data-heat-scroll]').evaluate((el,v)=>el.scrollLeft=(el.scrollWidth-el.clientWidth)*v,fraction);await page.waitForTimeout(300);}
  if(name==='timeline'){assert.equal(await page.locator('[data-timeline-legend]').count(),1,'one shared legend across >=3 months');assert.equal(await page.locator('[data-continuous-browse] [data-timeline-legend]').count(),0);const box=await page.locator('[data-timeline-legend]').boundingBox();assert.ok(box&&box.y>=0&&box.y+box.height<=900,'legend remains available while scrolling');}
  await page.screenshot({path:dir+'/'+name+'-'+position+'.png'});
 }
}
await capturePositions('timeline');
const anchor=await page.locator('[data-continuous-browse]').first().evaluate(el=>el.getBoundingClientRect().top+scrollY);
await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));await page.waitForTimeout(1200);
assert.equal(await page.locator('[data-continuous-browse]').first().evaluate(el=>el.getBoundingClientRect().top+scrollY),anchor,'append preserves previous content position');
for(const [label,name] of [['日卡片','days'],['热力图','heatmap']]){await page.evaluate(()=>scrollTo(0,0));await page.getByRole('tab',{name:label,exact:true}).click();await page.waitForTimeout(700);assert.equal(await page.getByRole('button',{name:/上一页|下一页|较早七天/}).count(),0);if(name==='heatmap'){assert.equal(await page.locator('[data-heat-scroll]').count(),1);assert.equal(await page.getByText('点击格子装载当天播放列表',{exact:true}).count(),1);}if(name==='heatmap')assert.equal(await page.getByRole('button',{name:'近7天',exact:true}).count(),1,'one shared heatmap range panel');if(name==='days'){const expand=page.getByRole('button',{name:'2026/11/16周一',exact:true});await expand.click();assert.ok(await page.locator('[data-day-grid] ol li').count()>0);await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));await page.waitForTimeout(500);await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(600);assert.equal(await page.getByRole('button',{name:'2026/11/16周一',exact:true}).getAttribute('aria-expanded'),'true','day expansion survives unmount');}await capturePositions(name);await page.screenshot({path:dir+'/'+name+'.png',fullPage:true});}
await page.getByRole('tab',{name:'日卡片',exact:true}).click();await page.waitForTimeout(400);assert.equal(await page.getByRole('button',{name:'2026/11/16周一',exact:true}).getAttribute('aria-expanded'),'true','expanded day survives heatmap roundtrip');await page.locator('[data-day-grid] ol button').first().click();await page.waitForTimeout(500);await page.getByRole('button',{name:'暂停',exact:true}).click();await page.screenshot({path:dir+'/player.png'});await page.getByRole('button',{name:'播放队列',exact:true}).click();await page.waitForTimeout(400);await page.screenshot({path:dir+'/queue.png'});await page.getByRole('button',{name:'关闭',exact:true}).last().click();await page.locator('[title^="点击看歌词"]').click();await page.waitForTimeout(400);await page.screenshot({path:dir+'/lyrics.png'});
await page.getByRole('button',{name:'关闭',exact:true}).last().click();await page.getByLabel('开始日期',{exact:true}).fill('2026-11-16');await page.getByLabel('结束日期',{exact:true}).fill('2026-11-16');await page.waitForTimeout(700);assert.equal(await page.getByRole('button',{name:/^加入队列：/}).count(),10);await page.getByRole('button',{name:/^加入队列：/}).first().click();await page.screenshot({path:dir+'/date-preview.png'});
assert.deepEqual(errors,[]);const report={initial,afterBottom,final:requests,loadedCounts:Object.fromEntries(loadedCounts),errors,screenshots:dir};await writeFile(dir+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
