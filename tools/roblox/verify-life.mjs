/* DOES THE TRAFFIC ACTUALLY STAY ON THE ROAD? Run the sim in Node and measure.
 *
 *   node tools/roblox/verify-life.mjs
 *
 * WHY THIS EXISTS. Nothing in this repository can execute a line of Luau, so
 * every bug in Shared/Traffic and Shared/Pedestrians costs a round trip through
 * somebody's screen in Studio: they drive around for a minute, they say "the
 * cars get stuck", and that is the whole of the diagnostic information.
 *
 * So the parts of those two files that can be wrong are transliterated here --
 * Streets, Traffic.driveOne, Pedestrians.walk, and VehicleModel.step, which
 * they run on -- and pointed at the ACTUAL emitted RoadNet.luau, SolidMask.luau
 * and RoadMask.luau. That exercises the one-based indexing, the aim-point walk,
 * the junction table and the baked data together, which is where the bugs are.
 *
 * IT IS A TRANSLITERATION AND NOT THE ARTICLE, which is the honest caveat: the
 * two copies can drift, and a bug this passes may still be in the Luau. What it
 * cannot do is miss an algorithm that does not work, and that is what it is
 * for. Three real bugs were found by it and none of them by reading:
 *
 *   1. Traffic reversed at the end of every OSM way. Ways here are 62 m long,
 *      so that was a U-turn every five seconds, through the pavement and into
 *      the building behind it. -> RoadNet.links, and Traffic.leaveWay.
 *   2. Pedestrians whose pavement was built over on BOTH sides flipped from one
 *      side to the other for ever without moving. Eight of thirty-four were
 *      doing it, 2,600 flips each in ninety seconds.
 *   3. A pedestrian who ended up inside a footprint could never leave it: the
 *      solid test looks one step ahead, so every direction out was blocked.
 *
 * The measurements it prints, on the district as shipped:
 *
 *              before          after
 *   traffic inside a footprint  12.8%          1.0%
 *   lane error, median          0.76 m         0.18 m
 *   pedestrians that never move  8 of 34       0 of 34
 *
 * Usage: node tools/roblox/verify-life.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* SEEDED, so a number that moves means the code moved.
 *
 * With Math.random the figures below swing by a factor of three between runs --
 * thirty-four pedestrians is a small sample and two of them spawned on a
 * built-over pavement is most of one statistic -- which makes every threshold
 * either useless or flaky. Same reasoning as the bake's own determinism.
 *
 * Pass a seed to sweep it:  node tools/roblox/verify-life.mjs 7 */
let SEED = (Number(process.argv[2]) || 1) >>> 0 || 1;
const random = () => {
  // xorshift32: not a good generator, entirely good enough to place cars
  SEED ^= SEED << 13; SEED >>>= 0;
  SEED ^= SEED >>> 17;
  SEED ^= SEED << 5; SEED >>>= 0;
  return SEED / 4294967296;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ---------------- parse the emitted Luau ---------------- */

const netSrc = readFileSync(`${root}/roblox/src/ReplicatedStorage/Shared/RoadNet.luau`, 'utf8');
const CELL = Number(netSrc.match(/\tcell = (\d+),/)[1]);

const ways = [];
for (const m of netSrc.matchAll(/\{ w = ([\d.]+), len = ([\d.]+), oneway = (true|false), pts = \{ ([^}]*) \} \},/g)) {
  ways.push({ i: ways.length + 1, w: +m[1], len: +m[2], oneway: m[3] === 'true', pts: m[4].split(', ').map(Number) });
}
const bucketBlock = netSrc.slice(netSrc.indexOf('\tbuckets = {'), netSrc.indexOf('\tlinks = {'));
const buckets = new Map();
for (const m of bucketBlock.matchAll(/\t\t\[(-?\d+)\] = \{ ([^}]*) \},/g))
  buckets.set(+m[1], m[2].split(', ').map(Number));
