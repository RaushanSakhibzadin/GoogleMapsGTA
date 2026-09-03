import { chromium, devices } from 'playwright';
import { CHROME, GAME, ROOT } from './harness.mjs';
const OUT = process.env.SHOTS || '/tmp';
const LAT0 = 40.7580, LON0 = -73.9855;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const streets = () => {
  const els = []; let id = 1;
  for (const y of [-400, -200, 0, 200, 400])
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `Cross ${y}` }, geometry: [toLL(-600, y), toLL(600, y)] });
  for (const x of [-400, -200, 0, 200, 400])
    els.push({ type: 'way', id: id++, tags: { highway: 'secondary', name: `Avenue ${x}` }, geometry: [toLL(x, -600), toLL(x, 600)] });
  els.push({ type: 'node', id: 900, lat: LAT0, lon: LON0, tags: { place: 'suburb', name: 'Downtown' } });
  return { elements: els };
};
const buildings = () => {
  const els = []; let id = 5000;
  for (let i = -2; i < 2; i++) for (let j = -2; j < 2; j++) {
    const bx = i * 200 + 40, by = j * 200 + 40;
    els.push({ type: 'way', id: id++, tags: { building: 'yes', 'building:levels': '6' },
      geometry: [[bx, by], [bx + 90, by], [bx + 90, by + 90], [bx, by + 90], [bx, by]].map(([x, y]) => toLL(x, y)) });
  }
  return { elements: els };
};
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const isB = req => decodeURIComponent(req.postData() || '').includes('"building"');

// every element that can be on screen at once
/* tN is gone from here with the day/night switch itself: it is a row inside the
   settings panel now rather than a control floating over the game, so it has no
   place in the layout that has to not collide with itself. The panel's own rows
   are checked in fixes.mjs, where the panel is opened. */
// BOTH cans, not one: they are two buttons in two corners and either of them can
// land on something. A list that names half a pair checks half a layout.
const IDS = ['obj', 'mini', 'street', 'hpWrap', 'zone', 'speed', 'cash', 'stars', 'chunk',
             'tH', 'tL', 'tR', 'tA', 'tB', 'jobBtn', 'sprayBtn', 'sprayBtnR',
             // the settings gear: not a clash candidate — it is OUTSIDE #hud and
             // always has been — but it is the right-hand wall of the strip the
             // objective is centred in, so its box is needed to say where that is
             'topBtns'];

const browser = await chromium.launch({ executablePath: CHROME });
const out = [];

/* Landscape phone is the tightest of these for HEIGHT — least room for the
   left-hand column. The Android pair is the tightest for WIDTH, and they were
   not here, which is how the thumb pads shipped overlapping on Android for
   months while this test passed on every run.

   Every case here used to be an Apple one, and the narrowest of them is the
   iPhone at 390 points — which is, to within fourteen pixels, exactly wide
   enough for the bottom row. At 360 the reverse pad overlapped the right-steer
   pad by 16 points and at 320 by 56, i.e. most of a button, and nothing in the
   suite was looking. A test that only owns the hardware the author owns is a
   test that certifies the author's phone. */
const CASES = [
  ['desktop',          { viewport: { width: 1280, height: 800 } }],
  ['phone-portrait',   { ...devices['iPhone 13'] }],
  ['phone-landscape',  { ...devices['iPhone 13 landscape'] }],
  ['android-wide',     { ...devices['Pixel 7'] }],            // 412
  ['android-narrow',   { ...devices['Galaxy S9+'] }],         // 320 — the tightest sold
  ['ipad-portrait',    { ...devices['iPad (gen 7)'] }],
  ['ipad-landscape',   { ...devices['iPad (gen 7) landscape'] }],
];

