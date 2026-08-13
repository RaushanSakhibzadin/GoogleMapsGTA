/* What a 72 km world actually costs. The mask is the only thing that scales with
   the square of the radius, so it is the only thing worth measuring. */
import { chromium, devices } from 'playwright';
import { join } from 'path';
import { CHROME, GAME, ROOT } from './harness.mjs';
const LAT0 = 44.8069, LON0 = 20.4735;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const isArt = q => /motorway/.test(q) && !/residential/.test(q);
const arterials = () => ({ elements: [
  ...Array.from({length: 25}, (_, i) => i - 12).map(k => ({ type:'way', id: 800000+k+40,
    tags:{highway:'primary',name:`Radial ${k}`},
    geometry:[toLL(-36100, k*2800), toLL(36100, k*2800)] })),
  { type:'node', id:800999, lat:LAT0, lon:LON0, tags:{place:'city',name:'Beograd'} }] });
const streets = () => ({ elements: [
  ...[-2,-1,0,1,2].map(k => ({ type:'way', id: 900+k, tags:{highway:k?'residential':'secondary',name:`EW ${k}`},
    geometry:[toLL(-900,k*200), toLL(900,k*200)] })),
  { type:'node', id:6001, lat:LAT0, lon:LON0, tags:{place:'suburb',name:'KV'} }] });
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await (await b.newContext({ ...devices['iPhone 13'] })).newPage();
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{lat:String(LAT0),lon:String(LON0),display_name:'KV'}])));
await p.route('**/api/interpreter', r => {
  const q = decodeURIComponent(r.request().postData()||'');
  if (isArt(q)) return r.fulfill(json(arterials()));
  if (/"building"/.test(q) || (/amenity/.test(q) && !/highway/.test(q))) return r.fulfill(json({elements:[]}));
  return r.fulfill(json(streets()));
});
await p.goto(GAME);
await p.waitForTimeout(250);
await p.tap('#go');
await p.waitForFunction(() => window.__s && window.__s()==='play', null, {timeout:120000});
await p.waitForTimeout(900);
console.log(JSON.stringify(await p.evaluate(() => {
  const c = window.__chunks();
  const [gw, gh] = c.grid.split('x').map(Number);
  return { skel: c.skel, grid: c.grid, cells: gw*gh,
           maskBytes: (typeof W !== 'undefined' && W.grid) ? W.grid.byteLength : null,
           maskMB: (typeof W !== 'undefined' && W.grid) ? +(W.grid.byteLength/1048576).toFixed(1) : null,
           heapMB: performance.memory ? +(performance.memory.usedJSHeapSize/1048576).toFixed(1) : null,
           spanKm: (c.bounds.x1 - c.bounds.x0)/1000, roads: c.roads };
}), null, 1));
const fps = await p.evaluate(() => new Promise(r => { let n=0; const t=performance.now();
  const tick=()=>{n++; performance.now()-t<1500?requestAnimationFrame(tick):r(Math.round(n/1.5));}; requestAnimationFrame(tick);}));
console.log('fps', fps);
await b.close();
