import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const base=process.env.APP_URL || 'http://localhost:3019';
const browser=await chromium.launch();
try {
for (const route of ['/station/','/?session=hardware-dialog']) {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const requests=[];page.on('request',r=>{if(r.url().includes('skymesh-node.glb'))requests.push(r.url());});
 await page.goto(base+route);
 if(route.startsWith('/?')) {
  // Exercise the supported detector-unavailable path without accessing a real microphone.
  await page.route('**/drone_crnn.onnx',r=>r.abort());
  await page.getByRole('button',{name:'Enable microphone & join'}).click();
  await page.getByRole('region',{name:'SkyMesh sensor window'}).waitFor();
 }
 const launcher=page.getByRole('button',{name:route.startsWith('/station')?'Hardware reference':'skymesh-node.glb',exact:true});
 assert.equal(requests.length,0,'model is not fetched before opening');
 await launcher.click();
 const dialog=page.getByRole('dialog',{name:/Hardware Viewer/});await dialog.waitFor();
 await page.waitForFunction(()=>document.querySelector('dialog canvas') && !document.querySelector('dialog [role="status"]'));
 assert.equal(requests.length,1);
 for(const name of ['Front','Top','Base','Perspective']) { await dialog.getByRole('button',{name,exact:true}).click(); }

 assert.equal(await dialog.locator('header').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(0, 0, 128)');
 await page.getByRole('button',{name:'Radio antenna',exact:false}).click();
 assert(await dialog.getByText(/Proposed LoRa/).isVisible());
 await page.screenshot({path:`${process.env.JCODE_SCRATCH_DIR}/hardware-${route.startsWith('/station')?'operations':'sensor'}.png`,fullPage:true});
 await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});assert.equal(await dialog.count(),0);
 assert(await launcher.evaluate(el=>el===document.activeElement));
 await launcher.click();await dialog.waitFor();
 await page.getByRole('button',{name:'Close hardware viewer'}).click();await dialog.waitFor({state:'detached'});assert.equal(await page.locator('dialog canvas').count(),0);
 await page.setViewportSize({width:390,height:844});await launcher.click();await dialog.waitFor();
 assert(await dialog.evaluate(el=>el.getBoundingClientRect().width<=innerWidth));
 assert(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),'dialog has no horizontal overflow');
 await page.getByRole('button',{name:'Close hardware viewer'}).click();
 if(route.startsWith('/?')) {
  assert.match(page.url(),/session=hardware-dialog/);
  assert(await page.getByRole('region',{name:'SkyMesh sensor window'}).isVisible());
  await page.getByRole('tab',{name:'Diagnostics'}).click();
  assert(await page.getByRole('heading',{name:'Mesh diagnostics'}).isVisible());
 }
 await page.close();
}
console.log('PASS: both dashboard entry points, lazy model load, retro titlebar, component controls, Escape/close, focus restoration, reopen, canvas teardown, mobile dialog layout, sensor session and diagnostics');
} finally {await browser.close();}