const linkBlock = netSrc.slice(netSrc.indexOf('\tlinks = {'));
const links = new Map();
for (const m of linkBlock.matchAll(/\t\t\[(\d+)\] = \{ (.*) \},\n/g)) {
  const per = new Map();
  for (const e of m[2].matchAll(/\[(\d+)\] = \{ ?([^}]*?) ?\},/g))
    per.set(+e[1], e[2] ? e[2].split(', ').map(Number) : []);
  links.set(+m[1], per);
}
console.log(`links parsed for ${links.size} ways, ` +
  `${[...links.values()].reduce((a, p) => a + [...p.values()].reduce((b, l) => b + l.length / 3, 0), 0)} continuations`);

function turning(way, endNode, hx, hy) {
  const per = links.get(way.i);
  if (!per) return null;
  const out = per.get(endNode);
  if (!out || !out.length) return null;
  let bw = null, bn = 0, bd = 0, bs = -Infinity;
  for (let k = 0; k < out.length; k += 3) {
    const w = ways[out[k] - 1], nd = out[k + 1], dir = out[k + 2];
    const [ax, ay] = node(w, nd), [bx, by] = node(w, nd + dir);
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 1e-6) continue;
    const straight = ((bx - ax) / L) * hx + ((by - ay) / L) * hy;
    if (straight < -0.4) continue;
    const score = straight + random() * 0.5;
    if (score > bs) { bs = score; bw = w; bn = nd; bd = dir; }
  }
  return bw ? { way: bw, node: bn, dir: bd } : null;
}

const solSrc = readFileSync(`${root}/roblox/src/ReplicatedStorage/Shared/SolidMask.luau`, 'utf8');
const SSPAN = Number(solSrc.match(/span = (\d+)/)[1]);
const SCELL = Number(solSrc.match(/cellM = ([\d.]+)/)[1]);
const SORIGIN = Number(solSrc.match(/originM = (-?[\d.]+)/)[1]);
const SBITS = Buffer.from(solSrc.match(/bits = "([^"]*)"/)[1], 'base64');

console.log(`RoadNet: ${ways.length} ways, ${buckets.size} buckets, cell ${CELL}`);
console.log(`SolidMask: ${SSPAN}^2 at ${SCELL} m, origin ${SORIGIN}, ${SBITS.length} bytes`);

/* ---------------- Streets, one-based like the Luau ---------------- */

const nodeCount = w => w.pts.length / 2;
const node = (w, i) => [w.pts[i * 2 - 2], w.pts[i * 2 - 1]];   // Luau pts[i*2-1], pts[i*2]

let NEAR = [];
function segsNear(x, y, maxD) {
  NEAR = [];
  const gx0 = Math.floor((x - maxD) / CELL), gx1 = Math.floor((x + maxD) / CELL);
  const gy0 = Math.floor((y - maxD) / CELL), gy1 = Math.floor((y + maxD) / CELL);
  for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
    const a = buckets.get(gx * 8192 + gy);
    if (a) NEAR.push(...a);
  }
  return NEAR;
}

function roadPoint(fx, fy, minD, maxD, minLen) {
  let pool = null;
  if (minD != null) { pool = segsNear(fx, fy, maxD || 400); if (!pool.length) return null; }
  for (let t = 0; t < 260; t++) {
    let way, i;
    if (pool) {
      const k = (1 + Math.floor(random() * (pool.length / 2)) - 1) * 2;
      way = ways[pool[k] - 1]; i = pool[k + 1];
    } else {
      way = ways[Math.floor(random() * ways.length)];
      i = 1 + Math.floor(random() * Math.max(1, nodeCount(way) - 1));
    }
    if (!way) continue;
    if (minLen && way.len < minLen) continue;
    const [ax, ay] = node(way, i);
    const [bx, by] = node(way, Math.min(i + 1, nodeCount(way)));
    const u = random();
    const px = ax + (bx - ax) * u, py = ay + (by - ay) * u;
    const h = Math.atan2(by - ay, bx - ax);
    if (minD == null) return { x: px, y: py, h, way, idx: i };
    const d = Math.hypot(px - fx, py - fy);
    if (d >= minD && d <= maxD) return { x: px, y: py, h, way, idx: i };
  }
  return null;
}

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const laneOffset = w => clamp((w.w > 0 ? w.w : 8) * 0.25, 1.2, 3.5);
const pedOffset = w => (w.w > 0 ? w.w : 6) * 0.5 + 1.5;

