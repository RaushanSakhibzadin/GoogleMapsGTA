/* THE CASINOS, THE TWO COLOURS, AND THE WAR OVER THE WALLS.

   OpenStreetMap knows where the casinos are, so they arrive with the landmark
   sweep like a hospital does. Stop at one and two buttons come up; a tenth of
   your money goes on a fair coin; whichever colour you pick more is the side you
   are on; and from the first bet onwards you carry a can that turns a wall your
   colour, with a tag across its ground floor, until the other side comes round
   and takes one back.

   FOUR THINGS HERE ARE EASY TO GET WRONG AND ARE THEREFORE WHAT THIS MEASURES:

   THE COIN IS FAIR AND THE STAKE IS A TENTH. Both asserted on the arithmetic of
   many spins rather than on one — a single bet tells you nothing about a
   probability, and the first version of this test happened to see three wins in
   a row and would have passed on a coin weighted 3:1.

   A CITY WITH NO CASINO IS A CITY WITH NO CASINO. Explicitly: no buttons, no
   crash, and — the part that would actually have shipped — the landmark retry
   must not decide the map is broken and re-sweep it three times over the
   session looking for one. That is asserted through __retry().wanted, which is
   the flag that would do it.

   PAINT SURVIVES THE DARK. The dusk theme lands every masonry wall within a few
   points of the same violet-grey on purpose, so a painted wall that goes through
   it is invisible from sunset to sunrise. Checked in both themes, on the colours
   the renderers actually read.

   AND THE RIVAL TAKES ONE, BUT NEVER THE LAST. Being wiped out by a coin toss
   you did not make is the feature switching itself off.

   Usage: node tests/casino.mjs
*/
import { chromium, devices } from 'playwright';
import { CHROME, GAME, stubRadio } from './harness.mjs';

const LAT0 = 44.8125, LON0 = 20.4612;                 // Belgrade, where they are
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });

/* A GRID WITH BUILDINGS ON IT AND TWO CASINOS IN IT. The casinos are nodes, the
   way OSM carries most of them, and they sit ON the crossroads at (0,0) and
   (400,0) so a car parked at either is inside CASINO_RANGE without having to be
   driven there. */
function city(withCasinos) {
  const els = []; let id = 1;
  for (const y of [-400, -200, 0, 200, 400])
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `Cross ${y}` },
               geometry: [toLL(-600, y), toLL(600, y)] });
  for (const x of [-400, -200, 0, 200, 400])
    els.push({ type: 'way', id: id++, tags: { highway: 'secondary', name: `Avenue ${x}` },
               geometry: [toLL(x, -600), toLL(x, 600)] });
  if (withCasinos) {
    els.push({ type: 'node', id: 8001, ...toLL(0, 0), tags: { amenity: 'casino', name: 'Grand' } });
    els.push({ type: 'node', id: 8002, ...toLL(400, 0), tags: { amenity: 'casino', name: 'Fortuna' } });
  }
  // a hospital, so the landmark machinery has something to be satisfied by and
  // "wanted" is not answering about a missing hospital when we ask about casinos
  els.push({ type: 'node', id: 8100, ...toLL(-400, 400), tags: { amenity: 'hospital', name: 'Klinika' } });
  els.push({ type: 'node', id: 8101, ...toLL(-400, -400), tags: { amenity: 'police', name: 'MUP' } });
  return { elements: els };
}
function buildings() {
  const els = []; let id = 20000;
  for (let i = -2; i < 3; i++) for (let j = -2; j < 3; j++) {
    const bx = i * 200 + 40, by = j * 200 + 40;
    els.push({ type: 'way', id: id++, tags: { building: 'yes', 'building:levels': '5' },
               geometry: [[bx, by], [bx + 110, by], [bx + 110, by + 110], [bx, by + 110], [bx, by]]
                 .map(([x, y]) => toLL(x, y)) });
  }
  return { elements: els };
}
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const isB = req => decodeURIComponent(req.postData() || '').includes('"building"');
const isArt = req => { const q = decodeURIComponent(req.postData() || '');
                       return /motorway/.test(q) && !/residential/.test(q); };

const bad = [];
const need = (cond, msg) => { if (!cond) bad.push(msg); };
const out = {};

const browser = await chromium.launch({ executablePath: CHROME });

