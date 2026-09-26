/* VERIFY THE HUD LAYOUT, in the only language this repository can run.
 *
 * WHY THIS EXISTS. Nothing here can execute a line of Luau and there is no
 * Roblox in the sandbox, so a panel sitting on top of a button costs a round
 * trip through somebody else's screen to find. But a GUI layout is arithmetic:
 * a UDim2 and a size are a rectangle, and whether two rectangles overlap is a
 * question this file can answer without a renderer.
 *
 * WHAT IT READS. The Luau the game actually runs -- every position and size
 * below is parsed out of the source file that sets it, not copied into here, so
 * moving a panel in the client script moves it in this check too. A widget
 * whose line cannot be found is a FAILURE, not a skip: the whole value of this
 * file is that it cannot quietly stop looking at something.
 *
 * WHAT IT CHECKS, at four screen sizes and in both layouts (keyboard, thumbs):
 *
 *   · nothing overlaps anything else
 *   · nothing hangs off the edge of the screen
 *   · nothing sits under Roblox's own top bar, which owns the first 36 px and
 *     always wins -- the dispatch card learned that one the hard way (see its
 *     own comment on why the wallet is not at the top of the screen)
 *
 * Same approach as verify-roles.mjs and verify-life.mjs, which between them
 * found four real bugs before anybody had to see one.
 */

import { readFileSync } from 'node:fs';

const CLIENT = 'roblox/src/StarterPlayer/StarterPlayerScripts';
const SHARED = 'roblox/src/ReplicatedStorage/Shared';

const src = f => readFileSync(f, 'utf8');

/* ---------------- reading a UDim2 out of the source ---------------- */

/* The expressions in the client scripts are arithmetic over a handful of named
 * constants (VIEW, PAD, EDGE, Hud.PAD_LIFT...). Rather than teach this a Luau
 * parser, every name is substituted for its number and what is left is ordinary
 * arithmetic -- which is the one thing both languages spell the same way. */
const evalNum = (expr, consts) => {
  let s = expr.trim();
  for (const [name, value] of Object.entries(consts)) {
    s = s.replaceAll(name, `(${value})`);
  }
  if (!/^[-+*/(). \d]+$/.test(s)) throw new Error(`cannot evaluate "${expr}" -> "${s}"`);
  return Function(`return ${s}`)();
};

/* UDim2.new(sx, ox, sy, oy) and UDim2.fromOffset(ox, oy). Arguments are split
 * on top-level commas so that a nested call or a parenthesised sum survives. */
const args = text => {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out;
};

const udim2 = (expr, consts) => {
  const m = expr.match(/^UDim2\.(new|fromOffset|fromScale)\s*\(([\s\S]*)\)$/);
  if (!m) throw new Error(`not a UDim2: ${expr}`);
  const a = args(m[2]).map(x => evalNum(x, consts));
  if (m[1] === 'fromOffset') return { sx: 0, ox: a[0], sy: 0, oy: a[1] };
  if (m[1] === 'fromScale') return { sx: a[0], ox: 0, sy: a[1], oy: 0 };
  return { sx: a[0], ox: a[1], sy: a[2], oy: a[3] };
};

/* One capture group holding a whole UDim2 call. Throws rather than returning
 * null: a pattern that stopped matching is this file failing to do its job. */
const grab = (text, re, what) => {
  const m = text.match(re);
  if (!m) throw new Error(`could not find ${what}`);
  return m;
};

/* ---------------- the widgets ---------------- */

const dispatch = src(`${CLIENT}/DispatchUI.client.luau`);
const roleui = src(`${CLIENT}/RoleUI.client.luau`);
const speedo = src(`${CLIENT}/SpeedoUI.client.luau`);
const touch = src(`${CLIENT}/TouchDrive.client.luau`);
const minimap = src(`${CLIENT}/Minimap.client.luau`);
const wanted = src(`${CLIENT}/WantedUI.client.luau`);
const hud = src(`${SHARED}/Hud.luau`);

const PAD_LIFT = +grab(hud, /Hud\.PAD_LIFT = if Hud\.thumbs then (\d+) else 0/, 'Hud.PAD_LIFT')[1];

const padConsts = Object.fromEntries(
  ['PAD', 'BIG', 'SMALL', 'EDGE'].map(n => [n, +grab(touch, new RegExp(`^local ${n} = (\\d+)$`, 'm'), `TouchDrive ${n}`)[1]])
);

const [, VIEW_THUMBS, VIEW_KEYS] = grab(minimap, /^local VIEW = if Hud\.thumbs then (\d+) else (\d+)/m, 'Minimap VIEW').map(Number);
const [, SPEEDO_W, SPEEDO_H] = grab(speedo, /^local W, H = (\d+), (\d+)/m, 'Speedo W,H').map(Number);