function pedWalkPoint(way, idx, dir, side) {
  const n = nodeCount(way);
  if (n < 2) return null;
  const i = clamp(idx, 1, n);
  const [ax, ay] = node(way, i);
  let j = i - dir, flip = 1;
  if (j < 1 || j > n) { j = i + dir; flip = -1; }
  if (j < 1 || j > n) return null;
  const [bx, by] = node(way, j);
  let hx = (ax - bx) * flip, hy = (ay - by) * flip;
  const L = Math.hypot(hx, hy);
  if (L < 1e-6) return null;
  hx /= L; hy /= L;
  const off = pedOffset(way);
  return { x: ax - hy * off * side, y: ay + hx * off * side };
}

function solidAt(x, y) {
  const i = Math.floor((x - SORIGIN) / SCELL), j = Math.floor((y - SORIGIN) / SCELL);
  if (i < 0 || i >= SSPAN || j < 0 || j >= SSPAN) return false;
  const at = j * SSPAN + i;
  return ((SBITS[Math.floor(at / 8)] >> (at % 8)) & 1) === 1;
}

/* ---------------- VehicleModel.step ---------------- */

const decay = (k, dt) => 1 - Math.exp(-k * dt);
const lerp = (a, b, t) => a + (b - a) * t;
const TOP_SPEED = 100, STRAY_TOP = 4.5, STRAY_DRAG = 9.5;

function newCar(x, y, h) {
  return { x, y, h, vx: 0, vy: 0, steer: 0, gasT: 0, brakeT: 0, road: true,
           maxSpeed: TOP_SPEED, accel: 40, turn: 2.7, w: 2.0, l: 4.5, kind: 'player' };
}

function step(c, inp, dt, onTarmac, revReal) {
  const throttle = inp.gas > 0, brake = inp.brake > 0, hand = inp.hand > 0;
  const steerIn = inp.steer;
  const cs = Math.cos(c.h), sn = Math.sin(c.h);
  let vf = c.vx * cs + c.vy * sn;
  let vl = -c.vx * sn + c.vy * cs;
  let stray = false;
  if (onTarmac) { c.road = onTarmac(c.x, c.y); stray = !c.road; } else c.road = true;
  const grip = c.road ? 1 : 0.58;
  const top = stray ? STRAY_TOP : c.maxSpeed * grip;
  c.gasT += ((throttle ? 1 : 0) - c.gasT) * decay(throttle ? 5.5 : 8, dt);
  c.brakeT += ((brake ? 1 : 0) - c.brakeT) * decay(brake ? 11 : 14, dt);
  if (c.gasT > 0.002) vf += c.accel * dt * c.gasT * (vf < 0 ? 2.2 : 1);
  if (c.brakeT > 0.002) vf -= (vf > 0.8 ? c.accel * 1.9 : c.accel * 0.55) * dt * c.brakeT;
  if (!throttle && !brake) vf -= vf * decay(0.9, dt);
  vf -= vf * decay(c.road ? 0.32 : (stray ? STRAY_DRAG : 1.5), dt);
  if (hand) vf -= vf * decay(0.5, dt);
  vf = clamp(vf, -top * 0.45, top);
  const lat = hand ? 1.7 : (c.road ? 9.5 : 6.5);
  vl -= vl * decay(lat, dt);
  const spd = Math.abs(vf);
  const rolling = clamp(spd / 4.5, 0, 1);
  const auth = hand ? 0.92 : lerp(1, 0.34, clamp(spd / 30, 0, 1));
  c.steer += (steerIn - c.steer) * decay(Math.abs(steerIn) > Math.abs(c.steer) ? 7 : 11, dt);
  const yaw = c.steer * c.turn * auth * rolling;
  const backwards = (!hand) && vf < -0.5;
  const flipSteer = backwards && revReal === true;
  c.h += yaw * dt * (flipSteer ? -1 : 1);
  const cs2 = Math.cos(c.h), sn2 = Math.sin(c.h);
  c.vx = cs2 * vf - sn2 * vl;
  c.vy = sn2 * vf + cs2 * vl;
  c.x += c.vx * dt;
  c.y += c.vy * dt;
}

const angDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

/* ---------------- Traffic.driveOne ---------------- */

const GAP_STOP = 7, GAP_SEE = 22;
const rand = (a, b) => a + random() * (b - a);

function makeNpc(x, y, h) {
  const c = newCar(x, y, h);
  c.kind = 'traffic';
  c.w = rand(1.85, 2.15); c.l = rand(4.1, 4.9);
  c.maxSpeed = rand(11, 17); c.accel = 7; c.turn = 2.7;
  return { car: c, way: ways[0], idx: 1, dir: 1, mass: 1 };
}

let uturns = 0, turns = 0;
function driveOne(all, n, dt) {
  const t = n.car;
  let r = n.way;
  let nodes = nodeCount(r);
  if (nodes < 2) return;
  n.idx = clamp(n.idx, 1, nodes);
  const spd = Math.hypot(t.vx, t.vy);
  const reach = 6 + spd * 0.35;
  const fx = Math.cos(t.h), fy = Math.sin(t.h);
  for (let g = 0; g < 8; g++) {
    const [nx, ny] = node(r, n.idx);
    const dx0 = nx - t.x, dy0 = ny - t.y;
    const d2 = dx0 * dx0 + dy0 * dy0;
    const done = d2 < reach * reach || (dx0 * fx + dy0 * fy < 0 && d2 < 900);
    if (!done) break;
    n.idx += n.dir;
    if (n.idx < 1 || n.idx > nodes) {
      const ranOff = n.dir > 0 ? nodes : 1;
      const j = turning(r, ranOff, Math.cos(t.h), Math.sin(t.h));
      if (j) { n.way = j.way; n.dir = j.dir; n.idx = clamp(j.node + j.dir, 1, nodeCount(j.way)); turns++; break; }
      uturns++;
      n.dir = -n.dir; n.idx = clamp(n.idx + 2 * n.dir, 1, nodes); break;
    }
  }
  r = n.way; nodes = nodeCount(r);
  if (nodes < 2) return;
  const LOOK = 10 + spd * 0.6;
  let [ax, ay] = node(r, n.idx);
  let left = LOOK - Math.hypot(ax - t.x, ay - t.y), k = n.idx;
  let dux = Math.cos(t.h), duy = Math.sin(t.h);
  const setDir = (i, j) => {
    const [iax, iay] = node(r, i), [ibx, iby] = node(r, j);
    const L = Math.hypot(ibx - iax, iby - iay);
    if (L > 1e-6) { dux = (ibx - iax) / L; duy = (iby - iay) / L; }
  };
  if (n.idx + n.dir >= 1 && n.idx + n.dir <= nodes) setDir(n.idx, n.idx + n.dir);
  while (left > 0) {
    const nk = k + n.dir;
    if (nk < 1 || nk > nodes) break;
    const [sax, say] = node(r, k), [sbx, sby] = node(r, nk);
    const seg = Math.hypot(sbx - sax, sby - say);
    if (seg >= left) { const u = left / seg; ax = sax + (sbx - sax) * u; ay = say + (sby - say) * u; setDir(k, nk); break; }
    ax = sbx; ay = sby; left -= seg; k = nk; setDir(k - n.dir, k);
  }
  const off = laneOffset(r);
  ax -= duy * off; ay += dux * off;
  const dx = ax - t.x, dy = ay - t.y;
  if (dx * dx + dy * dy < 1) { step(t, { gas: 0, brake: 1, steer: 0, hand: 0 }, dt); return; }
  const want = Math.atan2(dy, dx);
  const steer = clamp(angDiff(t.h, want) * 2.2, -1, 1);
  let throttle = 1, brake = 0;
  let lead = Infinity;
  for (const o of all) {
    if (o === n) continue;
    const rx = o.car.x - t.x, ry = o.car.y - t.y;
    const fwd = rx * fx + ry * fy;
    if (fwd <= 0 || fwd > GAP_SEE) continue;
    if (Math.abs(-rx * fy + ry * fx) > 3.2) continue;
    if (fwd < lead) lead = fwd;
  }
  if (lead < GAP_STOP) brake = 1;
  else if (lead < GAP_SEE) throttle = Math.max(0, (lead - GAP_STOP) / (GAP_SEE - GAP_STOP));
  step(t, { gas: brake ? 0 : throttle, brake, steer, hand: 0 }, dt);
}

