import { chromium } from 'playwright';
import { CHROME, GAME, ROOT } from './harness.mjs';
const URL = GAME;
const LAT0 = 56.9496, LON0 = 24.1052;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });

const streets = () => {
  const els = []; let id = 1;
  for (const y of [-400, -200, 0, 200, 400])
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `EW ${y}` }, geometry: [toLL(-600, y), toLL(600, y)] });
  for (const x of [-400, -200, 0, 200, 400])
    els.push({ type: 'way', id: id++, tags: { highway: 'secondary', name: `NS ${x}` }, geometry: [toLL(x, -600), toLL(x, 600)] });
  els.push({ type: 'node', id: 900, lat: LAT0, lon: LON0, tags: { place: 'suburb', name: 'Vecriga' } });
  return { elements: els };
};
const buildings = () => {
  const els = []; let id = 5000;
  for (let i = -2; i < 2; i++) for (let j = -2; j < 2; j++) {
    const bx = i * 200 + 40, by = j * 200 + 40;
    els.push({ type: 'way', id: id++, tags: { building: 'yes', 'building:levels': '4' },
      geometry: [[bx, by], [bx + 90, by], [bx + 90, by + 90], [bx, by + 90], [bx, by]].map(([x, y]) => toLL(x, y)) });
  }
  return { elements: els };
};
const thin = () => ({ elements: [
  { type: 'way', id: 1, tags: { highway: 'residential', name: 'Village Lane' }, geometry: [toLL(-300, 0), toLL(300, 0)] },
  { type: 'way', id: 2, tags: { highway: 'track', name: 'Farm Track' }, geometry: [toLL(0, -300), toLL(0, 300)] }
] });

const isBuildingsQuery = req => decodeURIComponent(req.postData() || '').includes('"building"');
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });

/* The wide skeleton shares the motorway prefix with the streets query and only
   streets asks for residential lanes -- that is the whole difference, and every
   handler below has to make it or the skeleton is counted as a street request
   and served a 1.8 km payload over a 36 km box. */
const isArterials = body => /motorway/.test(body) && !/residential/.test(body);
const wide = () => {
  const els = []; let id = 700000;
  for (let i = -6; i <= 6; i++) {
    els.push({ type: 'way', id: id++, tags: { highway: 'primary', name: `Ring ${i}` },
      geometry: [toLL(i * 1500, -9000), toLL(i * 1500, 9000)] });
    els.push({ type: 'way', id: id++, tags: { highway: 'trunk', name: `Radial ${i}` },
      geometry: [toLL(-9000, i * 1500), toLL(9000, i * 1500)] });
  }
  return { elements: els };
};
// every scenario answers the skeleton the same way, so it's one line at each site
const serveWide = (r, hits) => {
  if (!isArterials(decodeURIComponent(r.request().postData() || ''))) return false;
  if (hits) hits.arterials = (hits.arterials || 0) + 1;
  r.fulfill(json(wide()));
  return true;
};

const BROWSER = await chromium.launch({ executablePath: CHROME });
async function scenario(name, setup, act) {
 let p;
 try {
  p = await BROWSER.newPage({ viewport: { width: 1100, height: 700 } });
  const errs = []; const hits = { streets: 0, buildings: 0, geocode: 0 };
  p.on('pageerror', e => errs.push(String(e)));
  p.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED|ERR_ABORTED/.test(m.text())) errs.push('console: ' + m.text()); });
  await setup(p, hits);
  await p.goto(URL);
  await p.waitForTimeout(250);
  const t0 = Date.now();
  const out = await act(p, hits, t0);
  await p.close();
  const r = { name, hits, errs, ...out };
  console.log(JSON.stringify(r));
  return r;
 } catch (e) {
  console.log(JSON.stringify({ name, FAILED: String(e).split('\n')[0].slice(0, 90) }));
  if (p) await p.close().catch(() => {});
  return { name, failed: true };
 }
}

const played = async (p, ms = 25000) => {
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: ms });
  return p.evaluate(() => ({ ...window.__w(), pos: window.__p() }));
};

const results = [];

