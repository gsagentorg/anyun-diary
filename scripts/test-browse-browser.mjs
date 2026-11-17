import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core');
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox']});
const dir=process.env.SCREENSHOT_DIR??process.env.HOME+'/.openclaw/workspace/artifacts/anyun-browse-regression';await mkdir(dir,{recursive:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[],requests=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text()+' '+m.location().url);});page.on('request',r=>{if(r.url().includes('/api/month/'))requests.push(new URL(r.url()).pathname);});
try{
await page.goto(process.env.TEST_URL??'http://127.0.0.1:5173');await page.waitForSelector('[data-month] [role=button]');await page.waitForTimeout(1200);
const initial=[...requests];assert.equal(new Set(initial).size,1,'first screen only newest month');
assert.equal(await page.locator('select[aria-label="浏览月份"]').count(),0);
await page.screenshot({path:dir+'/timeline.png',fullPage:true});
await page.mouse.wheel(0,900);await page.waitForTimeout(1200);
const afterBottom=[...requests];assert.ok(new Set(afterBottom).size>1,'bottom requests older month');
const anchor=await page.locator('[data-month]').first().evaluate(el=>el.getBoundingClientRect().top+scrollY);
await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));await page.waitForTimeout(1200);
assert.equal(await page.locator('[data-month]').first().evaluate(el=>el.getBoundingClientRect().top+scrollY),anchor,'append preserves previous content position');
for(const [label,name] of [['日卡片','days'],['热力图','heatmap']]){await page.evaluate(()=>scrollTo(0,0));await page.getByRole('tab',{name:label,exact:true}).click();await page.waitForTimeout(700);assert.equal(await page.getByRole('button',{name:/上一页|下一页|较早七天/}).count(),0);if(name==='heatmap'){assert.equal(await page.locator('[data-heat-scroll]').count(),1);assert.equal(await page.getByText('点击格子装载当天播放列表',{exact:true}).count(),1);}if(name==='heatmap')assert.equal(await page.getByRole('button',{name:'近7天',exact:true}).count(),1,'one shared heatmap range panel');if(name==='days'){const expand=page.getByRole('button',{name:'展开或收起当天歌曲'}).first();await expand.click();assert.ok(await page.locator('[data-month] ol li').count()>0);await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));await page.waitForTimeout(500);await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(600);assert.equal(await page.getByRole('button',{name:'展开或收起当天歌曲'}).first().getAttribute('aria-expanded'),'true','day expansion survives unmount');}await page.screenshot({path:dir+'/'+name+'.png',fullPage:true});}
await page.getByRole('tab',{name:'日卡片',exact:true}).click();await page.waitForTimeout(400);assert.equal(await page.getByRole('button',{name:'展开或收起当天歌曲'}).first().getAttribute('aria-expanded'),'true','expanded day survives heatmap roundtrip');await page.locator('[data-month] ol button').first().click();await page.waitForTimeout(500);await page.getByRole('button',{name:'暂停',exact:true}).click();await page.screenshot({path:dir+'/player.png'});await page.getByRole('button',{name:'播放队列',exact:true}).click();await page.waitForTimeout(400);await page.screenshot({path:dir+'/queue.png'});await page.getByRole('button',{name:'关闭',exact:true}).last().click();await page.locator('[title^="点击看歌词"]').click();await page.waitForTimeout(400);await page.screenshot({path:dir+'/lyrics.png'});
await page.getByRole('button',{name:'关闭',exact:true}).last().click();await page.getByLabel('开始日期',{exact:true}).fill('2026-11-16');await page.getByLabel('结束日期',{exact:true}).fill('2026-11-16');await page.waitForTimeout(700);assert.equal(await page.getByRole('button',{name:/^加入队列：/}).count(),10);await page.getByRole('button',{name:/^加入队列：/}).first().click();await page.screenshot({path:dir+'/date-preview.png'});
assert.deepEqual(errors,[]);const report={initial,afterBottom,final:requests,errors,screenshots:dir};await writeFile(dir+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
