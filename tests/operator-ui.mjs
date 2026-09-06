// Run after build:static against the relay serving out/.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.APP_URL ?? 'http://127.0.0.1:8127';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [], sockets = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('websocket', ws => sockets.push(ws.url()));
  // Exercise offline-basemap behavior without depending on a public tile service.
  await page.route('**/*.tile.openstreetmap.org/**', r => r.abort());
  await page.goto(`${base}/operator/?session=operator-acceptance`);
  await page.getByRole('heading', {name: 'Network simulation', exact: true}).waitFor();
  await page.getByRole('status').filter({hasText:'Basemap unavailable'}).waitFor();
  assert.equal(await page.getByRole('link', {name:'Simulation', exact:true}).getAttribute('aria-current'), 'page');
  assert.equal(await page.getByRole('button', {name:'Place node', exact:true}).evaluate(el => el.classList.contains('cds--btn')), true);
  const map = page.locator('.leaflet-container');
  const clickMap = async (x, y) => {const b = await map.boundingBox(); await page.mouse.click(b.x+x,b.y+y);};
  for (const [x,y] of [[320,240],[370,240],[345,285]]) {
    await page.getByRole('button', {name:'Place node',exact:true}).click();
    await clickMap(x,y);
  }
  assert.match(await page.locator('header').last().innerText(), /3\s+active/i);
  await page.getByRole('button', {name:'Suggest placement'}).click();
  await page.getByText('Localisation quality', {exact:true}).waitFor();
  const suggestions = page.locator('button').filter({hasText:/±.*link.*−/});
  assert(await suggestions.count() > 0, 'advisor offers legal placements');
  await suggestions.first().click();
  assert.match(await page.locator('header').last().innerText(), /4\s+active/i);
  await page.getByRole('button', {name:'Hide advice'}).click();
  await page.getByRole('button', {name:'Draw attack route',exact:true}).click();
  await clickMap(250,240);
  await clickMap(430,240);
  await page.getByRole('button', {name:/Finish route/}).click();
  await page.getByRole('button', {name:'▶ Run',exact:true}).click();
  await page.getByRole('button', {name:'❚❚ Pause',exact:true}).waitFor();
  await page.waitForTimeout(400);
  await page.getByRole('button', {name:'❚❚ Pause',exact:true}).click();
  const clock = page.locator('span').filter({hasText:/^t\+\d+\.\d s$/});
  const paused = await clock.innerText();
  await page.waitForTimeout(250);
  assert.equal(await clock.innerText(),paused,'pause freezes simulation time');
  await page.getByRole('button', {name:/Reset/}).click();
  assert.equal(await clock.innerText(),'t+0.0 s');
  await page.getByRole('button', {name:'16×',exact:true}).click();
  await page.getByRole('button', {name:'▶ Run',exact:true}).click();
  await page.getByRole('button', {name:'▶ Replay',exact:true}).waitFor();
  await page.getByRole('button', {name:'▶ Replay',exact:true}).click();
  await page.waitForTimeout(150);
  assert(await page.getByRole('button', {name:'❚❚ Pause',exact:true}).isVisible(), 'replay starts a fresh run');
  await page.getByRole('button', {name:/Reset/}).click();
  await clickMap(320,240);
  await page.getByRole('button', {name:'See what this node sees',exact:true}).click();
  await page.getByRole('button', {name:/Showing this node/}).waitFor();
  assert.deepEqual(sockets, [], 'simulator never connects to live relay');
  for (const width of [1440,1024,768,390]) {
    await page.setViewportSize({width,height:900});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `operator overflows at ${width}`);
    assert(await page.getByRole('link',{name:'Live sensors',exact:true}).isVisible());
  }
  await page.getByRole('link',{name:'Live sensors',exact:true}).click();
  await page.locator('.fit-board').waitFor();
  assert.match(page.url(), /station\/\?session=operator-acceptance/);
  await page.getByRole('link',{name:'Simulation',exact:true}).click();
  await page.getByRole('heading',{name:'Network simulation',exact:true}).waitFor();
  assert.match(page.url(), /operator\/\?session=operator-acceptance/);
  assert.deepEqual(errors, []);
  console.log('PASS operator: static route, Carbon controls, offline tiles, placement, advisor acceptance, route run/pause/reset, per-node view, four viewport sizes, no live socket, session-preserving mode navigation.');
} finally { await browser.close(); }