/* A ternary `if Hud.thumbs then A else B` yields two positions; a plain
 * expression yields the same one for both layouts. */
const branch = (text, re, what) => {
  const m = grab(text, re, what);
  const expr = m[1].trim();
  const t = expr.match(/^if Hud\.thumbs then ([\s\S]+?) else ([\s\S]+)$/);
  return t ? { thumbs: t[1].trim(), keys: t[2].trim() } : { thumbs: expr, keys: expr };
};

/* PAD_LIFT AND VIEW ARE BOTH LAYOUT-DEPENDENT, so the substitution table is
 * built per layout rather than once: `Hud.PAD_LIFT` is zero on a keyboard by
 * construction, and the minimap shrinks when there are thumbs on the screen.
 * Reading 112 in both was this file's own first bug -- it reported the keyboard
 * layout colliding in three places that it does not. */
const constsFor = which => ({
  'Hud.PAD_LIFT': which === 'thumbs' ? PAD_LIFT : 0,
  VIEW: which === 'thumbs' ? VIEW_THUMBS : VIEW_KEYS,
  CARD_H: CARD_H[which],
  ...padConsts,
});

const rect = (name, pos, size, anchor, K) => {
  const p = udim2(pos, K);
  const s = udim2(size, K);
  const a = anchor ?? [0, 0];
  return { name, p, s, a };
};

/* -- the two information columns -- */

/* The dispatch card's height is a named local rather than a literal, and both
 * of its values matter -- so CARD_H joins the substitution table per layout the
 * same way PAD_LIFT does. */
const CARD_H = Object.fromEntries(
  (() => {
    const m = grab(dispatch, /^local CARD_H = if Hud\.thumbs then (\d+) else (\d+)/m, 'dispatch CARD_H');
    return [['thumbs', +m[1]], ['keys', +m[2]]];
  })()
);

const dispatchPos = branch(dispatch, /card\.Position = (UDim2\.[\s\S]*?)\n/, 'dispatch card position');
const dispatchSize = branch(dispatch, /card\.Size = (UDim2\.new\([^)]*\))/, 'dispatch card size');

const walletSize = branch(dispatch, /walletPill\.Size = (if Hud\.thumbs then [\s\S]*?)\n/, 'wallet size');
const walletPos = branch(dispatch, /walletPill\.Position = (if Hud\.thumbs then [\s\S]*?)\n/, 'wallet position');
const walletAnchor = branch(dispatch, /walletPill\.AnchorPoint = (if Hud\.thumbs then [\s\S]*?)\n/, 'wallet anchor');

const rolePos = branch(roleui, /card\.Position = (if Hud\.thumbs then [\s\S]*?)\n/, 'shift card position');
const roleSize = grab(roleui, /card\.Size = (UDim2\.fromOffset\([^)]*\))/, 'shift card size')[1];

const promptPos = branch(roleui, /prompt\.Position = (if Hud\.thumbs then [\s\S]*?)\n/, 'prompt position');
const promptSize = branch(roleui, /prompt\.Size = (if Hud\.thumbs then [\s\S]*?)\n/, 'prompt size');

const minimapPos = grab(minimap, /panel\.Position = (UDim2\.new\([^)]*\))/, 'minimap position')[1];
const speedoPos = grab(speedo, /panel\.Position = (UDim2\.new\([^)]*\))/, 'speedo position')[1];
const wantedPos = grab(wanted, /hud\.Position = (UDim2\.new\([^)]*\))/, 'wanted hud position')[1];
const wantedSize = grab(wanted, /hud\.Size = (UDim2\.fromOffset\([^)]*\))/, 'wanted hud size')[1];

/* -- the pads -- */

const padSpecs = [...touch.matchAll(
  /local (\w+) = pad\("(\w+)", "[^"]*", [^,]+, (\w+), Vector2\.new\((\d), (\d)\), (UDim2\.new\([^)]*\))\)/g
)].map(m => ({ name: `pad ${m[2]}`, pos: m[6], size: padConsts[m[3]], anchor: [+m[4], +m[5]] }));
const padRects = K => padSpecs.map(p => rect(p.name, p.pos, `UDim2.fromOffset(${p.size}, ${p.size})`, p.anchor, K));

if (padSpecs.length !== 5) throw new Error(`expected 5 touch pads, parsed ${padSpecs.length}`);

/* ---------------- the layouts ---------------- */

