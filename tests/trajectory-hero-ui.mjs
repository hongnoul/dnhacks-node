import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const base = process.env.UI_BASE_URL ?? 'http://localhost:3109';
function luminance(rgb) { const c = rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(v => {v/=255; return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;});return .2126*c[0]+.7152*c[1]+.0722*c[2]; }
function contrast(a,b) { const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); }
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(base);
  const logo = page.getByRole('img', { name: 'SkyMesh robot logo in ASCII art' });
  const colors = await logo.evaluate(e => ({fg:getComputedStyle(e).color,bg:getComputedStyle(e.parentElement).backgroundColor,weight:getComputedStyle(e).fontWeight}));
  const logoRatio = contrast(colors.fg,colors.bg);
  assert(logoRatio>=19);assert(Number(colors.weight)>=700);
  const bodyColors=await page.locator('section p').first().evaluate(e=>({fg:getComputedStyle(e).color,bg:getComputedStyle(e.closest('section')).backgroundColor}));
  const bodyRatio=contrast(bodyColors.fg,bodyColors.bg);assert(bodyRatio>=12);
  const hero=page.locator('[data-trajectory-hero]');
  assert.equal(await hero.getAttribute('aria-hidden'),'true');
  assert.equal(await hero.evaluate(e=>getComputedStyle(e).pointerEvents),'none');
  assert.equal(await hero.evaluate(e=>getComputedStyle(e).backgroundSize), '4px 4px');
  assert.match(await hero.evaluate(e=>getComputedStyle(e).backgroundImage), /repeating-conic-gradient/);
  assert(await hero.locator('svg > g[style]').evaluateAll(es=>es.every(e=>getComputedStyle(e).color==='rgb(0, 0, 0)')));
  assert.equal(await hero.locator('path[opacity="0.25"]').count(),4);
  const drones=hero.locator('g[style*="offset-path"]');assert.equal(await drones.count(),4);
  const drone=drones.first();
  const before=await drone.evaluate(e=>getComputedStyle(e).offsetDistance);
  await page.waitForFunction(old=>getComputedStyle(document.querySelector('[data-trajectory-hero] g[style*="offset-path"]')).offsetDistance!==old,before);
  assert.equal(await hero.locator('text').count(),0);
  assert.equal(await page.getByRole('button').count(),1);
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await drone.evaluate(e=>getComputedStyle(e).animationName),'none');
  assert.equal(await page.getByRole('button',{name:'Pause trajectories',exact:true}).isVisible(),false);
  assert(await page.getByRole('button',{name:'Enable microphone & join'}).isVisible());
  if(process.env.JCODE_SCRATCH_DIR)await page.screenshot({path:`${process.env.JCODE_SCRATCH_DIR}/trajectory-hero.png`,fullPage:true});
  console.log(`PASS: logo contrast ${logoRatio.toFixed(2)}:1, body ${bodyRatio.toFixed(2)}:1, four moving drone paths, no background text or controls, reduced motion, decorative nonblocking layer.`);
}finally{await browser.close();}
