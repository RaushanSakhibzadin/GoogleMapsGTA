"use strict";
/* VICE MAPS — the casinos, the two colours, and the war over the walls.

   Part of a set of plain <script> files sharing one global scope. They are NOT
   modules on purpose: ES modules are blocked over file://, and opening
   index.html straight off disk with no build step is the point of this thing.
   Load order is fixed in index.html and matters.

   ---------------------------------------------------------------------------

   WHAT THIS IS. OpenStreetMap knows where the casinos are — Belgrade has dozens
   of them, which is why this exists at all — so they arrive with the landmark
   sweep like a hospital or a taxi rank. Stop at one and you get two buttons, red
   and black. The stake is a tenth of what you are carrying and the coin is fair:
   half the time it comes back doubled and half the time it does not come back.

   WHICH COLOUR YOU PICK MORE IS WHICH SIDE YOU ARE ON. Not a menu, not a
   setting — the tally of every bet you have ever placed, so a supporter is
   something you become by betting rather than something you declare. Once you
   have placed one bet you carry a spray can, and a wall you paint is your side's
   wall: it goes your colour in the street, in the chase view, on the big map and
   on the radar, with a tag across its ground floor.

   AND THE OTHER SIDE PAINTS TOO. Every so often one of your walls comes back
   the other colour, which is the only thing in here that happens without you.

   WHY IT IS ITS OWN FILE. All of it is one feature and none of it is anything
   else's business: game.js calls updateTurf() once a frame and syncTurfUI() on
   the ten-a-second tick, util.js asks turfPaint() what colour a painted building
   is, and world.js asks the same question when it draws the map. Everything else
   in here is private to it. */

/* THE TWO SIDES.

   `wall` and `roof` are what the building becomes — read by resolveColours, so
   they survive a theme change and a day/night switch without anything here
   knowing that either happened. `ink` is the tag sprayed across the ground floor
   and has to read AGAINST the wall it is on, which is why black's ink is pale
   and red's is bright rather than both being the team colour.

   `map` is separate from `wall` for one reason: the map's background is nearly
   black at dusk, and a black building drawn on it is not a subtle effect, it is
   an invisible one. So the map gets a lifted version and a stroke in the ink
   colour, and a black block reads as a black block rather than as a hole.

   AND mWall/mRoof ARE THE SAME TWO COLOURS AS RAW MATERIAL, for the chase view.

   They are here rather than derived from the hex because the chase view does not
   take a CSS string: it puts three floats a vertex into a buffer, and it shades a
   painted wall the way it shades a car — see uPaint — rather than the way it
   shades masonry. That is not a shortcut, it is the only thing that works. The
   dusk theme's wall transform is `mix(c * 0.17, [38,26,58], 0.5)`, which lands
   every wall in the city within a few points of [19,13,29] on purpose: at night
   the colour is meant to come from the neon and the street lights, not from the
   brick. Run a red building through it and it comes out violet-grey, which is
   the feature disappearing every evening. */
/* THE TWO CANS. One button in each bottom corner, and the same action behind
   both — whichever hand is free presses it. Named here rather than at any of the
   three places that touch them (the click, the show/hide, the reset on a new
   run), because a second button is exactly the kind of thing that gets added to
   two of three. */
const SPRAY_IDS = ['sprayBtn', 'sprayBtnR'];
const TEAMS = {
  red:   { wall: '#8f1622', roof: '#c9202f', ink: '#ff8a96', map: '#d0263a',
           mWall: [150, 26, 38], mRoof: [205, 40, 55] },
  /* Black is lifted off true black on purpose. [0,0,0] is not a building at
     night, it is a hole in the street with a roofline round it — and the side is
     "black" the way a football strip is black, which is a very dark grey with
     something to catch the light. */
  black: { wall: '#15151b', roof: '#2b2b36', ink: '#b9b9d0', map: '#26262f',
           mWall: [30, 30, 38], mRoof: [58, 58, 72] }
};
const rivalOf = t => t === 'red' ? 'black' : 'red';

/* HOW CLOSE IS AT THE TABLE. Wider than JOB_RANGE's 22 m, because a depot is a
   yard you drive into and a casino is a door on a street: the OSM node sits on
   the building, and the nearest you can park a car to it is the kerb outside. */
const CASINO_RANGE = 42;
/* AND HOW FAR THE CAN REACHES. A wall you could touch from the car, near enough
   — far enough that you do not have to nose into the render to paint it, close
   enough that it is always obvious which building you just tagged. */
const SPRAY_RANGE = 34;

const BET_FRAC = .10;
/* HOW OFTEN THE OTHER SIDE COMES ROUND. Long enough that it is news rather than
   weather: a minute and a half at the short end, and it never takes the last
   wall you have — being wiped out by a coin toss you did not make is not a
   setback, it is the feature being switched off. */
const RAID_MS = [92000, 168000];

const TURF = {
  picks: { red: 0, black: 0 },
  team: null,          // which side you are on: the colour you have picked most
  last: null,          // and the most recent pick, which settles a tie
  bets: 0,
  raidAt: 0,
  taken: 0,            // walls the rival has taken off you this session
  lastBet: null        // what the last spin did, for the tests and the HUD
};