/* ---------------- the drivable mask, for scoring ---------------- */

const mm = readFileSync(`${root}/roblox/src/ReplicatedStorage/Shared/RoadMask.luau`, 'utf8');
const MSPAN = Number(mm.match(/span = (\d+)/)[1]);
const MCELL = Number(mm.match(/cellM = ([\d.]+)/)[1]);
const MORIGIN = Number(mm.match(/originM = (-?[\d.]+)/)[1]);
const MBITS = Buffer.from(mm.match(/bits = "([^"]*)"/)[1], 'base64');
function isRoad(x, y) {
  const i = Math.floor((x - MORIGIN) / MCELL), j = Math.floor((y - MORIGIN) / MCELL);
  if (i < 0 || i >= MSPAN || j < 0 || j >= MSPAN) return false;
  const at = j * MSPAN + i;
  return ((MBITS[Math.floor(at / 8)] >> (at % 8)) & 1) === 1;
}
// nearRoad: this cell or any of the eight around it, which is what Tarmac does
function nearRoad(x, y) {
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++)
    if (isRoad(x + i * MCELL, y + j * MCELL)) return true;
  return false;
}

/* ---------------- run it ---------------- */

const CAP = 78, DT = 1 / 30, SECS = 90;
const px = 0, py = 0;                       // the player, parked at the origin

const cars = [];
function spawn(count, wide) {
  const r1 = 260 - 4, r0 = wide ? 30 : 200;
  for (let i = 0; i < count; i++) {
    const p = roadPoint(px, py, r0, r1, 60) || roadPoint(px, py, r0, r1) || roadPoint(px, py, 30, r1);
    if (!p) continue;
    const dir = random() < 0.5 ? 1 : -1;
    const h = dir > 0 ? p.h : p.h + Math.PI;
    const off = laneOffset(p.way);
    const sx = p.x + Math.cos(h + Math.PI / 2) * off;
    const sy = p.y + Math.sin(h + Math.PI / 2) * off;
    let taken = false;
    for (const o of cars) if ((o.car.x - sx) ** 2 + (o.car.y - sy) ** 2 < 49) { taken = true; break; }
    if (taken) continue;
    const n = makeNpc(sx, sy, h);
    n.way = p.way; n.idx = p.idx; n.dir = dir;
    cars.push(n);
  }
}
spawn(CAP, true);
console.log(`\nspawned ${cars.length} of ${CAP}`);

const D = JSON.parse(readFileSync(`${root}/tools/roblox/build/district.json`, 'utf8'));
const GG = 40, gk = (a, b) => a * 8192 + b;
const bldGrid = new Map();
for (const b of D.buildings) {
  const [x0, y0, x1, y1] = b.bb;
  for (let gx = Math.floor(x0 / GG); gx <= Math.floor(x1 / GG); gx++)
    for (let gy = Math.floor(y0 / GG); gy <= Math.floor(y1 / GG); gy++) {
      const k = gk(gx, gy); let a = bldGrid.get(k); if (!a) bldGrid.set(k, a = []); a.push(b);
    }
}
const inPoly = (pts, x, y) => { let o = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const a = pts[i], b = pts[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) o = !o; } return o; };
const inRealBuilding = (x, y) => {
  const arr = bldGrid.get(gk(Math.floor(x / GG), Math.floor(y / GG)));
  if (!arr) return false;
  for (const b of arr) { const [x0, y0, x1, y1] = b.bb;
    if (x < x0 || x > x1 || y < y0 || y > y1) continue; if (inPoly(b.pts, x, y)) return true; }
  return false;
};

