// Public acceptance: the former simulator is now the real participant workspace.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.APP_URL ?? 'http://127.0.0.1:8127';
const session = `unified-${Date.now()}`;
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const errors = [];
  context.on('weberror', e => errors.push(String(e.error())));
  const page = await context.newPage();
  await page.goto(`${base}/operator/?session=${session}`);
  await page.locator('.unified-console').waitFor();
  await page.getByRole('button',{name:'Fit participant area',exact:true}).click();
  assert.match(new URL(page.url()).pathname, /^\/station\/?$/);
  assert(new URL(page.url()).searchParams.get('session') === session);
  const markers = page.locator('.map-card [data-node-id]');
  assert.equal(await markers.count(),0,'empty session has no fabricated sensors');
  const phone = await context.newPage();
  await phone.goto(`${base}/?node=real-phone&session=${session}`);
  await phone.getByRole('button',{name:/Enable microphone & join/i}).click();
  await page.getByRole('button',{name:'admit',exact:true}).waitFor({timeout:60000});
  assert.equal(await markers.count(),0,'pending phone is not yet in admitted topology');
  await page.getByRole('button',{name:'admit',exact:true}).click();
  const marker = page.locator('[data-node-id="real-phone"]');
  await marker.waitFor();
  assert.equal(await markers.count(),1);
  assert.equal(await marker.getAttribute('data-placed'),'false','participant has no invented room position');
  await marker.focus();
  await page.keyboard.press('Enter');
  await page.locator('[data-section=inspector]').getByRole('heading',{name:'real-phone',exact:true}).waitFor();
  await page.getByLabel('Participant to place',{exact:true}).selectOption('real-phone');
  await page.getByRole('button',{name:'place node',exact:true}).click();
  const map = page.locator('.map-card .room-map svg');
  await map.scrollIntoViewIfNeeded();
  let box = await map.boundingBox();
  await map.click({position:{x:box.width*.5,y:box.height*.5}});
  await page.waitForFunction(() => document.querySelector('[data-node-id="real-phone"]')?.getAttribute('data-placed') === 'true');
  await page.waitForFunction(() => {
    const pos = document.querySelector('[data-section=nodes] tbody tr td:nth-child(3)')?.textContent?.split(',').map(Number);
    return pos?.length === 2 && Math.abs(pos[0]-6) < .15 && Math.abs(pos[1]-4) < .15;
  });
  await phone.waitForFunction(() => /[1-9]\d* records held/.test(document.body.innerText));
  assert.equal(await markers.count(),1,'placing assigns the existing participant, never creates a sensor');
  await page.getByRole('button',{name:/simulate drone/i}).click();
  await map.scrollIntoViewIfNeeded();
  box = await map.boundingBox();
  await map.click({position:{x:box.width*.3,y:box.height*.3}});
  await map.click({position:{x:box.width*.7,y:box.height*.7}});
  await page.getByRole('button',{name:'start flight',exact:true}).click();
  await page.getByText(/IN FLIGHT/).waitFor();
  assert.equal(await markers.count(),1,'scenario uses the same participant markers');
  await page.getByRole('button',{name:'remove drone',exact:true}).click();
  assert.equal(await page.locator('.map-card').getByText('sim drone',{exact:true}).count(),0);
  for (const width of [1440,1024,768,390,320]) {
    await page.setViewportSize({width,height:900});
    await page.waitForTimeout(100);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow at ${width}`);
    if (width > 900) {
      const mapBox = await page.locator('.map-card').boundingBox();
      const side = await page.locator('.dashboard-cards').boundingBox();
      assert(mapBox.width > side.width * 1.7,'map is the dominant desktop column');
    }
  }
  await phone.close();
  await page.waitForFunction(() => !document.querySelector('[data-node-id="real-phone"]'));
  assert.equal(await markers.count(),0,'departed participant is removed despite retained replica records');
  assert.deepEqual(errors,[]);
  console.log('PASS unified console: legacy redirect/session, actual join/admission, no mock nodes, staging versus placed positions, gossip placement, keyboard inspector, scenario on participant map, responsive hierarchy, departure cleanup.');
} finally { await browser.close(); }