// 1. slow but valid: 30s to answer. The old 25s deadline killed this every time.
results.push(await scenario('slow-but-valid',
  async (p, hits) => {
    await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Riga' }])));
    await p.route('**/api/interpreter', async r => {
      if (isBuildingsQuery(r.request())) { hits.buildings++; return r.fulfill(json(buildings())); }
      if (serveWide(r, hits)) return;
      hits.streets++;
      await new Promise(res => setTimeout(res, 8000));
      r.fulfill(json(streets()));
    });
  },
  async (p, hits, t0) => {
    await p.click('#go');
    const w = await played(p);
    return { secs: +((Date.now() - t0) / 1000).toFixed(1), procedural: w.procedural, roads: w.roads };
  }));

// 2. first mirror 429s, retry succeeds
/* 2b. THE reported stall: one mirror is unreachable from this network and fails
   in about a second. It used to burn its two retries while the healthy mirrors
   sat un-started behind a 7s hedge — "Asking 5 map servers" at 16 seconds, all
   of it spent on one dead host. A dead first mirror must cost a moment, not the
   whole load. */
results.push(await scenario('first-mirror-dead',
  async (p, hits) => {
    await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Riga' }])));
    p.__hosts = new Set(); p.__deadHits = 0; p.__firstOk = null; p.__t0 = Date.now();
    // whichever host is asked first is "unreachable"; every other one works
    let dead = null;
    await p.route('**/api/interpreter', r => {
      // NB: `URL` is shadowed by this file's own const at the top
      const h = (r.request().url().match(/^https?:\/\/([^/]+)/) || [,'?'])[1];
      p.__hosts.add(h);
      if (dead === null) dead = h;
      if (h === dead) { p.__deadHits++; return r.abort('connectionrefused'); }
      if (isBuildingsQuery(r.request())) { hits.buildings++; return r.fulfill(json(buildings())); }
      if (serveWide(r, hits)) return;
      if (p.__firstOk === null) p.__firstOk = Date.now() - p.__t0;
      hits.streets++; r.fulfill(json(streets()));
    });
  },
  async (p, hits, t0) => {
    p.__t0 = Date.now();
    await p.click('#go');
    const w = await played(p, 40000);
    /* What matters is how long the DEAD host held up the streets request, not how
       long the whole load took — the skeleton and the ring come after it and are
       slow by design. Measure the reroute, not the load. */
    return { secs: +((Date.now() - t0) / 1000).toFixed(1),
             procedural: w.procedural, roads: w.roads,
             msToFirstAnswer: p.__firstOk, deadHostAttempts: p.__deadHits,
             hostsTried: [...p.__hosts].length,
             /* A dead mirror is a detour: a live host answers within seconds, AND
                the dead one is learned once rather than rediscovered by every
                request that follows — it soaked up 30 connection attempts in a
                single load before the mirror health list existed. */
             routedAround: w.procedural === false && w.roads > 0 &&
                           p.__firstOk < 6000 && p.__deadHits <= 8 };
  }));

results.push(await scenario('429-then-ok',
  async (p, hits) => {
    await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Riga' }])));
    await p.route('**/api/interpreter', r => {
      if (isBuildingsQuery(r.request())) { hits.buildings++; return r.fulfill(json(buildings())); }
      if (serveWide(r, hits)) return;
      hits.streets++;
      if (hits.streets <= 2) return r.fulfill({ status: 429, headers: { 'retry-after': '1' }, contentType: 'text/plain', body: 'slow down' });
      r.fulfill(json(streets()));
    });
  },
  async (p, hits, t0) => {
    await p.click('#go');
    const w = await played(p);
    return { secs: +((Date.now() - t0) / 1000).toFixed(1), procedural: w.procedural, roads: w.roads };
  }));