for (const [label, ctxOpts] of CASES) {
  const ctx = await browser.newContext(ctxOpts);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Midtown' }])));
  await p.route('**/api/interpreter', r => r.fulfill(json(isB(r.request()) ? buildings() : streets())));
  await p.goto(GAME);
  await p.waitForTimeout(250);
  await p.click('#go');
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 30000 });
  await p.waitForTimeout(800);
  /* THE DEPOT BUTTON IS RAISED BY HAND. It only appears when the car is stopped
     at a place that hires, which no fixture here contains — and an element that
     is display:none is skipped by the geometry below, so leaving it down would
     mean the one new control in the HUD is the one control never checked for
     landing on a thumb pad. */
  /* THE PADS, EXPLICITLY. The stick is the default touch control now, and the
     pads are display:none under it — which the geometry below SKIPS, so leaving
     the default would quietly drop every pad out of the clash check while the
     file still reported green. This is the pad-layout test; it asks for the pad
     layout. The stick needs no equivalent: it is drawn under the thumb wherever
     that lands, so it has no fixed position to clash with anything. */
  await p.evaluate(() => window.__ctrl && window.__ctrl('pads'));
  await p.evaluate(() => { document.getElementById('jobBtn').classList.add('on'); });
  // drive briefly so the street label and district banner are both showing
  await p.keyboard.down('w'); await p.waitForTimeout(1500); await p.keyboard.up('w');
  await p.waitForTimeout(400);

  const geo = await p.evaluate(ids => {
    const r = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      const b = el.getBoundingClientRect();
      const vis = b.width > 0 && b.height > 0 && getComputedStyle(el).display !== 'none' &&
                  parseFloat(getComputedStyle(el).opacity) > 0.05;
      if (vis) r[id] = { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
    }
    // The car isn't a DOM node — render() parks it at HX = VW/2, HY = VH*.60.
    // Treated as one more box so any HUD element sitting on it counts as a clash.
    const R = 34;
    r.CAR = { x: Math.round(innerWidth / 2 - R), y: Math.round(innerHeight * 0.60 - R), w: R * 2, h: R * 2 };
    return { boxes: r, vw: innerWidth, vh: innerHeight };
  }, IDS);

  // corner of each element, so we can assert where things ended up
  const corner = (b, vw, vh) => (b.y + b.h / 2 < vh / 2 ? 'top' : 'bottom') + '-' +
                                (b.x + b.w / 2 < vw / 2 ? 'left' : 'right');
  const where = {};
  for (const [id, b] of Object.entries(geo.boxes)) if (id !== 'CAR') where[id] = corner(b, geo.vw, geo.vh);

  const names = Object.keys(geo.boxes);
  const clashes = [], onCar = [];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const a = geo.boxes[names[i]], b = geo.boxes[names[j]];
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (ox > 2 && oy > 2) {
      const msg = `${names[i]}×${names[j]} (${ox}×${oy}px)`;
      (names[i] === 'CAR' || names[j] === 'CAR' ? onCar : clashes).push(msg);
    }
  }
  // how much clear air the nearest HUD box leaves around the car
  const car = geo.boxes.CAR;
  let nearest = { id: null, gap: Infinity };
  for (const [id, b] of Object.entries(geo.boxes)) {
    if (id === 'CAR') continue;
    const gx = Math.max(b.x - (car.x + car.w), car.x - (b.x + b.w));
    const gy = Math.max(b.y - (car.y + car.h), car.y - (b.y + b.h));
    const gap = Math.max(gx, gy);
    if (gap < nearest.gap) nearest = { id, gap };
  }
  await p.screenshot({ path: `${OUT}/shot-hud-${label}.png` });

  // the off-screen arrow must dodge the radar in its corner: aim the objective west
  const arrowOk = await p.evaluate(async () => {
    const m = window.__mission();
    if (!m.pick) return 'no mission';
    window.__tp(m.pick.x + 900, m.pick.y, 0);       // target now far to the west
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const mr = document.getElementById('mini').getBoundingClientRect();
    return { radar: { x: Math.round(mr.left), y: Math.round(mr.top), w: Math.round(mr.width) } };
  });

  await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/shot-arrow-${label}.png` });

  /* WHERE THE TOP OF THE SCREEN PUT THINGS, which is a different question from
     whether anything overlaps and is the one that was asked for: the objective
     across the top CENTRE, and the radar and the street name higher up than they
     were under it.
   *
     A LANDSCAPE PHONE IS EXEMPT FROM BOTH and says so rather than being quietly
     excused. 342 points of height has one clear strip at the top and the settings
     button already has it — see the media query in style.css — so there the
     objective stays at the head of the left column with the radar under it, which
     is the arrangement everywhere else has now moved on from. */
  const objB = geo.boxes.obj, miniB = geo.boxes.mini, gearB = geo.boxes.topBtns;
  const place = { objMid: objB ? Math.round(objB.x + objB.w / 2) : null,
                  screenMid: Math.round(geo.vw / 2),
                  objBottom: objB ? objB.y + objB.h : null,
                  miniTop: miniB ? miniB.y : null };
  const short = geo.vh <= 520;
  /* CENTRED IN THE SPACE IT HAS, not on the screen — which is a change of
     question, and the ask changed it. "Almost touching the screen top" put the
     radar at the top left, and a banner running the full width would then run
     through it. It is inset past the radar on one side and the gear on the
     other, so the middle it is centred on is the middle of THAT strip. Measuring
     it against the screen's own middle would now be measuring the radar's width,
     which nobody asked about. */
  place.bandL = miniB ? miniB.x + miniB.w : 0;
  place.bandR = gearB ? gearB.x : geo.vw;
  place.bandMid = Math.round((place.bandL + place.bandR) / 2);
  place.centred = short ? 'n/a (landscape)'
    : !!objB && Math.abs(place.objMid - place.bandMid) <= geo.vw * 0.05;
  /* SIXTEEN POINTS. Asked for twice — "higher", and then "almost touching the
     screen top" — and it has been three numbers: 60 under the old stacked
     column, 46 once the objective became a banner, and 8 now that the banner
     moved out of its way. The bound is tight on purpose: at 56 this assertion
     would still pass on the layout the second ask was a complaint about. */
  place.radarIsHigh = !!miniB && place.miniTop <= (short ? 56 : 16);
  /* AND THE TWO ARE STILL SEPARATE. They no longer stack, so the claim is not
     "above" any more — it is that the banner does not run through the radar,
     which on this layout means it starts to the right of it. The clash list
     below catches it too; this names it, so a failure says which rule broke. */
  place.objClearOfRadar = !objB || !miniB ||
    objB.x >= miniB.x + miniB.w || place.objBottom <= miniB.y;
  out.push({ label, vw: geo.vw, vh: geo.vh, where, clashes, onCar, nearest, arrowOk, place, errs });
  await p.close(); await ctx.close();
}
/* AND A VERDICT, which this did not have.

   For its whole life this printed a report and exited zero, so tests/run.mjs
   recorded it as a pass on every run no matter what it found — including the run
   where it correctly listed three overlapping HUD elements on a landscape phone,
   and every run after the thumb pads started overlapping on Android. A check
   nobody fails is a check nobody reads.

   HUD-ON-CAR IS NOT A CLASH and stays out of the verdict: the car is in the
   middle of the screen and the HUD is around the edges of it, so a wide car at
   speed brushing the armor bar is the layout working. Two HUD elements on top of
   each other is not. */
const bad = out.filter(c => c.clashes.length || c.errs.length ||
                           c.place.centred === false || !c.place.radarIsHigh ||
                           !c.place.objClearOfRadar);
const pass = bad.length === 0;
console.log(JSON.stringify({ cases: out, failing: bad.map(c => c.label), pass }, null, 1));
await browser.close();
process.exit(pass ? 0 : 1);
