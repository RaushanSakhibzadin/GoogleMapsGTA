/* WHY THE PLAYER KEPT DYING, AND THE THREE THINGS THAT CHANGED.
 *
 * "Make me not die so often." Ninety simulated seconds of driving hard at a
 * delivery with two stars up, in the bundled city, said what was doing it:
 *
 *     buildings 486   traffic 39   police 12   blasts 0
 *
 * Buildings are ninety per cent of everything that happens to you, and the
 * reason is not that any one number was too big. It is that damage was
 * MONOTONIC — nothing in the game gave health back except a repair shop you have
 * to pay for, so a long session could only ever end one way however well you
 * drove. A hundred points of health had to last for ever.
 *
 * So: the wall hit is capped lower, the armor comes back when nothing has hit
 * you for a while, and police contact is rate-limited like everything else.
 *
 * MEASURED HERE RATHER THAN PLAYED. A scripted drive is far too noisy to A/B a
 * balance change — the same build over the same ninety seconds came back with
 * mean health of 47, 47 and 66, because a delivery target lands somewhere else
 * and the whole drive diverges. So this tests the MECHANISMS, deterministically,
 * one at a time, with each one A/B'd against the behaviour it replaced.
 */
import { chromium } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
await p.goto(GAME);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(600);

/* Where the car started, which is on a road by construction — resetRun puts it
   on the nearest road point to the origin. Both readings below teleport back to
   it, because cops are stocked on roads NEAR THE PLAYER and a player parked in
   the middle of a field gets none. */
const HOME = await p.evaluate(() => { const q = window.__p(); return { x: q.x, y: q.y, h: q.h }; });

/* Parked, alone, and not being driven into by anything. Every reading here is a
   number of health points, so anything else in the city that can take health has
   to be off the board or it is in the measurement — the first version of this
   left the traffic running, and 19 simulated seconds later a parked car with 64
   health had been rammed to zero, respawned at a hospital and come back reading
   100. It looked exactly like a broken cap. */
const park = () => p.evaluate(h => {
  window.__ghost(false);
  window.__tp(h.x, h.y, h.h);
  traffic.length = 0; peds.length = 0; cops.length = 0;
  window.__addWanted(-9);
  window.__setInput({ gas: 0, brake: 1, steer: 0, hand: 0 });
}, HOME);

const out = {};

/* ---- 1. the numbers are where they say they are ---- */
out.caps = await p.evaluate(() => ({
  bld: BLD_MAX, traffic: TRAFFIC_MAX, cop: COP_MAX, blast: BLAST_MAX,
  after: REGEN_AFTER, rate: REGEN_RATE, cap: REGEN_CAP
}));
/* No single hit may be more than a third of your life, and the regeneration must
   stop well short of full or the repair shop has nothing left to sell. */
out.noHitIsAThird = Math.max(out.caps.bld, out.caps.traffic, out.caps.cop,
                             out.caps.blast) <= 40;
out.regenIsALimpHome = out.caps.cap <= 70 && out.caps.after >= 5;

/* ---- 2. the armor comes back, and stops ----

   Driven off the simulated clock rather than the wall clock, because the loop
   caps the physics at five steps a frame and headless Chromium renders the chase
   view at about eight frames a second: a "twenty second" wait measured with
   setTimeout is nothing like twenty seconds of game. */