async function open(withCasinos) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(
    json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Beograd' }])));
  await p.route('**/api/interpreter', r => r.fulfill(
    json(isArt(r.request()) ? { elements: [] } : isB(r.request()) ? buildings() : city(withCasinos))));
  await stubRadio(p);
  await p.goto(GAME);
  await p.waitForTimeout(250);
  /* A CLEAN SLATE. The tally is deliberately persisted — which side you are on
     is a fact about the player and survives a reload — so a test that did not
     clear it would inherit whichever side the last run happened to end on, and
     the tie-break assertion below would pass or fail on history. */
  await p.evaluate(() => { try { localStorage.removeItem('vm_turf'); } catch (e) {} });
  await p.click('#go');
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 30000 });
  await p.waitForTimeout(700);
  /* GUARDED, AND ONLY HERE. Against a build that has none of this the hook does
     not exist, and an uncaught TypeError in the setup kills the run before a
     single finding is printed — which is the least useful moment for a test to
     fall over, and exactly what the first A/B of this file did. Every assertion
     below still reads through __turf(), which answers with zeroes on such a
     build and fails honestly. */
  await p.evaluate(() => { if (window.__turfReset) window.__turfReset(); });
  return { p, ctx, errs };
}

// ---------- 1. a city that has them ----------
{
  const { p, ctx, errs } = await open(true);
  const turf = () => p.evaluate(() => window.__turf ? window.__turf()
    : { casinos: 0, at: false, betRow: false, can: false, team: null, tagged: [],
        picks: { red: 0, black: 0 }, bets: 0, taken: 0, stake: 0,
        owned: { red: 0, black: 0 } });
  out.found = (await turf()).casinos;
  need(out.found === 2, `${out.found} casinos parsed out of the map, want 2`);

  /* THE BUTTONS ARE A PROXIMITY TEST, so this parks the car rather than trusting
     that it spawned at one. Away first, to prove they are not simply always up —
     a row that never hides is not a contextual control, and it would pass every
     assertion below. */
  await p.evaluate(() => window.__tp(0, -520, 0));
  await p.waitForTimeout(400);
  out.awayFromTable = await turf();
  need(!out.awayFromTable.at && !out.awayFromTable.betRow,
       'the bet buttons are up 520 m from the nearest casino');
  need(!out.awayFromTable.can, 'the spray can is up before a single bet');

  await p.evaluate(() => window.__tp(0, 0, 0));
  await p.waitForTimeout(400);
  out.atTable = await turf();
  need(out.atTable.at && out.atTable.betRow, 'no bet buttons while parked at a casino');

  // ---------- 2. a tenth of it, on a fair coin ----------
  /* MANY SPINS, NOT ONE. A single bet says nothing about a probability, and the
     stake rule is only visible as a ratio across a run of them. The cash is
     reset before each spin so the stake is a known number every time and the
     outcome cannot compound into noise. */
  const spins = await p.evaluate(async () => {
    const rows = [];
    for (let i = 0; i < 120; i++) {
      P.cash = 1000; store.set('vm_cash', '1000');
      const before = P.cash;
      const r = window.__bet ? window.__bet(i % 2 ? 'red' : 'black') : null;
      rows.push({ stake: r && r.stake, won: r && r.won, delta: P.cash - before });
      await new Promise(z => setTimeout(z, 0));
    }
    return rows;
  });
  const wins = spins.filter(s => s.won).length;
  out.spins = { n: spins.length, wins, stakes: [...new Set(spins.map(s => s.stake))] };
  need(spins.every(s => s.stake === 100), `stake was ${out.spins.stakes} on $1000, want 100 (a tenth)`);
  need(spins.every(s => s.delta === (s.won ? s.stake : -s.stake)),
       'a win did not double the stake, or a loss did not take it');
  /* 120 fair spins land outside 40..80 wins about one run in four thousand, so
     this is a real check on the coin rather than a formality that would pass on
     anything. Against a coin weighted 3:1 it fails essentially always. */
  need(wins >= 40 && wins <= 80, `${wins} wins in 120 spins — the coin is not fair`);

  // ---------- 3. which colour you pick more is the side you are on ----------
  await p.evaluate(() => { if (window.__turfReset) window.__turfReset(); });
  const sides = await p.evaluate(async () => {
    const seen = [];
    const bet = c => { P.cash = 1000; if (window.__bet) window.__bet(c);
                       return window.__turf ? window.__turf().team : null; };
    seen.push({ after: 'red', team: bet('red') });
    seen.push({ after: 'black', team: bet('black') });      // a tie: the last pick holds
    seen.push({ after: 'black', team: bet('black') });      // black now leads
    seen.push({ after: 'red', team: bet('red') });          // tied again, red picked last
    seen.push({ after: 'red', team: bet('red') });          // red leads
    return seen;
  });
  out.sides = sides;
  need(sides[0].team === 'red', 'one red bet did not make you red');
  need(sides[2].team === 'black', 'two black against one red did not make you black');
  need(sides[4].team === 'red', 'three red against two black did not make you red');
  need(sides[1].team === 'black' && sides[3].team === 'red',
       'a tie did not fall to the most recent pick');

  // ---------- 4. the can, and what a painted wall looks like ----------
  out.canAfterBets = await p.evaluate(() =>
    typeof syncTurfUI === 'function' ? (syncTurfUI(), window.__turf().can) : false);
  need(out.canAfterBets, 'no spray can after five bets');

  /* PARKED AT A BUILDING rather than wherever the betting left the car: the can
     paints what is in reach, so a test that does not choose a wall is asserting
     against whichever one happened to be nearest. */
  out.sprayed = await p.evaluate(() => {
    const b = W.buildings.find(x => !x.mono);
    window.__tp(b.cx + 12, b.cy, 0);
    const ok = window.__spray ? window.__spray() : false;
    return { ok, at: { x: Math.round(b.cx), y: Math.round(b.cy) },
             turf: window.__turf ? window.__turf() : { tagged: [] } };
  });
  need(out.sprayed.ok, 'the can painted nothing while parked at a wall');
  const mine = out.sprayed.turf.tagged;
  need(mine.length === 1, `${mine.length} walls painted by one press, want 1`);
  need(mine[0] && mine[0].turf === 'red', 'the wall did not come out the side you are on');
  need(mine[0] && /^[A-Z0-9]{3,6}$/.test(mine[0].tag || ''),
       `the tag is ${JSON.stringify(mine[0] && mine[0].tag)}, want 3-6 characters`);

  /* AND IT IS STILL RED AFTER DARK. This is the assertion the whole `paint is
     not masonry` argument exists for: run a painted wall through the dusk
     theme's transform and it comes out the same violet-grey as the concrete
     beside it. Compared against a NEIGHBOURING unpainted building rather than
     against a fixed colour, so it is measuring the difference the paint makes
     rather than a hex nobody would notice changing. */
  out.themes = await p.evaluate(() => {
    const read = () => {
      if (!W.buildings.some(b => b.turf)) return { tagged: null, plain: null, roof: null };
      const t = W.buildings.find(b => b.turf), o = W.buildings.find(b => !b.turf && !b.mono);
      return { tagged: t.wall, plain: o.wall, roof: t.roof };
    };
    applyTheme('dusk'); const dusk = read();
    applyTheme('day'); const day = read();
    applyTheme('dusk');
    return { dusk, day };
  });
  need(out.themes.dusk.tagged !== out.themes.dusk.plain,
       'after dark a painted wall is the same colour as the concrete next to it');
  need(out.themes.dusk.tagged === out.themes.day.tagged,
       'the paint changed colour with the theme — it is being lit as masonry');

  // ---------- 5. the rival takes one, and never the last ----------
  out.raid = await p.evaluate(() => {
    if (typeof claimBuilding !== 'function') return { before: 0, after: 0, rival: 0, taken: 0 };
    // three more walls, so there is something to lose
    for (const b of W.buildings.filter(x => !x.mono).slice(0, 4)) claimBuilding(b, 'red');
    const before = turfCount('red');
    const taken = window.__raidNow();
    return { before, after: turfCount('red'), rival: turfCount('black'), taken };
  });
  need(out.raid.after === out.raid.before - 1,
       `the rival took ${out.raid.before - out.raid.after} walls, want exactly 1`);
  need(out.raid.rival === 1, 'the wall the rival took did not come out their colour');

  out.lastWall = await p.evaluate(() => {
    if (typeof claimBuilding !== 'function') return -1;
    for (const b of W.buildings.filter(x => x.turf)) { b.turf = null; b.tag = null; }
    claimBuilding(W.buildings.find(x => !x.mono), 'red');
    window.__raidNow();
    return turfCount('red');
  });
  need(out.lastWall === 1, 'the rival took your last wall — that is the feature switching off');

  out.errs = errs.slice(0, 3);
  need(!errs.length, 'page errors: ' + errs.slice(0, 2).join(' | '));
  await p.close(); await ctx.close();
}