const forLayout = which => {
  const K = constsFor(which);
  const view = which === 'thumbs' ? VIEW_THUMBS : VIEW_KEYS;
  const out = [
    rect('minimap', minimapPos, `UDim2.fromOffset(${view}, ${view})`, [0, 0], K),
    rect('speedo', speedoPos, `UDim2.fromOffset(${SPEEDO_W}, ${SPEEDO_H})`, [0.5, 1], K),
    rect('wanted', wantedPos, wantedSize, [0.5, 0], K),
    rect('dispatch card', dispatchPos[which], dispatchSize[which], [0, 0], K),
    rect('shift card', rolePos[which], roleSize, [0, 0], K),
    rect('sign-on prompt', promptPos[which], promptSize[which], [0, 0], K),
  ];
  /* The numbers INSIDE the call, not every digit in the expression -- the "2"
   * in `Vector2` is not an anchor point, and reading it as one put the wallet
   * two screen-widths off the left edge in both layouts. */
  const anchor = [...grab(walletAnchor[which], /Vector2\.new\(([^)]*)\)/, 'wallet anchor point')[1]
    .matchAll(/-?[\d.]+/g)].map(Number);
  if (which === 'thumbs') {
    out.push(rect('wallet', walletPos[which], walletSize[which], anchor, K));
    out.push(...padRects(K));
  } else {
    /* On a keyboard the wallet is a CHILD of the dispatch card, anchored to its
     * own bottom-left ten pixels above it -- so its screen rectangle is the
     * card's origin plus that offset, which is what this reconstructs. The
     * offsets come from the source like everything else; only the parenting is
     * knowledge this file has to hold. */
    const card = out.find(r => r.name === 'dispatch card');
    const size = udim2(walletSize[which], K);
    const rel = udim2(walletPos[which], K);
    out.push({
      name: 'wallet',
      p: {
        sx: card.p.sx,
        ox: card.p.ox + rel.ox,
        sy: card.p.sy,
        oy: card.p.oy + rel.oy - anchor[1] * size.oy,
      },
      s: size,
      a: [0, 0],
    });
  }
  return out;
};

const box = (r, W, H) => {
  const w = r.s.sx * W + r.s.ox;
  const h = r.s.sy * H + r.s.oy;
  const x = r.p.sx * W + r.p.ox - r.a[0] * w;
  const y = r.p.sy * H + r.p.oy - r.a[1] * h;
  return { name: r.name, x, y, w, h, r: x + w, b: y + h };
};

/* ---------------- the checks ---------------- */

const checks = [];
const check = (name, got, want, ok) => checks.push({ name, got, want, ok });

/* ROBLOX'S OWN BUTTONS: the menu, the chat and the player list, which with
 * IgnoreGuiInset on share the screen with the game's UI and win. They sit in
 * the TOP LEFT -- the top right and top centre are free, which is why the
 * minimap has always been at y 18 and the wanted stars at y 10 and neither is
 * a bug. Checking the whole strip reported both of those as failures, which
 * was this file being wrong about the platform rather than the layout being
 * wrong about the platform. */
const TOPBAR_H = 36;
const TOPBAR_W = 300; /* the left cluster: menu, chat, players, and room to grow */

const SCREENS = {
  keys: [[1280, 720], [1024, 640]],
  thumbs: [[896, 414], [800, 380]],
};

for (const [which, sizes] of Object.entries(SCREENS)) {
  for (const [W, H] of sizes) {
    const boxes = forLayout(which).map(r => box(r, W, H));
    const label = `${which} ${W}x${H}`;

    const off = boxes.filter(b => b.x < 0 || b.y < 0 || b.r > W || b.b > H);
    check(`${label}: everything on screen`, off.length ? off.map(b => b.name).join(', ') : 'all on', 'all on', off.length === 0);

    const under = boxes.filter(b => b.y < TOPBAR_H && b.x < TOPBAR_W);
    check(`${label}: clear of the top bar`, under.length ? under.map(b => b.name).join(', ') : 'all clear', 'all clear', under.length === 0);

    const hits = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], c = boxes[j];
        if (a.x < c.r && c.x < a.r && a.y < c.b && c.y < a.b) hits.push(`${a.name} / ${c.name}`);
      }
    }
    check(`${label}: nothing overlaps`, hits.length ? hits.join('; ') : 'none', 'none', hits.length === 0);
  }
}

/* The pads exist at all, and are big enough for a thumb. 44 pt is the smallest
 * tap target every mobile platform's own guidance agrees on. */
{
  const small = padRects(constsFor('thumbs')).map(r => box(r, 800, 380)).filter(b => b.w < 44 || b.h < 44);
  check('every pad is at least a 44 pt target', small.length ? small.map(b => b.name).join(', ') : 'all big enough', 'all big enough', small.length === 0);
}

/* ---------------- out ---------------- */

console.log(`hud: ${forLayout('keys').length} widgets on a keyboard, ${forLayout('thumbs').length} with thumbs (lift ${PAD_LIFT} px)`);
console.log('');

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(36)} ${String(c.got).padStart(30)} want ${c.want}`);
}
console.log('');
if (failed) {
  console.log(`${failed} of ${checks.length} checks failed`);
  process.exit(1);
}
console.log(`all ${checks.length} checks pass`);