await park();
out.regen = await p.evaluate(async () => {
  const wait = secs => new Promise(res => {
    const t0 = window.__simT();
    const tick = () => {
      traffic.length = 0; peds.length = 0; cops.length = 0;   // and they stay off
      /* AND THE CAR IS HELD STILL, not merely braked. It was only braked, and it
         still took 35 points off a wall over nineteen seconds — because the
         bundled city's spawn sits against a footprint on a slope, so the car
         creeps into it, is pushed out, and creeps back. Real, and not what this
         section is measuring. */
      P.car.vx = P.car.vy = 0;
      window.__simT() - t0 < secs ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  window.__addWanted(-9);
  P.car.hp = 20;
  P.calm = 0;
  await wait(REGEN_AFTER - 2);
  const early = +P.car.hp.toFixed(1);        // still inside the window: untouched
  await wait(12);
  const later = +P.car.hp.toFixed(1);        // past it: climbing
  const cash0 = P.cash;
  P.car.hp = REGEN_CAP - 1;
  await wait(REGEN_AFTER + 12);
  const capped = +P.car.hp.toFixed(1);       // and it stops
  const died = window.__dmg().deaths, by = window.__dmg();
  window.__setInput(null);
  return { early, later, capped, cap: REGEN_CAP, cashSpent: cash0 - P.cash, died, by };
});
out.waitsBeforeItStarts = out.regen.early === 20;
out.thenItClimbs = out.regen.later > 30;
out.andItStops = out.regen.died === 0 &&
                 Math.abs(out.regen.capped - out.regen.cap) < 0.02;

/* ---- 3. and being hit puts it back to the start ----

   The window is the whole reason this is a reward for driving cleanly rather
   than a free hundred points a minute, so a hit has to reset it. Without that
   line the healing simply continues through the crash. */
await park();
out.hitResets = await p.evaluate(async () => {
  const wait = secs => new Promise(res => {
    const t0 = window.__simT();
    const tick = () => {
      traffic.length = 0; peds.length = 0; cops.length = 0;
      window.__simT() - t0 < secs ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  P.car.hp = 30; P.calm = 0;
  await wait(REGEN_AFTER + 1);
  const climbing = P.car.hp > 30;            // it had started
  const at = P.car.hp;
  hurtPlayer(5, 'bld');                      // one scrape
  await wait(REGEN_AFTER - 3);
  // it must be exactly five down and going nowhere: the window restarted
  const after = +P.car.hp.toFixed(1);
  window.__setInput(null);
  return { climbing, held: Math.abs(after - (at - 5)) < 0.6 };
});
out.aHitRestartsTheWindow = out.hitResets.climbing && out.hitResets.held;

/* ---- 4. police contact is rate-limited now ----

   This was the one damage source in the game with no cooldown on it. Buildings
   are capped at one hit per 0.45 s and traffic at one per 0.6 s, each with a
   comment saying why; a cruiser leaning on the car took health on every frame it
   was touching, which is sixty hits a second where a wall would have been two.

   STAGED BY HOLDING THEM TOGETHER, because that is the state being fixed — a
   roadblock, not a passing shunt. The player is pinned and a cop is put on top
   of it and re-put every frame, so they are always in contact and always
   closing. A/B'd by clearing P.copCd each frame, which is the old behaviour
   exactly. */
const shove = noCd => p.evaluate(async a => {
  const [noCooldown, h] = a;
  /* THE COLLISION IS STUBBED, and that is the point rather than a shortcut.

     Staging a real cruiser ramming a real car turned out to measure the police
     AI and not the rule: the cop is steered by updateCop every frame, so a car
     placed 2.2 m away and told to close simply braked, and the reading came back
     as zero damage with three cops on screen. What is being tested here is one
     line — how OFTEN contact is allowed to cost health — so contact is asserted
     to exist and the rule is left to answer for itself.

     carsCollide is a plain function declaration in the global scope, so it can
     be replaced for the reading and put back. Traffic and pedestrians are off,
     so the only caller left is the police loop. */
  const real = window.carsCollide;
  window.carsCollide = () => 9;              // always touching, always closing at 9 m/s
  window.__ghost(false);
  window.__heal();
  window.__tp(h.x, h.y, h.h);
  window.__addWanted(-9);
  await new Promise(r => requestAnimationFrame(r));
  window.__addWanted(2);
  await new Promise(r => requestAnimationFrame(r));
  const n = cops.length;
  window.__dmgReset();
  P.calm = -1e6;                             // no regeneration inside the reading
  const t0 = window.__simT();
  await new Promise(res => {
    const tick = () => {
      if (noCooldown) P.copCd = 0;           // as it was: no rate limit at all
      traffic.length = 0; peds.length = 0;
      window.__heal();                       // so it cannot die mid-reading
      window.__simT() - t0 < 3 ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  const took = window.__dmg().cop;
  window.carsCollide = real;
  P.calm = 0;
  window.__addWanted(-9);
  return { cops: n, took: +took.toFixed(1) };
}, [noCd, HOME]);
out.copPinned = await shove(false);
out.copPinnedNoCooldown = await shove(true);
/* Three seconds of continuous contact is five ticks at 0.6 s, so at most five
   hits per cop — and the version with no cooldown has to be very much worse, or
   this is measuring nothing at all. */
out.copIsRateLimited =
  out.copPinned.cops > 0 &&
  out.copPinned.took <= out.caps.cop * 6 * out.copPinned.cops &&
  out.copPinnedNoCooldown.took > out.copPinned.took * 3;

/* ---- 5. and none of it revives the dead ----

   The regeneration runs in update() a few lines above the death check, so a
   player on zero health for one frame would otherwise be healed back out of it
   and the death would never fire. */
out.dead = await p.evaluate(async () => {
  window.__heal();
  P.calm = 1e6;                              // regeneration wide open
  window.__hurt();                           // straight to zero
  await new Promise(res => {
    const t0 = window.__simT();
    const tick = () => (window.__simT() - t0 < 1 ? requestAnimationFrame(tick) : res());
    requestAnimationFrame(tick);
  });
  return { dead: window.__p().dead, hp: window.__p().hp };
});
out.zeroIsStillDead = out.dead.dead === true;

out.errs = errs.slice(0, 3);
out.pass = out.noHitIsAThird && out.regenIsALimpHome && out.waitsBeforeItStarts &&
           out.thenItClimbs && out.andItStops && out.aHitRestartsTheWindow &&
           out.copIsRateLimited && out.zeroIsStillDead && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