const latErr = [];
let samples = 0, onRoad = 0, offRoad = 0, escaped = 0, inBuilding = 0, inReal = 0;
let worstOff = 0;
for (let f = 0; f < SECS / DT; f++) {
  for (const n of cars) { const ox = n.car.x, oy = n.car.y; driveOne(cars, n, DT);
    n.dist = (n.dist || 0) + Math.hypot(n.car.x - ox, n.car.y - oy); }
  if (f % 15 === 0) {                       // sample twice a second
    for (const n of cars) {
      samples++;
      if (nearRoad(n.car.x, n.car.y)) onRoad++; else offRoad++;
      if (solidAt(n.car.x, n.car.y)) inBuilding++;
      if (inRealBuilding(n.car.x, n.car.y)) { inReal++; n.badSamples = (n.badSamples || 0) + 1; }
      // lateral error against the car's OWN way
      { const r = n.way; let best = Infinity;
        for (let k = 1; k <= nodeCount(r) - 1; k++) {
          const [ax, ay] = node(r, k), [bx, by] = node(r, k + 1);
          const ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey || 1e-9;
          const t = clamp(((n.car.x - ax) * ex + (n.car.y - ay) * ey) / L2, 0, 1);
          const d = Math.hypot(n.car.x - (ax + ex * t), n.car.y - (ay + ey * t));
          if (d < best) best = d;
        }
        latErr.push(Math.abs(best - laneOffset(r)));
      }
      if (Math.abs(n.car.x) > 700 || Math.abs(n.car.y) > 700) escaped++;
    }
  }
}
console.log(`after ${SECS}s of ${CAP} cars at ${1 / DT} Hz:`);
console.log(`  on the road mask   ${(100 * onRoad / samples).toFixed(1)}%  (${offRoad} of ${samples} samples off)`);
console.log(`  inside the 3 m mask ${(100 * inBuilding / samples).toFixed(1)}%`);
console.log(`  inside a real footprint ${(100 * inReal / samples).toFixed(1)}%`);
console.log(`  outside +/-700 m   ${escaped}`);
const cd = cars.map(n => n.dist || 0).sort((a, b) => a - b);
console.log(`  distance driven m: min ${cd[0].toFixed(0)} median ${cd[cd.length >> 1].toFixed(0)} max ${cd[cd.length - 1].toFixed(0)}`);
const speeds = cars.map(n => Math.hypot(n.car.vx, n.car.vy));
latErr.sort((a, b) => a - b);
const q = f => latErr[Math.floor(latErr.length * f)].toFixed(2);
console.log(`  lateral error vs lane m: median ${q(0.5)}  p90 ${q(0.9)}  p99 ${q(0.99)}  max ${latErr[latErr.length - 1].toFixed(2)}`);
const bad = cars.filter(n => (n.badSamples || 0) > 0).length;
const veryBad = cars.filter(n => (n.badSamples || 0) > 90).length;
console.log(`  cars ever in a footprint ${bad} of ${cars.length}; in one for >half the run ${veryBad}`);
console.log(`  junctions taken ${turns}, U-turns ${uturns}`);
console.log(`  speed m/s: min ${Math.min(...speeds).toFixed(1)} mean ${(speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(1)} max ${Math.max(...speeds).toFixed(1)}`);

/* ---------------- pedestrians ---------------- */

const peds = [];
for (let i = 0; i < 34; i++) {
  const p = roadPoint(px, py, 40, 180);
  if (!p) continue;
  const side = random() < 0.5 ? -1 : 1;
  const dir = random() < 0.5 ? 1 : -1;
  const q = pedWalkPoint(p.way, p.idx, dir, side);
  peds.push({ x: q ? q.x : p.x, y: q ? q.y : p.y, way: p.way, idx: p.idx, dir, side,
              spd: rand(1.0, 1.7), h: 0, holds: 0 });
}

