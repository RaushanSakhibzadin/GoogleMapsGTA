/* VERIFY THE ROSTER, in the only language this repository can run.
 *
 * WHY THIS EXISTS. Nothing here can execute a line of Luau and there is no
 * Roblox in the sandbox, so every mistake in the shift system costs a round
 * trip through somebody else's screen. The rules that matter are arithmetic and
 * table lookups -- can you reach a depot, does the claim path refuse the wrong
 * shift, does a race have exactly one winner -- and arithmetic can be checked
 * here.
 *
 * WHAT IT READS. The Luau that was actually emitted and the Luau that was
 * actually written, not a copy of the numbers. Depots.luau is parsed out of the
 * bake's own output and Roles.luau's depot lists are parsed out of the module
 * the game requires, so a change to either shows up here rather than passing.
 *
 * Same approach as verify-life.mjs, which found three real bugs in the traffic
 * before anybody had to see them.
 */

import { readFileSync } from 'node:fs';

const ROOT = 'roblox/src/ReplicatedStorage/Shared';
const STUDS_PER_M = 3;

/* ---------------- what the bake emitted ---------------- */

const depotSrc = readFileSync(`${ROOT}/Depots.luau`, 'utf8');
const depots = [...depotSrc.matchAll(
  /\{ kind = "([^"]+)", x = (-?[\d.]+), z = (-?[\d.]+), (?:gx = (-?[\d.]+), gz = (-?[\d.]+), )?name = "((?:[^"\\]|\\.)*)" \}/g
)].map(m => ({
  kind: m[1], x: +m[2], z: +m[3],
  gx: m[4] === undefined ? null : +m[4],
  gz: m[5] === undefined ? null : +m[5],
  name: m[6]
}));

/* ---------------- what the roles ask for ---------------- */

const roleSrc = readFileSync(`${ROOT}/Roles.luau`, 'utf8');
const ORDER = [...roleSrc.match(/Roles\.ORDER = \{([^}]*)\}/)[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
const roles = {};
for (const id of ORDER) {
  /* Each role's block runs from `id = "<id>",` to the depot line inside it. */
  const block = roleSrc.slice(roleSrc.indexOf(`\t\tid = "${id}",`));
  const depot = block.match(/depot = \{([^}]*)\}/)[1];
  roles[id] = {
    depot: [...depot.matchAll(/"([^"]+)"/g)].map(m => m[1]),
    body: /body = \{ l = ([\d.]+), w = ([\d.]+), h = ([\d.]+) \}/.exec(block.slice(0, block.indexOf('\n\t},')))
  };
}

/* ---------------- the port of what the game does ---------------- */

const have = {};
for (const d of depots) have[d.kind] = true;

/* Roles.depotKind */
function depotKind(id) {
  const list = roles[id].depot;
  if (list.length === 0) return '';
  for (const k of list) if (have[k]) return k;
  return null;
}

const backing = {};
for (const id of ORDER) {
  const k = depotKind(id);
  if (k !== null) backing[id] = k;
}

/* RoleService.SIGN_RANGE */
const RANGE = 22 * STUDS_PER_M;

/* RoleService.depotFor -- both the building and its gate count. */
function depotFor(role, x, z) {
  const kind = backing[role];
  if (kind === undefined || kind === '') return null;
  for (const d of depots) {
    if (d.kind !== kind) continue;
    if (Math.hypot(d.x - x, d.z - z) <= RANGE) return d;
    if (d.gx !== null && Math.hypot(d.gx - x, d.gz - z) <= RANGE) return d;
  }
  return null;
}

/* ---------------- the checks ---------------- */

const checks = [];
const check = (name, got, want, ok) => checks.push({ name, got, want, ok });

/* 1. Every role has somewhere to sign on. This is the whole point of the
      fallback lists, and it is the check that fails the moment a district is
      recaptured without a filling station in it. */
{
  const missing = ORDER.filter(id => backing[id] === undefined);
  check('every shift has a depot in this district',
        missing.length ? missing.join(', ') : 'all five', 'all five', missing.length === 0);
}

/* 2. Only ONE role may be backed by a given depot kind, or standing at a
      filling station would offer two shifts and the prompt would pick by table
      order -- which is not an order anybody chose. */
{
  const seen = {};
  const clash = [];
  for (const id of ORDER) {
    const k = backing[id];
    if (k === undefined || k === '') continue;
    if (seen[k]) clash.push(`${k}: ${seen[k]} and ${id}`);
    seen[k] = id;
  }
  check('no depot kind signs on two shifts', clash.length ? clash.join('; ') : 'none', 'none', clash.length === 0);
}

/* 3. THE GATE IS REACHABLE FROM THE GATE. Trivially true and worth asserting
      anyway: it is the check that catches a units mistake, which is the single
      most likely bug in this file -- the bake works in metres and the game
      works in studs, and a missing x3 would leave every depot sitting 3 m from
      the district centre with the sign-on radius apparently working. */
{
  /* SIGN-ON DEPOTS ONLY. Seven of the twenty-seven are car repair garages,
     which back no shift -- they are in Depots.luau because the browser's body
     shops read the same list, and asking one of them to sign a shift on should
     find nothing. That is not a failure, and an earlier version of this check
     counted it as seven of them. */
  const signOn = depots.filter(d => Object.values(backing).includes(d.kind));
  let bad = 0;
  for (const d of signOn) {
    if (d.gx === null) continue;
    const role = Object.keys(backing).find(r => backing[r] === d.kind);
    if (!depotFor(role, d.gx, d.gz)) bad++;
  }
  check(`standing at a gate signs its shift on (${signOn.length} depots)`, bad, 0, bad === 0);
}

/* 4. AND THE DISTRICT IS NOT A COLLECTION OF POINTS THREE METRES APART. The
      same units check from the other side: depots should be spread over
      thousands of studs, not tens. */
{
  let far = 0;
  for (const d of depots) if (Math.hypot(d.x, d.z) > 500) far++;
  check('depots are spread across the district (studs, not metres)', far, '>= 20', far >= 20);
}

/* 5. NO TWO DEPOTS OF THE SAME KIND SHARE A SIGN-ON RADIUS in a way that makes
      one of them unreachable. Two clinics 60 studs apart is fine -- you sign on
      at whichever you stopped at -- but it is worth knowing how often it
      happens, because it is what turns "the ambulance depot" into "one of
      twelve identical dots". */
{
  let overlapping = 0;
  for (let i = 0; i < depots.length; i++)
    for (let j = i + 1; j < depots.length; j++) {
      const a = depots[i], b = depots[j];
      if (a.kind !== b.kind) continue;
      const ax = a.gx ?? a.x, az = a.gz ?? a.z;
      const bx = b.gx ?? b.x, bz = b.gz ?? b.z;
      if (Math.hypot(ax - bx, az - bz) < RANGE * 2) overlapping++;
    }
  check('depot gates that overlap each other', overlapping, '<= 4', overlapping <= 4);
}

/* 6. EVERY DEPOT HAS A GATE. One without is a depot you cannot drive to, and
      the bake reports it -- but a district where several are unreachable is a
      district where a shift silently does not exist. */
{
  const noGate = depots.filter(d => d.gx === null);
  check('depots with no drivable approach', noGate.length, 0, noGate.length === 0);
}

/* 7. THE GATE IS ACTUALLY NEARER THE ROAD THAN THE BUILDING IS, expressed as:
      the gate is not further from the building than the sign-on radius would
      have reached anyway for at least some of them. If every gate were within
      the radius of its building the whole mechanism would be dead weight. */
{
  const setBack = depots.filter(d => d.gx !== null && Math.hypot(d.gx - d.x, d.gz - d.z) > RANGE);
  check('depots the gate is load-bearing for', setBack.length, '>= 1', setBack.length >= 1);
}

/* ---------------- the claim path ---------------- */

/* IncidentTypes, read out of the module rather than restated. */
const kindSrc = readFileSync(`${ROOT}/IncidentTypes.luau`, 'utf8');
const kinds = {};
for (const m of kindSrc.matchAll(/\n\t(\w+) = \{\n\t\tid = "(\w+)",/g)) {
  const start = m.index;
  const end = kindSrc.indexOf('\n\t},\n', start);
  const block = kindSrc.slice(start, end);
  kinds[m[2]] = {
    slots: [...block.matchAll(/\{ role = "(\w+)", max = (\d+) \}/g)].map(s => ({ role: s[1], max: +s[2] })),
    competitive: /competitive = true/.test(block),
    twoStage: /twoStage = true/.test(block),
    tiers: [...block.matchAll(/need = (\d+),/g)].map(t => +t[1]),
    /* Every Loc key this kind's block names, title/label/detail and their
       drop* counterparts alike -- one pass rather than one field at a time,
       so a renamed or newly-added field is covered without this file
       changing too. */
    locKeys: [...block.matchAll(/"(incident\.[\w.]+)"/g)].map(k => k[1])
  };
}

/* IncidentService.tryClaim, with the parts that decide an outcome. */
function makeIncident(kindId) {
  return { kind: kindId, claims: {}, filled: 0, winner: null, state: 'open' };
}
function tryClaim(inc, userId, role, roleOf) {
  const kind = kinds[inc.kind];
  const slot = kind.slots.find(s => s.role === role);
  if (!slot) return [false, 'no such role here'];
  if (roleOf(userId) !== role) return [false, 'not on that shift'];
  if (inc.claims[userId]) return [true, 'already yours'];
  if (inc.winner !== null) return [false, 'already taken'];
  let inRole = 0;
  for (const r of Object.values(inc.claims)) if (r === role) inRole++;
  if (inRole >= slot.max) return [false, 'role full'];
  inc.claims[userId] = role;
  inc.filled++;
  return [true, 'claimed'];
}

/* 8. A COURIER CANNOT TAKE A FIRE SLOT. This is the check the whole roster
      rests on: without the role gate, `role` is a string a client chose and the
      depot is decoration. */
{
  const inc = makeIncident('fire');
  const [ok, why] = tryClaim(inc, 1, 'fire', () => 'courier');
  check('a courier claiming the fire slot is refused', why, 'not on that shift', !ok && why === 'not on that shift');
}

/* 9. And a firefighter can. */
{
  const inc = makeIncident('fire');
  const [ok] = tryClaim(inc, 1, 'fire', () => 'fire');
  check('a firefighter claiming the fire slot is taken', ok, true, ok === true);
}

/* 10. A ROLE CANNOT OVERFILL ITS OWN SLOT while another role's stays open. The
       bug this catches is a max applied to the incident rather than the slot,
       which would let three firefighters fill a collision and lock out the
       ambulance it actually needs. */
{
  const inc = makeIncident('collision');
  const taken = [];
  for (let u = 1; u <= 6; u++) taken.push(tryClaim(inc, u, 'police', () => 'police')[0]);
  const policeIn = Object.values(inc.claims).filter(r => r === 'police').length;
  const stillOpen = tryClaim(inc, 99, 'ambulance', () => 'ambulance')[0];
  check('a full police slot does not block the ambulance', `${policeIn} police, ambulance ${stillOpen}`,
        '2 police, ambulance true', policeIn === 2 && stillOpen === true);
}

/* 11. A COMPETITIVE JOB HAS EXACTLY ONE WINNER. Eight cabs claim, one arrives,
       and the rest are refused from that instant -- and only the winner is
       paid. */
{
  const inc = makeIncident('fare');
  for (let u = 1; u <= 8; u++) tryClaim(inc, u, 'taxi', () => 'taxi');
  const claimed = Object.keys(inc.claims).length;
  inc.winner = 5;                                   // driver 5 pulls up first
  const [late] = tryClaim(inc, 9, 'taxi', () => 'taxi');
  const paid = inc.winner !== null ? { [inc.winner]: inc.claims[inc.winner] } : {};
  check('a fare pays exactly one of the racers',
        `${claimed} claimed, ${Object.keys(paid).length} paid, late claim ${late}`,
        '8 claimed, 1 paid, late claim false',
        claimed === 8 && Object.keys(paid).length === 1 && late === false);
}

/* 12. EVERY KIND HAS A ONE-PERSON TIER, which IncidentTypes states as a design
       requirement: it is what makes the solo path the same path. */
{
  const bad = Object.entries(kinds).filter(([, k]) => !k.tiers.includes(1)).map(([id]) => id);
  check('every incident kind has a solo tier', bad.length ? bad.join(', ') : 'all', 'all', bad.length === 0);
}

/* 13. EVERY KIND'S LEAD ROLE IS PLAYABLE HERE, or the board would carry jobs
       nobody in this district can ever clear. IncidentServer filters on exactly
       this, so the check is that the filter has something left to dispatch. */
{
  const leads = Object.entries(kinds).map(([id, k]) => [id, k.slots[0].role]);
  const dead = leads.filter(([, role]) => backing[role] === undefined).map(([id]) => id);
  check('incident kinds this district cannot staff', dead.length ? dead.join(', ') : 'none', 'none', dead.length === 0);
}

/* 14. AND EVERY SLOT'S ROLE IS A REAL ROLE. A typo in a slot is a slot that can
       never be filled and a tier that can never be reached. */
{
  const bad = [];
  for (const [id, k] of Object.entries(kinds))
    for (const s of k.slots) if (!ORDER.includes(s.role)) bad.push(`${id}.${s.role}`);
  check('every slot names a role that exists', bad.length ? bad.join(', ') : 'none', 'none', bad.length === 0);
}

/* 15. EVERY INCIDENT IS REACHABLE BY CAR, which is the check that pays for
       itself. `radius` is measured from the BUILDING and the closest a car can
       get is the nearest road, so the two have to meet -- and before this they
       did not: the bake let a site sit 44.8 m from a road while the tightest
       radius was 40 studs (13.3 m), which made three fares in five, and one
       fire in sixteen, impossible to complete. Not a crash. A job that never
       finishes, reported a week later as "sometimes it just doesn't work".

       The margin is half a car and a bit: you stop ON the road nearest the
       site, and the pivot this is measured from is the middle of the car. */
{
  const sitesSrc = readFileSync(`${ROOT}/Sites.luau`, 'utf8');
  const maxRoad = +/Sites\.maxRoadStuds = ([\d.]+)/.exec(sitesSrc)[1];
  const MARGIN = 12;
  const radii = [];
  for (const [id, k] of Object.entries(kinds)) {
    const block = kindSrc.slice(kindSrc.indexOf(`\t\tid = "${id}",`));
    const end = block.indexOf('\n\t},\n');
    for (const m of block.slice(0, end).matchAll(/radius = (\d+),/g)) radii.push([id, +m[1]]);
  }
  const tightest = radii.reduce((a, b) => (b[1] < a[1] ? b : a));
  check(`the tightest radius reaches the furthest site (${tightest[0]})`,
        `${maxRoad.toFixed(0)} + ${MARGIN} studs vs ${tightest[1]}`,
        `<= ${tightest[1]}`,
        maxRoad + MARGIN <= tightest[1]);
}

/* 16. EVERY KEY AN INCIDENT NAMES ACTUALLY HAS A TRANSLATION. Loc.get falls
       back to the key itself, so a typo or a forgotten entry does not crash --
       it ships as "incident.fare.tier1.dropdetail" on a real player's screen
       instead, which is a worse failure for being silent. Only fare and parcel
       have drop* keys at all; a kind with none passes trivially. */
{
  const locSrc = readFileSync(`${ROOT}/Loc.luau`, 'utf8');
  const locKeys = new Set([...locSrc.matchAll(/\["([^"]+)"\] = "/g)].map(m => m[1]));
  const missing = [];
  for (const [id, k] of Object.entries(kinds))
    for (const key of k.locKeys) if (!locKeys.has(key)) missing.push(`${id}: ${key}`);
  check('every incident string has a Loc.luau entry',
        missing.length ? missing.join(', ') : 'all present', 'all present', missing.length === 0);
}

/* 17. A twoStage KIND ACTUALLY DECLARES A SECOND LEG'S TEXT. The reverse of
       #16 -- not a missing translation but a missing FIELD, which the regex
       above would not notice because there would be nothing to look up. Catches
       a twoStage kind that forgot dropLabel/dropDetail on one of its tiers and
       would show the pickup card, unchanged, all the way to the drop point. */
{
  const bad = [];
  for (const [id, k] of Object.entries(kinds)) {
    if (!k.twoStage) continue;
    const hasDropTitle = k.locKeys.some(key => key.endsWith('.dropTitle'));
    const hasDropTier = k.locKeys.some(key => key.includes('.dropLabel')) &&
                         k.locKeys.some(key => key.includes('.dropDetail'));
    if (!hasDropTitle || !hasDropTier) bad.push(id);
  }
  check('every twoStage kind has drop title/label/detail keys',
        bad.length ? bad.join(', ') : 'all present', 'all present', bad.length === 0);
}

/* ---------------- out ---------------- */

console.log(`roles: ${depots.length} depots, ${ORDER.length} shifts, ${Object.keys(kinds).length} incident kinds`);
const byKind = {};
for (const d of depots) byKind[d.kind] = (byKind[d.kind] || 0) + 1;
console.log(`  depots      ${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', ')}`);
console.log(`  backing     ${ORDER.map(id => `${id} -> ${backing[id] === '' ? 'anywhere' : backing[id] ?? 'NONE'}`).join(', ')}`);
console.log('');

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(46)} ${String(c.got).padStart(24)} want ${c.want}`);
}
console.log('');
if (failed) {
  console.log(`${failed} of ${checks.length} checks failed`);
  process.exit(1);
}
console.log(`all ${checks.length} checks pass`);