/* THE TALLY OUTLIVES THE CITY. Which side you are on is a fact about the
   PLAYER — it is the sum of every bet they have placed — so it survives a
   reload, a change of city and a wasted run, exactly as the cash does. The
   painted walls do not and cannot: they are buildings, and a new city is a new
   set of buildings. */
const TURF_KEY = 'vm_turf';
function loadTurf() {
  try {
    const j = JSON.parse(store.get(TURF_KEY, '') || 'null');
    if (!j) return;
    TURF.picks.red = Math.max(0, j.red | 0);
    TURF.picks.black = Math.max(0, j.black | 0);
    TURF.bets = Math.max(0, j.bets | 0);
    TURF.last = j.last === 'red' || j.last === 'black' ? j.last : null;
    TURF.team = teamFromPicks();
  } catch (e) {}          // privacy mode, or a corrupt entry: start with no side
}
function saveTurf() {
  store.set(TURF_KEY, JSON.stringify({ red: TURF.picks.red, black: TURF.picks.black,
                                       bets: TURF.bets, last: TURF.last }));
}
/* "Depending on which colour I choose more". A tie goes to the most recent pick
   rather than to nobody, because the alternative is that an even number of bets
   leaves you with no side and no spray can, which reads as the feature breaking
   every second bet. */
function teamFromPicks() {
  const r = TURF.picks.red, b = TURF.picks.black;
  if (!r && !b) return null;
  return r > b ? 'red' : b > r ? 'black' : (TURF.last || 'red');
}

/* ---------------------------------------------------------------------------
   THE TABLE
   --------------------------------------------------------------------------- */

/* The casino you are standing at, or null. Same shape as jobHere() and called on
   the same ten-a-second tick for the same reason: it is a proximity test against
   every landmark in the city and nothing about it needs sixty answers a second. */
