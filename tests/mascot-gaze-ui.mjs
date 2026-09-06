import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 await page.goto(process.env.UI_BASE_URL??'http://localhost:3109');
 const art=page.locator('[data-eye-frame]');
 let visibleCases=0,hiddenCases=0;
 for(const percent of [5,20,35,50,65,80,95]){
  await page.locator('[data-drone]').evaluateAll((els,p)=>els.forEach((el,i)=>{el.style.animation='none';el.style.offsetDistance=`${(p+i*9)%100}%`;}),percent);
  const expected=await page.evaluate(()=>{
   const a=document.querySelector('[data-eye-frame]').getBoundingClientRect(), panel=document.querySelector('[data-join-panel]').getBoundingClientRect();
   const x=a.x+a.width/2,y=a.y+a.height/2;
   let hidden=0;
   const candidates=[...document.querySelectorAll('[data-drone]')].flatMap(e=>{
    const b=e.getBoundingClientRect(),cx=b.x+b.width/2,cy=b.y+b.height/2;
    if(b.left<panel.right&&b.right>panel.left&&b.top<panel.bottom&&b.bottom>panel.top){hidden++;return [];}
    if(cx<0||cy<0||cx>innerWidth||cy>innerHeight)return [];
    return [{id:e.dataset.drone,d:(cx-x)**2+(cy-y)**2}];
   }).sort((a,b)=>a.d-b.d);
   return {id:candidates[0]?.id??'',hidden};
  });
  if(expected.id)visibleCases++;hiddenCases+=expected.hidden;
  await page.waitForFunction(id=>document.querySelector('[data-eye-frame]').dataset.targetDrone===id,expected.id);
 }
 assert(visibleCases>0);assert(hiddenCases>0);
 await page.locator('[data-drone]').evaluateAll(els=>els.forEach(e=>{e.style.display='none';}));
 await page.waitForFunction(()=>document.querySelector('[data-eye-frame]').dataset.targetDrone==='');
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.waitForFunction(()=>document.querySelector('[data-eye-frame]').dataset.reducedMotion==='true');
 assert.equal(await art.getAttribute('data-eye-frame'),'open');
 console.log(`PASS: nearest visible target across ${visibleCases} rendered route samples, excluded ${hiddenCases} occluded positions, neutral when no visible drones, reduced motion static.`);
}finally{await browser.close();}