// ---------- 6. and a city with none of them is fine ----------
/* The half of this that would actually have shipped broken. A casino is not a
   service the game needs — no shift starts at one and no wasted run ends at one
   — so a city without any must be an ordinary city, and in particular must not
   set the landmark retry going. Every player outside a gambling town would
   otherwise re-sweep the map three times a session looking for something that
   was never there. */
{
  const { p, ctx, errs } = await open(false);
  out.dry = { ...(await p.evaluate(() => window.__turf ? window.__turf()
    : { casinos: -1, at: false, betRow: false })),
    wanted: await p.evaluate(() => window.__retry().wanted) };
  need(out.dry.casinos === 0, 'a city with no casinos reported some');
  need(!out.dry.betRow && !out.dry.at, 'the bet buttons came up in a city with no casino');
  need(out.dry.wanted !== 'landmarks',
       'a missing casino set the landmark sweep retrying — it is not a service');
  out.dryErrs = errs.slice(0, 3);
  need(!errs.length, 'page errors with no casinos: ' + errs.slice(0, 2).join(' | '));
  await p.close(); await ctx.close();
}

await browser.close();
out.bad = bad;
out.pass = bad.length === 0;
console.log(JSON.stringify(out, null, 1));
process.exit(out.pass ? 0 : 1);