function pedHold(p) {
  const r = p.way, n = nodeCount(r);
  if (n < 2) return;
  const half = (r.w > 0 ? r.w : 6) * 0.5, want = pedOffset(r);
  for (let pass = 0; pass < 2; pass++) {
    let bl = Infinity, bx = 0, by = 0, bnx = 0, bny = 0;
    for (let k = 1; k <= n - 1; k++) {
      const [ax, ay] = node(r, k), [cx, cy] = node(r, k + 1);
      if (p.x < Math.min(ax, cx) - half || p.x > Math.max(ax, cx) + half ||
          p.y < Math.min(ay, cy) - half || p.y > Math.max(ay, cy) + half) continue;
      const ex = cx - ax, ey = cy - ay, L2 = ex * ex + ey * ey;
      if (L2 < 1e-6) continue;
      const t = clamp(((p.x - ax) * ex + (p.y - ay) * ey) / L2, 0, 1);
      const qx = ax + ex * t, qy = ay + ey * t;
      const latd = Math.hypot(p.x - qx, p.y - qy);
      if (latd >= bl) continue;
      const L = Math.sqrt(L2);
      bl = latd; bx = qx; by = qy; bnx = -ey / L; bny = ex / L;
    }
    if (bl >= half) return;
    const sgn = (p.x - bx) * bnx + (p.y - by) * bny >= 0 ? 1 : -1;
    p.x = bx + bnx * want * sgn; p.y = by + bny * want * sgn;
    p.holds++;
  }
}

function walk(p, dt) {
  const q = pedWalkPoint(p.way, p.idx, p.dir, p.side);
  if (!q) return;
  const dx = q.x - p.x, dy = q.y - p.y;
  let d = Math.hypot(dx, dy); if (d < 1e-6) d = 1e-6;
  if (d < 1.2) {
    const nodes = nodeCount(p.way), nxt = p.idx + p.dir;
    if (nxt < 1 || nxt > nodes) { p.dir = -p.dir; p.side = -p.side; p.idx = clamp(p.idx + p.dir, 1, nodes); }
    else p.idx = nxt;
    return;
  }
  const s = p.spd * dt;
  const nx = p.x + dx / d * s, ny = p.y + dy / d * s;
  if (solidAt(p.x, p.y)) {
    p.inside = (p.inside || 0) + 1;
    p.x = nx; p.y = ny; pedHold(p); p.h = Math.atan2(dy, dx);
    return;
  }
  if (solidAt(nx, ny)) {
    p.flips = (p.flips || 0) + 1;
    p.blocked = (p.blocked || 0) + 1;
    if (p.blocked <= 30) {
      const o = pedWalkPoint(p.way, p.idx, p.dir, -p.side);
      if (o && !solidAt(o.x, o.y)) { p.side = -p.side; return; }
      const nodes = nodeCount(p.way), nxt = p.idx + p.dir;
      if (nxt < 1 || nxt > nodes) { p.dir = -p.dir; p.side = -p.side; p.idx = clamp(p.idx + p.dir, 1, nodes); }
      else p.idx = nxt;
      return;
    }
  }
  p.blocked = 0;
  p.x = nx; p.y = ny;
  pedHold(p);
  p.h = Math.atan2(dy, dx);
}