// 3. buildings never come; the city must still be real
results.push(await scenario('buildings-fail',
  async (p, hits) => {
    await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Riga' }])));
    await p.route('**/api/interpreter', r => {
      if (isBuildingsQuery(r.request())) { hits.buildings++; return r.fulfill({ status: 504, contentType: 'text/plain', body: 'gateway timeout' }); }
      if (serveWide(r, hits)) return;
      hits.streets++; r.fulfill(json(streets()));
    });
  },
  async (p, hits, t0) => {
    await p.click('#go');
    const w = await played(p);
    await p.waitForTimeout(2000);
    const after = await p.evaluate(() => window.__w());
    return { secs: +((Date.now() - t0) / 1000).toFixed(1), procedural: w.procedural, roads: w.roads, buildings: after.buildings };
  }));

// 3c. the landmark sweep hanging must not hold the loading screen hostage
results.push(await scenario('landmark-sweep-hangs',
  async (p, hits) => {
    await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Riga' }])));
    await p.route('**/api/interpreter', async r => {
      const body = decodeURIComponent(r.request().postData() || '');
      if (/amenity/.test(body) && !/highway/.test(body)) { await new Promise(() => {}); return; }   // never answers
      if (isBuildingsQuery(r.request())) { hits.buildings++; return r.fulfill(json({ elements: [] })); }
      if (serveWide(r, hits)) return;
      hits.streets++; r.fulfill(json(streets()));
    });
  },
  async (p, hits, t0) => {
    await p.click('#go');
    const w = await played(p, 30000);
    const secs = +((Date.now() - t0) / 1000).toFixed(1);
    return { secs, procedural: w.procedural, roads: w.roads, startedAnyway: w.procedural === false && secs < 20 };
  }));

// 3d. the opening ring: the city must start at 5.4 km, not 1.8
results.push(await scenario('opening-ring',
  async (p, hits) => {
    await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Riga' }])));
    await p.route('**/api/interpreter', r => {
      const body = decodeURIComponent(r.request().postData() || '');
      if (isBuildingsQuery(r.request())) { hits.buildings++; return r.fulfill(json({ elements: [] })); }
      if (/amenity/.test(body) && !/highway/.test(body)) return r.fulfill(json({ elements: [] }));
      if (serveWide(r, hits)) return;
      hits.streets++; r.fulfill(json(streets()));
    });
  },
  async (p, hits, t0) => {
    await p.click('#go');
    await played(p, 60000);
    const c = await p.evaluate(() => window.__chunks());
    const spanKm = +((c.bounds.x1 - c.bounds.x0) / 1000).toFixed(2);
    return { secs: +((Date.now() - t0) / 1000).toFixed(1), live: c.live, spanKm,
             ringLoaded: c.live >= 9 && spanKm > 5 };
  }));

// 3e. a ring whose neighbours never answer must not hold the loading screen
results.push(await scenario('ring-hangs',
  async (p, hits) => {
    await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Riga' }])));
    let first = true;
    await p.route('**/api/interpreter', async r => {
      const body = decodeURIComponent(r.request().postData() || '');
      if (isBuildingsQuery(r.request())) { hits.buildings++; return r.fulfill(json({ elements: [] })); }
      if (/amenity/.test(body) && !/highway/.test(body)) return r.fulfill(json({ elements: [] }));
      if (serveWide(r, hits)) return;
      hits.streets++;
      if (first) { first = false; return r.fulfill(json(streets())); }
      await new Promise(() => {});                        // every neighbour hangs
    });
  },
  async (p, hits, t0) => {
    await p.click('#go');
    const w = await played(p, 80000);
    const secs = +((Date.now() - t0) / 1000).toFixed(1);
    const c = await p.evaluate(() => window.__chunks());
    // starts on the centre tile alone, bounded by the ring deadline
    return { secs, live: c.live, roads: w.roads, startedAnyway: w.procedural === false && secs < 25 };
  }));