function casinoHere() {
  const c = P && P.car;
  if (!c || state !== 'play') return null;
  let best = null, bd = CASINO_RANGE * CASINO_RANGE;
  for (const q of W.pois) {
    if (q.kind !== 'casino') continue;
    const d = dist2(c.x, c.y, q.x, q.y);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}
const betStake = () => Math.floor((P.cash || 0) * BET_FRAC);

/* One spin. Ten percent of what you are carrying, doubled or gone, on a fair
   coin — and the pick is counted whichever way the coin lands, because it is the
   CHOOSING that says which side you are on and not the winning. */
function placeBet(colour) {
  if (colour !== 'red' && colour !== 'black') return null;
  if (state !== 'play') return null;
  const at = casinoHere();
  if (!at) return null;
  const stake = betStake();
  /* Nothing to stake is not a bet. It would otherwise be a free tally mark — a
     player with no cash could pick a side for nothing, and pick it a hundred
     times — so it is refused, and refused with the reason rather than silently. */
  if (stake < 1) { toast(txt('casino.broke'), 1800); return null; }

  const won = Math.random() < .5;
  P.cash += won ? stake : -stake;
  if (P.cash < 0) P.cash = 0;
  store.set('vm_cash', P.cash);

  TURF.picks[colour]++;
  TURF.last = colour;
  TURF.bets++;
  const was = TURF.team;
  TURF.team = teamFromPicks();
  saveTurf();
  TURF.lastBet = { colour, stake, won };

  // the rising chime the game already uses for money, and the low one it uses
  // for being taken to the cells — the two things a spin can actually mean
  if (SFX) (won ? SFX.cash : SFX.bust)();
  toast(txt(won ? 'casino.won' : 'casino.lost',
            { col: txt('casino.' + colour), n: stake }), 2200);
  /* Told once, when it changes. A player who has just switched sides has also
     just changed what their spray can does, and that is worth a line. */
  if (TURF.team !== was)
    setTimeout(() => { if (state === 'play') toast(txt('turf.side', { col: txt('casino.' + TURF.team) }), 2400); }, 2300);
  return TURF.lastBet;
}

/* ---------------------------------------------------------------------------
   THE CAN
   --------------------------------------------------------------------------- */

/* AN UNREADABLE TAG, which is the honest description of the thing rather than a
   failure to draw text. Real graffiti on a real ground floor is a name written
   fast in one stroke by somebody who already knows what it says, and the letters
   are the shape of the hand rather than the shape of the alphabet.

   So: three to six characters out of a set with no round quiet letters in it,
   which is what gives a tag its spiky look at a glance. The string is what the
   TOP-DOWN view draws; the chase view builds its own letters in the shader off
   the seed, because a canvas string cannot be pasted onto a wall in WebGL
   without a texture nobody needs. Both come from the same seed, so a wall tagged
   in one view is the same wall in the other. */
const TAG_CHARS = 'AKMNRSVWXYZ4713';
function makeTag() {
  const n = 3 + Math.floor(Math.random() * 4);
  let s = '';
  for (let i = 0; i < n; i++) s += TAG_CHARS[Math.floor(Math.random() * TAG_CHARS.length)];
  return s;
}

/* THE WALL THIS PAINTS, or null. The nearest building in range that is not
   already this side's — so a can pointed at your own wall finds the one behind
   it instead of doing nothing, and a rival wall is a wall worth taking back. */
function sprayTarget() {
  const c = P && P.car;
  if (!c || state !== 'play' || !TURF.team) return null;
  let best = null, bd = SPRAY_RANGE * SPRAY_RANGE;
  for (const b of W.buildings) {
    if (b.mono) continue;                     // a monument is not somebody's wall
    if (b.turf === TURF.team) continue;
    const d = dist2(c.x, c.y, b.cx, b.cy);
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}

/* Paint it, and tell everything that draws a building that one of them changed.

   THREE RENDERERS AND A MAP, and each is told in its own currency. resolveColours
   is the same call applyTheme makes, so the wall and roof come out through the
   theme rather than around it; dirtyCellAt drops the chase view's cached geometry
   for that block so it rebuilds with the new colour in it; prerenderMap redraws
   the bitmap the big map and the radar are both one drawImage of. The top-down
   view reads b.wall every frame and needs telling nothing. */
function claimBuilding(b, team) {
  if (!b) return false;
  b.turf = team;
  if (!b.tag) { b.tag = makeTag(); b.tagSeed = Math.random(); }
  resolveColours([b]);
  if (typeof dirtyCellAt === 'function') dirtyCellAt(b.cx, b.cy);
  if (typeof prerenderMap === 'function') prerenderMap();
  return true;
}

function sprayPaint() {
  if (!TURF.team) return false;
  const b = sprayTarget();
  if (!b) { toast(txt('turf.noWall'), 1500); return false; }
  const stolen = b.turf && b.turf !== TURF.team;
  claimBuilding(b, TURF.team);
  if (SFX && SFX.pickup) SFX.pickup();
  toast(txt(stolen ? 'turf.retaken' : 'turf.tagged', { n: turfCount(TURF.team) }), 1800);
  return true;
}

const turfCount = team => W.buildings.reduce((n, b) => n + (b.turf === team ? 1 : 0), 0);

/* ---------------------------------------------------------------------------
   THE OTHER SIDE
   --------------------------------------------------------------------------- */

/* Called every frame; does nothing on almost all of them.

   The clock only runs while you are playing and only once you have a side, so a
   raid cannot land during a loading screen or arrive as the first thing that
   ever happens to you. And it never takes your last wall — see RAID_MS. */
function updateTurf() {
  if (state !== 'play' || !TURF.team) return;
  const now = Date.now();
  if (!TURF.raidAt) { TURF.raidAt = now + raidGap(); return; }
  if (now < TURF.raidAt) return;
  TURF.raidAt = now + raidGap();

  const mine = W.buildings.filter(b => b.turf === TURF.team);
  if (mine.length < 2) return;
  const b = mine[Math.floor(Math.random() * mine.length)];
  claimBuilding(b, rivalOf(TURF.team));
  TURF.taken++;
  toast(txt('turf.lostWall', { col: txt('casino.' + rivalOf(TURF.team)),
                               n: turfCount(TURF.team) }), 2600);
}
const raidGap = () => RAID_MS[0] + Math.random() * (RAID_MS[1] - RAID_MS[0]);

/* A NEW CITY KEEPS THE SIDE AND LOSES THE WALLS, which is the only thing that
   can happen: the buildings are gone. Called from buildWorld's caller rather
   than from buildWorld, because the retry path rebuilds the world under a car
   that is already driving and the raid clock should not restart every time a
   district streams in. */
function resetTurfWalls() { TURF.raidAt = 0; }

/* ---------------------------------------------------------------------------
   THE BUTTONS
   --------------------------------------------------------------------------- */

/* Refreshed on the ten-a-second tick, alongside the depot button and for the
   same reason. Both of these are cheap to skip and expensive to do sixty times a
   second, and neither is something the eye can catch arriving a tenth late. */
let casinoAt = null, sprayShown = null;
function syncTurfUI() {
  const at = casinoHere();
  const el = $('betRow');
  if (el && (at ? 1 : 0) !== (casinoAt ? 1 : 0)) el.classList.toggle('on', !!at);
  casinoAt = at;

  /* THE CAN APPEARS WITH THE FIRST BET AND NEVER GOES AWAY, which is what was
     asked for. It is not conditional on standing next to a wall: a button that
     blinks in and out as you drive is unreadable, and a press with nothing in
     range says so. */
  const can = TURF.bets > 0 && !!TURF.team;
  for (const id of SPRAY_IDS) {
    const sb = $(id);
    if (!sb) continue;
    if (can !== sprayShown) sb.classList.toggle('on', can);
    if (can) sb.dataset.team = TURF.team;
  }
  sprayShown = can;
}

/* What a painted building looks like, asked by resolveColours in util.js and by
   the map in world.js. Null for everything nobody has painted, which is nearly
   every building in the city. */
const turfPaint = b => (b && b.turf && TEAMS[b.turf]) || null;