const pavErr = [];
let pSamples = 0, pInB = 0, pOnCarriageway = 0;
for (let f = 0; f < SECS / DT; f++) {
  for (const p of peds) { const ox = p.x, oy = p.y; walk(p, DT); p.dist = (p.dist || 0) + Math.hypot(p.x - ox, p.y - oy); }
  if (f % 15 === 0) for (const p of peds) {
    pSamples++;
    if (inRealBuilding(p.x, p.y)) pInB++;
    // on the carriageway: within half the width of any nearby centreline
    // against their OWN way, which is the one pedHold guarantees clearance from
    { const w = p.way; let best = Infinity;
      for (let k = 1; k <= nodeCount(w) - 1; k++) {
        const [ax, ay] = node(w, k), [bx, by] = node(w, k + 1);
        const ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey || 1e-9;
        const t = clamp(((p.x - ax) * ex + (p.y - ay) * ey) / L2, 0, 1);
        const d = Math.hypot(p.x - (ax + ex * t), p.y - (ay + ey * t));
        if (d < best) best = d;
      }
      if (best < w.w * 0.5) pOnCarriageway++;
      pavErr.push(Math.abs(best - pedOffset(w)));
    }
  }
}
console.log(`\nafter ${SECS}s of ${peds.length} pedestrians:`);
console.log(`  inside a real footprint ${(100 * pInB / pSamples).toFixed(2)}%  (${pInB} of ${pSamples})`);
console.log(`  on their own carriageway ${(100 * pOnCarriageway / pSamples).toFixed(2)}%`);
pavErr.sort((a, b) => a - b);
const pq = f => pavErr[Math.floor(pavErr.length * f)].toFixed(2);
console.log(`  pavement error m: median ${pq(0.5)} p90 ${pq(0.9)} p99 ${pq(0.99)}`);
const dists = peds.map(p => p.dist || 0).sort((a, b) => a - b);
console.log(`  distance walked m: min ${dists[0].toFixed(0)} median ${dists[Math.floor(dists.length / 2)].toFixed(0)} max ${dists[dists.length - 1].toFixed(0)}  (expected ~${(1.35 * SECS).toFixed(0)})`);
console.log(`  never moved: ${dists.filter(d => d < 5).length} of ${peds.length}`);
console.log(`  lateral corrections ${peds.reduce((a, p) => a + p.holds, 0)}`);
console.log(`  blocked steps       ${peds.reduce((a, p) => a + (p.flips || 0), 0)}` +
            `, of which walked out of a footprint ${peds.reduce((a, p) => a + (p.inside || 0), 0)}`);


/* ---------------- and what has to be true ----------------

   Thresholds, not exact numbers: the sim is seeded off Math.random and the
   figures move a point or two between runs. Each one is set well clear of what
   the code does today and just tight enough to catch the bug it stands for. */

const checks = [
  ['traffic stays on the road mask', 100 * onRoad / samples, '>=', 97],
  ['traffic stays out of buildings', 100 * inReal / samples, '<=', 4],
  ['traffic holds its lane (median)', +q(0.5), '<=', 1.0],
  ['no traffic left the district', escaped, '<=', 0],
  // DISTANCE DRIVEN, not displacement: a car that goes round a block and comes
  // back is not stuck, and a car held at the back of a queue for a while is not
  // either. Under 30 m in ninety seconds is a car that never went anywhere.
  ['no traffic car is stuck', cars.filter(n => (n.dist || 0) < 30).length, '<=', 1],
  ['junctions are taken, not reversed at', turns / Math.max(1, uturns), '>=', 2],
  ['pedestrians hold the pavement (median)', +pq(0.5), '<=', 0.5],
  ['pedestrians keep off their carriageway', 100 * pOnCarriageway / pSamples, '<=', 1],
  // THE LOOSEST ONE, and it is loose because of the data rather than the code:
  // 7.7% of pavement points on this district are inside a real footprint, so a
  // walker holding the pavement correctly is inside a building some of the
  // time whatever it does. It swings from 1% to 11% across seeds on thirty-four
  // walkers. What it still catches is the version of this that put everybody in
  // a wall, which read 30% and up.
  ['pedestrians stay out of buildings', 100 * pInB / pSamples, '<=', 15],
  ['every pedestrian walks', dists.filter(d => d < 20).length, '<=', 0]
];

let failed = 0;
console.log('');
for (const [what, got, op, want] of checks) {
  const ok = op === '>=' ? got >= want : got <= want;
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what.padEnd(38)} ${got.toFixed(2)} ${op} ${want}`);
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