// 3f. the critical path carries roads and place names, nothing else -- and the
// things moved off it still arrive, through their own requests
results.push(await scenario('critical-path-minimal',
  async (p, hits) => {
    p.__seen = { streetsBody: null, parks: 0 };
    await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Riga' }])));
    await p.route('**/api/interpreter', r => {
      const body = decodeURIComponent(r.request().postData() || '');
      if (isBuildingsQuery(r.request())) {
        hits.buildings++; p.__seen.parks++;
        return r.fulfill(json({ elements: [{ type: 'way', id: 4100, tags: { leisure: 'park' },
          geometry: [[400, 400], [700, 400], [700, 700], [400, 700], [400, 400]].map(([x, y]) => toLL(x, y)) }] }));
      }
      if (/amenity/.test(body) && !/highway/.test(body)) return r.fulfill(json({ elements: [] }));
      if (p.__seen.streetsBody === null) p.__seen.streetsBody = body;
      if (serveWide(r, hits)) return;
      hits.streets++; r.fulfill(json(streets()));
    });
  },
  async (p, hits, t0) => {
    await p.click('#go');
    await played(p);
    await p.waitForTimeout(3500);
    const w = await p.evaluate(() => ({ parks: window.__w().parks }));
    const body = p.__seen.streetsBody || '';
    const clauses = (body.match(/\b(?:way|node|nwr|relation)\[/g) || []);
    return {
      streetsClauses: clauses.length,
      onlyRoadsAndPlaces: clauses.length === 2 && !/water|leisure|landuse|amenity|shop|building/.test(body),
      parkRequests: p.__seen.parks, parks: w.parks,
      movedFeaturesStillArrive: w.parks > 0,
    };
  }));

// 3g. a heavy area asks for less of the ring rather than spending its whole budget
results.push(await scenario('slow-area-shrinks-ring',
  async (p, hits) => {
    await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Riga' }])));
    await p.route('**/api/interpreter', async r => {
      const body = decodeURIComponent(r.request().postData() || '');
      if (isBuildingsQuery(r.request())) { hits.buildings++; return r.fulfill(json({ elements: [] })); }
      if (/amenity/.test(body) && !/highway/.test(body)) return r.fulfill(json({ elements: [] }));
      if (serveWide(r, hits)) return;
      hits.streets++;
      // Distinct bboxes = distinct TILES. Raw request count conflates ring tiles
      // with hedged mirror attempts, and hedging several mirrors is the fix for
      // a dead host -- it must not read as "the ring didn't shrink".
      (p.__tiles = p.__tiles || new Set()).add((decodeURIComponent(r.request().postData() || '').match(/\(([-\d.,]+)\)/) || [,''])[1]);
      await new Promise(res => setTimeout(res, 9000));      // heavier than SLOW_AREA_MS
      r.fulfill(json(streets()));
    });
  },
  async (p, hits, t0) => {
    await p.click('#go');
    await played(p, 60000);
    const c = await p.evaluate(() => window.__chunks());
    // 9s opening: past the threshold, so the corners are dropped and only the
    // four sides are even attempted -- fewer street requests than the full ring
    const tiles = await p.evaluate(() => 0).then(() => (p.__tiles || new Set()).size);
    return { secs: +((Date.now() - t0) / 1000).toFixed(1), streetRequests: hits.streets,
             distinctTiles: tiles, live: c.live, askedFewer: tiles < 9 };
  }));

/* 3h. the wide skeleton is fetched during loading, ONCE, and never asked for
   again — it covers the whole world in one go and there is nothing to add to it.

   Streets are the opposite and this scenario used to have it backwards. It
   asserted that no streets request may fire while driving, on the reasoning that
   the skeleton was the road network; what that actually bought was a
   neighbourhood arriving as buildings on bare ground, because the skeleton is
   arterials and a residential street is not an arterial. Driving across several
   tile boundaries must now produce street requests — that is the fix — and still
   no second arterials request, which is the part that was right. */
results.push(await scenario('skeleton-once-streets-keep-coming',
  async (p, hits) => {
    p.__afterPlay = null;
    await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Riga' }])));
    await p.route('**/api/interpreter', r => {
      const body = decodeURIComponent(r.request().postData() || '');
      const kind = isBuildingsQuery(r.request()) ? 'buildings'
                 : (/amenity/.test(body) && !/highway/.test(body)) ? 'pois'
                 : isArterials(body) ? 'arterials' : 'streets';
      if (p.__afterPlay) p.__afterPlay.push(kind);
      if (kind === 'pois') return r.fulfill(json({ elements: [] }));
      if (kind === 'buildings') { hits.buildings++; return r.fulfill(json(buildings())); }
      if (kind === 'arterials') { hits.arterials = (hits.arterials || 0) + 1; return r.fulfill(json(wide())); }
      hits.streets++; r.fulfill(json(streets()));
    });
  },
  async (p, hits, t0) => {
    await p.click('#go');
    await played(p, 60000);
    p.__afterPlay = [];                       // start recording only now
    const c0 = await p.evaluate(() => window.__chunks());
    // drive far enough to cross several tile boundaries
    await p.evaluate(async () => {
      for (let i = 0; i < 5; i++) { window.__tp(2000 + i * 1500, 1200, 0); await new Promise(r => setTimeout(r, 800)); }
    });
    await p.waitForTimeout(4000);
    const after = p.__afterPlay;
    const spanKm = +((c0.bounds.x1 - c0.bounds.x0) / 1000).toFixed(2);
    return { secs: +((Date.now() - t0) / 1000).toFixed(1), spanKm, skel: c0.skel,
             wideMap: c0.wideMap, fixedTiles: c0.fixed.length,
             afterPlay: [...new Set(after)], afterPlayCount: after.length,
             wideCityLoaded: spanKm > 17 && c0.wideMap === true,
             streetsKeepComing: after.includes('streets'),
             skeletonAskedOnce: !after.includes('arterials') && hits.arterials === 1 };
  }));

// 3i. every rung of the skeleton ladder refused: the game must still start, on the
// detailed centre alone, and must go back to streaming roads since there is no
// wide world to fall back on
results.push(await scenario('skeleton-fails-entirely',
  async (p, hits) => {
    await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Riga' }])));
    await p.route('**/api/interpreter', r => {
      const body = decodeURIComponent(r.request().postData() || '');
      if (isArterials(body)) { hits.arterials = (hits.arterials || 0) + 1;
        return r.fulfill({ status: 504, contentType: 'text/plain', body: 'gateway timeout' }); }
      if (isBuildingsQuery(r.request())) { hits.buildings++; return r.fulfill(json({ elements: [] })); }
      if (/amenity/.test(body) && !/highway/.test(body)) return r.fulfill(json({ elements: [] }));
      hits.streets++; r.fulfill(json(streets()));
    });
  },
  async (p, hits, t0) => {
    await p.click('#go');
    const w = await played(p, 90000);
    const c = await p.evaluate(() => window.__chunks());
    return { secs: +((Date.now() - t0) / 1000).toFixed(1), procedural: w.procedural,
             roads: w.roads, skel: c.skel, wideMap: c.wideMap,
             // no wide world, so tiles carry roads AND are recycled with them
             startedAnyway: w.procedural === false && w.roads > 0,
             keptStreaming: c.skel === null && c.wideMap === false };
  }));

// 4. buildings arrive late and must appear without a reload
results.push(await scenario('buildings-late',
  async (p, hits) => {
    await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Riga' }])));
    await p.route('**/api/interpreter', async r => {
      if (isBuildingsQuery(r.request())) { hits.buildings++; await new Promise(res => setTimeout(res, 2500)); return r.fulfill(json(buildings())); }
      if (serveWide(r, hits)) return;
      hits.streets++; r.fulfill(json(streets()));
    });
  },
  async (p, hits, t0) => {
    await p.click('#go');
    const w = await played(p);
    const atStart = w.buildings;
    await p.waitForFunction(() => window.__w().buildings > 0, null, { timeout: 20000 }).catch(() => {});
    const later = await p.evaluate(() => window.__w());
    return { startedInSec: +((Date.now() - t0) / 1000).toFixed(1), buildingsAtStart: atStart, buildingsLater: later.buildings, procedural: w.procedural };
  }));

// 5. a thin rural area must play as itself, not be replaced by a fake city
results.push(await scenario('thin-rural',
  async (p, hits) => {
    await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Somewhere quiet' }])));
    await p.route('**/api/interpreter', r => {
      if (isBuildingsQuery(r.request())) { hits.buildings++; return r.fulfill(json({ elements: [] })); }
      if (serveWide(r, hits)) return;
      hits.streets++; r.fulfill(json(thin()));
    });
  },
  async (p) => { await p.click('#go'); const w = await played(p); return { procedural: w.procedural, roads: w.roads, name: w.name }; }));

// 6a. geocoder unreachable: must still be playable, and must say why
results.push(await scenario('geocode-unreachable',
  async (p, hits) => {
    await p.route('**/nominatim.openstreetmap.org/**', r => { hits.geocode++; r.fulfill({ status: 403, contentType: 'text/plain', body: 'blocked' }); });
    await p.route('**/api/interpreter', r => r.fulfill(json(streets())));
  },
  async (p) => {
    await p.fill('#q', 'Riga, Latvia');
    await p.click('#go');
    const w = await played(p);
    return { procedural: w.procedural, name: w.name, sub: (await p.textContent('#loadSub')).trim().slice(0, 60) };
  }));

// 6b. a working geocoder that finds nothing: back to the menu to fix the spelling
results.push(await scenario('place-not-found',
  async (p, hits) => {
    await p.route('**/nominatim.openstreetmap.org/**', r => { hits.geocode++; r.fulfill(json([])); });
    await p.route('**/api/interpreter', r => r.fulfill(json(streets())));
  },
  async (p) => {
    await p.fill('#q', 'Nowhere at all');
    await p.click('#go');
    await p.waitForSelector('#menuErr.on', { timeout: 20000 });
    return { menuShown: await p.isVisible('#menu'), msg: (await p.textContent('#menuErr')).trim(), state: await p.evaluate(() => window.__s()) };
  }));

// 7. double-click DRIVE must not build two worlds
results.push(await scenario('double-click',
  async (p, hits) => {
    await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Riga' }])));
    await p.route('**/api/interpreter', async r => {
      if (isBuildingsQuery(r.request())) { hits.buildings++; return r.fulfill(json(buildings())); }
      if (serveWide(r, hits)) return;
      hits.streets++; await new Promise(res => setTimeout(res, 700)); r.fulfill(json(streets()));
    });
  },
  async (p) => {
    await p.click('#go'); await p.click('#go', { force: true }).catch(() => {});
    const w = await played(p);
    await p.waitForTimeout(2500);
    const end = await p.evaluate(() => window.__w());
    return { procedural: w.procedural, roads: end.roads, buildings: end.buildings };
  }));



await BROWSER.close();

/* THIS FILE HAD NO EXIT CODE. Twelve scenarios, every one of them printing its
   findings and the script exiting 0 whatever they said — so the suite has been
   reporting it green while 3h asserted, in as many words, that no streets
   request may fire after the loading screen goes down. That is the bug the log
   from Репиште was about, written down as an expectation and rubber-stamped for
   a release and a half. A test that cannot fail is a log.

   The gate is the named flags each scenario already computed, plus a page that
   did not throw and a scenario that did not blow up in the harness.

   NOT the console, though. Half of these scenarios exist to serve a 429, a 504,
   a 403 or a refused connection, and Chrome logs every one of them as a console
   error — so counting those is counting the fixture as a failure. Only a real
   page error or a game-side console.error means anything here. */
const FLAGS = ['routedAround', 'onlyRoadsAndPlaces', 'movedFeaturesStillArrive',
               'askedFewer', 'wideCityLoaded', 'streetsKeepComing', 'skeletonAskedOnce',
               'startedAnyway', 'keptStreaming'];
const SERVED = /Failed to load resource|ERR_CONNECTION_REFUSED|ERR_FAILED|ERR_ABORTED/;
const bad = [];
for (const r of results) {
  if (r.failed) { bad.push(`${r.name}: harness error — ${r.FAILED}`); continue; }
  for (const e of (r.errs || [])) if (!SERVED.test(e)) bad.push(`${r.name}: ${e}`);
  for (const f of FLAGS) if (f in r && r[f] !== true) bad.push(`${r.name}.${f} = ${r[f]}`);
}
console.log(JSON.stringify({ scenarios: results.length, pass: !bad.length, bad }, null, 1));
process.exit(bad.length ? 1 : 0);
