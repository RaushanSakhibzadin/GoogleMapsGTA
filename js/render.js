"use strict";
/* VICE MAPS — Everything that draws: the world, the cars, the HUD and the radar.

   Part of a set of plain <script> files sharing one global scope. They are NOT
   modules on purpose: ES modules are blocked over file://, and opening
   index.html straight off disk with no build step is the point of this thing.
   Load order is fixed in index.html and matters. */

/* ------------------------------ 13. render ------------------------------ */
/* THESE THREE ARE SHARED WITH THE 3D VIEW. rot/cs/sn are the radar's rotation
   and the radar is drawn by drawMini() below whichever renderer is running, so
   render3d.js sets them from its own camera heading using the same convention.
   HX/HY are this projection's origin on the canvas; in 3D they are the screen
   centre, because a perspective projection has no such thing. */
let rot = 0, cs = 1, sn = 0, HX = 0, HY = 0;

/* Named for the view they belong to, because there are two now. The unqualified
   render() and toScreen() live in render3d.js and pick between the pair — see
   the note at the top of that file for why both ship rather than one replacing
   the other. Everything inside THIS file calls toScreen() rather than
   toScreen2D(); that is not an oversight, the dispatcher returns this one
   whenever the 2D renderer is the one running. */
function toScreen2D(wx, wy) {
  const dx = (wx - cam.x) * cam.s, dy = (wy - cam.y) * cam.s;
  return [HX + dx * cs - dy * sn, HY + dx * sn + dy * cs];
}

function render2D() {
  const c = P.car;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = PAL.ground;
  ctx.fillRect(0, 0, VW, VH);

  HX = VW / 2; HY = VH * .60;                       // camera sits low: more road ahead
  if (cam.shake > 0) {
    HX += rand(-1, 1) * cam.shake * 9;
    HY += rand(-1, 1) * cam.shake * 9;
  }
  rot = -Math.PI / 2 - c.h;
  cs = Math.cos(rot); sn = Math.sin(rot);

  const viewR = Math.hypot(VW, VH) / 2 / cam.s + 60;   // cull radius, in metres
  const vis = f => !(f.bb.x1 < cam.x - viewR || f.bb.x0 > cam.x + viewR ||
                     f.bb.y1 < cam.y - viewR || f.bb.y0 > cam.y + viewR);

  /* ---- ground layers, drawn in world space ---- */
  ctx.save();
  ctx.translate(HX, HY); ctx.rotate(rot); ctx.scale(cam.s, cam.s); ctx.translate(-cam.x, -cam.y);

  const fillPoly = (f, col, edge) => {
    ctx.beginPath(); ctx.moveTo(f.pts[0].x, f.pts[0].y);
    for (let i = 1; i < f.pts.length; i++) ctx.lineTo(f.pts[i].x, f.pts[i].y);
    ctx.closePath(); ctx.fillStyle = col; ctx.fill();
    if (edge) { ctx.strokeStyle = edge; ctx.lineWidth = .7; ctx.stroke(); }
  };
  for (const f of W.parks) if (vis(f)) fillPoly(f, PAL.park, PAL.parkEdge);

  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const stroke = (r, w, col) => {
    ctx.beginPath(); ctx.moveTo(r.pts[0].x, r.pts[0].y);
    for (let i = 1; i < r.pts.length; i++) ctx.lineTo(r.pts[i].x, r.pts[i].y);
    ctx.lineWidth = w; ctx.strokeStyle = col; ctx.stroke();
  };
  const visRoads = roadsIn(cam.x - viewR, cam.y - viewR, cam.x + viewR, cam.y + viewR);
  for (const r of visRoads) stroke(r, r.w + 3.4, PAL.case);            // shadow under the kerb
  for (const r of visRoads) stroke(r, r.w + 1.8, PAL.kerb);            // pavement
  for (const r of visRoads) stroke(r, r.w, r.w >= 11 ? PAL.roadBig : PAL.road);
  ctx.setLineDash([3.2, 5.4]);
  for (const r of visRoads) if (r.w >= 9) stroke(r, .55, PAL.line);    // centre line
  ctx.setLineDash([]);

  /* Tyre lines, batched. Each mark used to be its own beginPath+stroke, so a full
     buffer was several hundred draw calls a frame and halved the frame rate in a
     chase. They only differ by how far they have faded, so they are gathered into
     a handful of alpha buckets and stroked once each — same picture, five calls.
     Off-screen ones are skipped first: most of a long arc is out of frame. */
  ctx.strokeStyle = 'rgba(10,4,16,.62)'; ctx.lineWidth = .72;
  const FADES = 5, lanes = [];
  for (const m of marks) {
    if (Math.abs(m.x - cam.x) > viewR || Math.abs(m.y - cam.y) > viewR) continue;
    const a = clamp(m.life / MARK_LIFE, 0, 1);
    const bi = Math.min(FADES - 1, Math.floor(a * FADES));
    const path = lanes[bi] || (lanes[bi] = new Path2D());
    const o = m.w * .35, dx = Math.cos(m.h) * 1.1, dy = Math.sin(m.h) * 1.1;
    const px = -Math.sin(m.h) * o, py = Math.cos(m.h) * o;
    path.moveTo(m.x + px - dx, m.y + py - dy); path.lineTo(m.x + px + dx, m.y + py + dy);
    path.moveTo(m.x - px - dx, m.y - py - dy); path.lineTo(m.x - px + dx, m.y - py + dy);
  }
  for (let i = 0; i < FADES; i++) {
    if (!lanes[i]) continue;
    ctx.globalAlpha = ((i + .5) / FADES) * .85;
    ctx.stroke(lanes[i]);
  }
  ctx.globalAlpha = 1;

  // street lights — additive blits of a pre-tinted sprite
  if (W.lights && PAL.lights) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = .5;
    const R = 8.5;
    for (const L of W.lights) {
      if (Math.abs(L.x - cam.x) > viewR || Math.abs(L.y - cam.y) > viewR) continue;
      ctx.drawImage(glowFor(L.c), L.x - R, L.y - R, R * 2, R * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();

  /* ---- traffic and pedestrians go UNDER the buildings, or they look like
         they're driving across the rooftops ----

     AND ONLY THE ONES YOU CAN SEE. Everything else here culls to the view —
     parks, roads, buildings, tyre marks, street lights — and the cars were the
     one thing that did not: every car in the world got a full drawCar(), which
     builds a fresh linear gradient for its headlights, rounds four corners and
     lays down a shadow. The view is about 140 m across and cars are simulated
     out to 780, so in daylight that was two hundred and fifty of them drawn per
     frame with perhaps a dozen on screen.

     Nothing is removed and nothing pops: a car skipped here is one whose paint
     lands outside the canvas, and it is still driving, still solid, still
     spawning police attention. The margin covers the car's own length and the
     26 m headlight cone reaching in from off-screen. */
  ctx.save();
  ctx.translate(HX, HY); ctx.rotate(rot); ctx.scale(cam.s, cam.s); ctx.translate(-cam.x, -cam.y);
  const seen = (o, m) => Math.abs(o.x - cam.x) < viewR + m && Math.abs(o.y - cam.y) < viewR + m;
  for (const p of peds) if (seen(p, 2)) drawPed(p);
  for (const t of traffic) if (seen(t, 30)) drawCar(t);
  for (const k of cops) if (seen(k, 30)) drawCar(k);
  ctx.restore();

  /* ---- buildings: fake 3D by pushing the roof away from screen centre ---- */
  const visB = [];
  for (const b of W.buildings) if (vis(b)) visB.push(b);
  // far buildings first so near ones overlap them correctly
  visB.sort((a, z) => dist2(z.cx, z.cy, cam.x, cam.y) - dist2(a.cx, a.cy, cam.x, cam.y));
  for (const b of visB) drawBuilding(b);

  /* ---- the player alone goes on top of the buildings, so you can never lose
         your own car behind a tower or under an archway ---- */
  ctx.save();
  ctx.translate(HX, HY); ctx.rotate(rot); ctx.scale(cam.s, cam.s); ctx.translate(-cam.x, -cam.y);

  // landmarks first, so a mission marker on top of one still reads
  for (const p of W.pois) {
    if (Math.abs(p.x - cam.x) > viewR || Math.abs(p.y - cam.y) > viewR) continue;
    marker(p, POI_COL[p.kind], p.kind);
  }
  {
    /* ONE ANSWER TO "WHERE IS THE JOB", asked in seven places and now given in
       one. It was two lines checking two states, repeated in the world, the big
       map, the radar, the edge arrow and the chase view's beacon — which was
       survivable while there was one kind of job and is not survivable with
       five. A burning building and a car being chased are goals like any other. */
    const g = missionGoal();
    if (g) marker(g.at, g.col, g.kind);
  }

  if (!P.dead || Math.floor(P.deadT * 8) % 2 === 0) drawCar(c, true);

  for (const p of parts) {
    const a = clamp(p.life * 2, 0, 1);
    ctx.fillStyle = p.col;
    if (p.soft) {
      // Tyre smoke: round, and it swells and thins as it lifts off the road.
      // Sparks stay square — at a third of a metre nobody can tell, and it is
      // one fillRect — but a smoke puff drawn square reads as a white brick.
      ctx.globalAlpha = a * .42;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (1 + (1 - p.life / p.life0) * 1.9), 0, TAU);
      ctx.fill();
    } else {
      ctx.globalAlpha = a;
      const r = p.r || .28;
      ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
    }
  }
  ctx.globalAlpha = 1;

  // fireballs, blitted additively off the tinted glow sprite the street lights use
  if (blasts.length) {
    ctx.globalCompositeOperation = 'lighter';
    for (const b of blasts) {
      const t = clamp(b.life / .55, 0, 1);
      // Additive light adds up: a bright core over a bright body pushes green to
      // full and the whole thing turns yellow. So the body is a deep red-orange
      // and the white-hot core is small and gone quickly — it stays orange.
      ctx.globalAlpha = t;
      ctx.drawImage(glowFor('#ff4d00'), b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
      ctx.globalAlpha = t * t * t * .7;
      const c2 = b.r * .34;
      ctx.drawImage(glowFor('#ffc26a'), b.x - c2, b.y - c2, c2 * 2, c2 * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();

  drawArrow();
  drawHUD();
  drawMini();
}

function drawBuilding(b) {
  const n = b.pts.length;
  const sx = new Array(n), sy = new Array(n), tx = new Array(n), ty = new Array(n);
  const f = Math.min(b.h, 110) * 0.026;     // extrusion strength ~ height, capped
  let minSX = Infinity, maxSX = -Infinity, minSY = Infinity, maxSY = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = toScreen(b.pts[i].x, b.pts[i].y);
    sx[i] = p[0]; sy[i] = p[1];
    tx[i] = p[0] + (p[0] - HX) * f; ty[i] = p[1] + (p[1] - HY) * f;
    if (p[0] < minSX) minSX = p[0]; if (p[0] > maxSX) maxSX = p[0];
    if (p[1] < minSY) minSY = p[1]; if (p[1] > maxSY) maxSY = p[1];
  }
  if (maxSX < -60 || minSX > VW + 60 || maxSY < -60 || minSY > VH + 60) return;

  // a building you can drive under is drawn back so the street shows through
  if (b.passable) ctx.globalAlpha = .45;

  // footprint shadow — grounds the block so it doesn't float
  ctx.beginPath(); ctx.moveTo(sx[0] - 3, sy[0] + 3);
  for (let i = 1; i < n; i++) ctx.lineTo(sx[i] - 3, sy[i] + 3);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fill();

  // Footprint, filled — this closes the near side, where the walls below are
  // deliberately culled away.
  ctx.fillStyle = b.wall;
  ctx.beginPath(); ctx.moveTo(sx[0], sy[0]);
  for (let i = 1; i < n; i++) ctx.lineTo(sx[i], sy[i]);
  ctx.closePath();
  ctx.fill();

  // Only the silhouette walls: the edges whose outward normal points away from
  // the extrusion origin. Drawing the hidden ones too puts opposite windings in
  // the same path, and where they overlap the nonzero rule cancels them to
  // nothing — which is what tore the roofs off their footprints.
  let area2 = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area2 += sx[j] * sy[i] - sx[i] * sy[j];
  const wind = area2 >= 0 ? 1 : -1;
  ctx.beginPath();
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ex = sx[i] - sx[j], ey = sy[i] - sy[j];
    const nx = wind * ey, ny = -wind * ex;                  // outward normal
    const mx = (sx[i] + sx[j]) * .5 - HX, my = (sy[i] + sy[j]) * .5 - HY;
    if (nx * mx + ny * my <= 0) continue;                   // faces the camera: hidden
    ctx.moveTo(sx[j], sy[j]); ctx.lineTo(sx[i], sy[i]);
    ctx.lineTo(tx[i], ty[i]); ctx.lineTo(tx[j], ty[j]); ctx.closePath();
  }
  ctx.fill();

  // a lit edge where wall meets ground, so the mass reads
  ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(sx[0], sy[0]);
  for (let i = 1; i < n; i++) ctx.lineTo(sx[i], sy[i]);
  ctx.closePath(); ctx.stroke();

  // roof
  ctx.beginPath(); ctx.moveTo(tx[0], ty[0]);
  for (let i = 1; i < n; i++) ctx.lineTo(tx[i], ty[i]);
  ctx.closePath();
  ctx.fillStyle = b.roof; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.stroke();

  if (b.neon && PAL.showNeon) {             // neon trim, the whole point of the decade
    ctx.strokeStyle = b.neon; ctx.lineWidth = 1.6;
    ctx.globalAlpha = .85;
    ctx.shadowColor = b.neon; ctx.shadowBlur = 11;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;
}

function marker(m, col, kind) {
  const t = performance.now() / 1000;
  const r = 4.2 + Math.sin(t * 3) * .5;
  ctx.save(); ctx.translate(m.x, m.y);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  g.addColorStop(0, col + 'cc'); g.addColorStop(.6, col + '44'); g.addColorStop(1, col + '00');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
  ctx.strokeStyle = col; ctx.lineWidth = .5;
  ctx.beginPath(); ctx.arc(0, 0, r * (.5 + (t % 1) * .5), 0, TAU); ctx.globalAlpha = 1 - (t % 1); ctx.stroke();
  ctx.globalAlpha = 1;
  /* THE FACE, DRAWN UPRIGHT. Everything else in this pass is in world space and
     the whole world is rotated to the car's heading — which would leave the
     hospital sign upside down every time you drove north. So the rotation is
     undone for the glyph alone, and the scale with it: a 5 metre emoji is a
     different size on screen at every zoom, and this is a label rather than a
     thing in the city. */
  const e = kind && POI_EMOJI[kind];
  if (e) {
    ctx.rotate(-rot);
    ctx.scale(1 / cam.s, 1 / cam.s);
    ctx.font = '17px ' + POI_FACE_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.6)';
    ctx.strokeText(e, 0, -1);
    ctx.fillText(e, 0, -1);
  }
  ctx.restore();
}

function drawCar(c, isPlayer) {
  const spd = Math.hypot(c.vx, c.vy);
  ctx.save();
  ctx.translate(c.x, c.y); ctx.rotate(c.h);
  const L = c.l, Wd = c.w;

  // headlight cone — barely visible in daylight
  if ((isPlayer || c.kind === 'cop' || spd > 1) && PAL.lights) {
    const g = ctx.createLinearGradient(L / 2, 0, L / 2 + 24, 0);
    g.addColorStop(0, 'rgba(255,245,200,.20)'); g.addColorStop(1, 'rgba(255,245,200,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(L / 2 - .2, -Wd / 2);
    ctx.lineTo(L / 2 + 26, -8); ctx.lineTo(L / 2 + 26, 8); ctx.lineTo(L / 2 - .2, Wd / 2);
    ctx.closePath(); ctx.fill();
  }

  ctx.fillStyle = 'rgba(0,0,0,.4)';
  rrect(-L / 2 + .25, -Wd / 2 + .25, L, Wd, .7); ctx.fill();

  ctx.fillStyle = c.color;
  rrect(-L / 2, -Wd / 2, L, Wd, .7); ctx.fill();

  /* THE GREENHOUSE, or the cab. A fire engine is not a car with a roof in the
     middle of it: the cab is at the front and everything behind it is bodywork,
     so the two are drawn differently rather than one being painted over the
     other. */
  const isFire = c.livery === 'fire';
  ctx.fillStyle = 'rgba(0,0,0,.32)';
  if (isFire) rrect(L * .18, -Wd / 2 + .18, L * .26, Wd - .36, .3);
  else rrect(-L * .18, -Wd / 2 + .22, L * .46, Wd - .44, .3);
  ctx.fill();
  ctx.fillStyle = 'rgba(160,240,255,.5)';
  if (isFire) rrect(L * .30, -Wd / 2 + .26, L * .11, Wd - .52, .18);
  else rrect(L * .12, -Wd / 2 + .3, L * .14, Wd - .6, .18);
  ctx.fill();

  // lights
  ctx.fillStyle = '#fff6cf'; ctx.fillRect(L / 2 - .35, -Wd / 2 + .18, .35, .5);
  ctx.fillRect(L / 2 - .35, Wd / 2 - .68, .35, .5);
  ctx.fillStyle = '#ff3355'; ctx.fillRect(-L / 2, -Wd / 2 + .18, .3, .5);
  ctx.fillRect(-L / 2, Wd / 2 - .68, .3, .5);

  /* THE MARKINGS, which are not the paint. A patrol car carries its livery by
     kind; the player's is whichever shift they are on, and it is the same word
     the 3D view reads. Everything below is drawn in the car's own local frame,
     so it turns, brakes and rolls with the body it is painted on. */
  const liv = c.livery || (c.kind === 'cop' ? 'police' : null);

  if (liv === 'fire') {
    /* THE APPLIANCE, from above: a white band along each flank, the locker
       shutters down the body, the ladder on the roof and a blue bar over the
       cab. The body itself is already the right shape — the shift makes the car
       7.4 m long and 2.5 wide, so this only has to put the details on it. */
    const on = Math.floor((c.blink || 0) * 7) % 2 === 0;
    for (const side of [-1, 1]) {
      ctx.fillStyle = '#f4f6fa';
      ctx.fillRect(-L * .46, side < 0 ? -Wd / 2 + .1 : Wd / 2 - .42, L * .58, .32);
    }
    // the shutters: four lockers down the near flank of the body
    ctx.fillStyle = 'rgba(20,14,18,.55)';
    for (let i = 0; i < 4; i++)
      ctx.fillRect(-L * .44 + i * L * .14, -Wd / 2 + .5, L * .10, Wd - 1.0);
    /* THE LADDER, which is the one part of a fire engine everybody can name.
       Two rails and nine rungs, down the middle of the body where a real one is
       stowed, and the only silver on the vehicle. */
    ctx.fillStyle = '#c8ccd6';
    for (const side of [-1, 1]) ctx.fillRect(-L * .46, side * .34 - .07, L * .56, .14);
    for (let i = 0; i < 9; i++)
      ctx.fillRect(-L * .45 + i * L * .062, -.34, .1, .68);
    // and the bar over the cab, which alternates like the police one
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(L * .13, -Wd / 2 - .04, .46, Wd + .08);
    ctx.fillStyle = on ? '#5fb0ff' : '#123a72';
    ctx.fillRect(L * .13, -Wd / 2 - .04, .46, Wd * .5);
    ctx.fillStyle = on ? '#6b1a18' : '#ff544c';
    ctx.fillRect(L * .13, .04, .46, Wd * .5);
  } else if (liv === 'taxi') {
    /* THE CHEQUER. Two rows of small squares along each flank is the taxi mark
       everywhere it is used, and unlike a roof sign it is legible from directly
       above, which is the only angle this view has. Only the DARK squares are
       painted — the light half is the cab's own yellow, so the pattern costs
       half as many rectangles and can never disagree with the paint. */
    const cols = 9, rows = 2, bw = (L * .84) / cols, bh = .27;
    for (const side of [-1, 1]) {
      const y0 = side < 0 ? -Wd / 2 : Wd / 2 - bh * rows;
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
        if ((i + j) % 2) continue;
        ctx.fillStyle = '#14161c';
        ctx.fillRect(-L * .42 + bw * i, y0 + bh * j, bw, bh);
      }
    }
    // and the roof sign, which is the half of a taxi you see from the front
    ctx.fillStyle = '#1a1c24';
    rrect(-L * .06, -Wd * .21, L * .17, Wd * .42, .12); ctx.fill();
    ctx.fillStyle = '#ffd84d';
    rrect(-L * .04, -Wd * .17, L * .13, Wd * .34, .1); ctx.fill();
  } else if (liv === 'ambulance') {
    /* THE CROSS GOES ON THE ROOF, because that is the surface this view can see
       and because that is where a real one puts it — a roof cross is there to be
       read from above by the helicopter, which is exactly the camera. A red band
       along each flank carries it at the low angle of the chase view. */
    for (const side of [-1, 1]) {
      ctx.fillStyle = '#d8202f';
      ctx.fillRect(-L * .42, side < 0 ? -Wd / 2 : Wd / 2 - .22, L * .84, .22);
    }
    const arm = Wd * .21, lx = L * .17, ly = Wd * .38;
    ctx.fillStyle = '#d8202f';
    ctx.fillRect(-lx, -arm / 2, lx * 2, arm);       // along the car
    ctx.fillRect(-arm / 2, -ly, arm, ly * 2);       // and across it
  } else if (liv === 'police') {
    /* SERBIAN LIVERY, looked up rather than invented: white, a blue chequer band
       down each flank, and a blue LED bar. The bar here alternated blue and RED,
       which is a North American convention — a Belgrade car is blue at both ends
       and what alternates is which end is lit. */
    const on = Math.floor((c.blink || 0) * 7) % 2 === 0;
    // the chequer, seen from above as a band along each side
    const cols = 7, cw = (L * .86) / cols;
    for (const side of [-1, 1]) {
      for (let i = 0; i < cols; i++) {
        if ((i + (side < 0 ? 0 : 1)) % 2) continue;   // offset rows read as a chequer
        ctx.fillStyle = '#0e35a0';
        ctx.fillRect(-L * .43 + cw * i, side < 0 ? -Wd / 2 : Wd / 2 - .26, cw, .26);
      }
    }
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(-L * .12, -Wd / 2 - .06, .5, Wd + .12);
    // one end blue, one end red, and which is bright alternates
    ctx.fillStyle = on ? '#5fb0ff' : '#123a72'; ctx.fillRect(-L * .12, -Wd / 2 - .06, .5, Wd * .5);
    ctx.fillStyle = on ? '#6b1a18' : '#ff544c'; ctx.fillRect(-L * .12, .04, .5, Wd * .5);
    ctx.shadowBlur = 0;
  }
  /* No ring round the player any more. It was here so you could never lose your
     own car in traffic, but on a big screen it reads as a white halo painted on
     the road rather than as a hint, and the car is already the one thing the
     camera is centred on. */
  ctx.restore();
}
function rrect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function drawPed(p) {
  ctx.save(); ctx.translate(p.x, p.y);
  ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.beginPath(); ctx.arc(.15, .15, .48, 0, TAU); ctx.fill();
  ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(0, 0, .45, 0, TAU); ctx.fill();
  ctx.restore();
}

/* off-screen objective arrow */
function drawArrow() {
  const goal = missionGoal();
  const tgt = goal && goal.at;
  if (!tgt) return;
  const s = toScreen(tgt.x, tgt.y);
  const pad = 60;
  if (s[0] > pad && s[0] < VW - pad && s[1] > pad && s[1] < VH - pad) return;
  const dx = s[0] - VW / 2, dy = s[1] - VH / 2;
  const a = Math.atan2(dy, dx);
  const rx = VW / 2 - pad, ry = VH / 2 - pad;
  const k = Math.min(rx / Math.abs(Math.cos(a) || 1e-6), ry / Math.abs(Math.sin(a) || 1e-6));
  const x = VW / 2 + Math.cos(a) * k;
  // keep it clear of the thumb pads when they're on screen
  const botLimit = VH - (touchUI ? 190 : 92);   // clear the armor bar / speedo too
  let y = Math.min(VH / 2 + Math.sin(a) * k, botLimit);
  // and off the radar, which lives in the same left-hand strip. Now that the radar
  // is in the top corner there's no room to dodge upwards, so go under it instead
  // of shoving the arrow off the top of the screen.
  if (miniRect && x < miniRect.right + 60 && y > miniRect.top - 26 && y < miniRect.bottom + 40) {
    const above = miniRect.top - 26, below = miniRect.bottom + 40;
    y = (above > 46 && y < (miniRect.top + miniRect.bottom) / 2) ? above : below;
  }
  y = clamp(y, 46, botLimit);
  const col = goal.col;
  ctx.save(); ctx.translate(x, y); ctx.rotate(a);
  ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 14;
  ctx.beginPath(); ctx.moveTo(16, 0); ctx.lineTo(-10, -10); ctx.lineTo(-5, 0); ctx.lineTo(-10, 10);
  ctx.closePath(); ctx.fill();
  ctx.restore();
  // distance readout
  const d = Math.round(dist(P.car.x, P.car.y, tgt.x, tgt.y));
  ctx.save(); ctx.fillStyle = col; ctx.font = '600 13px system-ui,sans-serif';
  ctx.textAlign = 'center'; ctx.shadowColor = '#000'; ctx.shadowBlur = 6;
  ctx.fillText(d + ' m', x, y + 28); ctx.restore();
}

/* ------------------------------ the big map ------------------------------ */
/* Drawn from the road list rather than from the radar's pre-rendered image: that
   image is a 4 km window at 0.6 px/m, which is the wrong scale and the wrong
   extent for a map you open to find something. This one is redrawn only when it
   moves — opening, panning, pinching — never per frame, so it can afford to walk
   every road in the world. */
const MAPV = { cx: 0, cy: 0, s: 0 };      // centre in metres, scale in px/m

/* THE ZOOM SURVIVES CLOSING THE MAP, and it used not to.
   openMap() called this every time, so a player who pinched in to read a street
   name lost it the moment they closed the map and had to pinch in again — every
   single time. Reported exactly that way.

   THE CENTRE DOES NOT SURVIVE, and that is deliberate rather than an oversight.
   The car has been driving while the map was shut, so reopening on the old
   centre would show you where you used to be; the reason you open a map is to
   find yourself on it. So the scale is kept and the view re-centres.

   `keep` is ignored the first time, when there is no scale to keep — and on a
   NEW CITY, where buildWorld() clears it, because a place you have never seen
   should open on the framing that was chosen for a place you have never seen. */
function mapFit(keep) {
  // Opens on about 5 km across the short axis: far enough to see the next
  // district and the garages in it, close enough that streets are still streets.
  const short = Math.min(VW, VH);
  if (!keep || !MAPV.s) MAPV.s = short / 5000;
  MAPV.cx = P.car.x; MAPV.cy = P.car.y;
  mapClamp();
}
/* HOW BIG A LANDMARK IS DRAWN, at a given zoom.
   Everything else on this overlay — the dots, the faces, the car — is drawn
   unscaled, because a marker that shrinks with the map is a marker you cannot
   find when you are looking at a whole city. That is right at the far end and
   wrong at the near end: pinched all the way in to one block, the same 15 px
   emoji sits there like a footnote on a street it is supposed to be labelling.

   So the size follows the zoom BETWEEN TWO STOPS instead. 90 m of world is the
   nominal footprint of a landmark — roughly a city block — and the glyph is
   drawn that big, floored at the size it has always been so nothing gets worse
   when zoomed out, and capped at 44 px so a hard pinch doesn't fill the screen
   with a hospital sign. On a 390 pt phone that means the default 5 km framing
   is at the floor, growth starts around 2.3 km across, and the ceiling lands
   near 800 m — one neighbourhood, which is where you are reading names anyway.

   Takes MAPV.s, in px per metre, NOT the local `s` inside drawBigMap — that one
   has already been multiplied by DPR, and the DPR comes back on at the point of
   drawing. Passing it here would square the device ratio. */
const MAP_FACE_M = 90, MAP_FACE_MIN = 15, MAP_FACE_MAX = 44;
const mapFaceSize = s => clamp(MAP_FACE_M * s, MAP_FACE_MIN, MAP_FACE_MAX);

function mapClamp() {
  const wide = Math.max(W.maxX - W.minX, 1), tall = Math.max(W.maxY - W.minY, 1);
  /* THE MAP FILLS THE SCREEN. Zooming out used to stop at
     `min(VW/wide, VH/tall) * .9` — the whole world, then a tenth further out
     again — which on a square world in a landscape window put the map across 90%
     of the height and 53% of the width. Nearly half a tablet screen was bare
     ground, and bare ground reads as a map that failed to load rather than as
     one you are meant to pan.

     Filling both axes instead costs nothing, because it is a framing choice and
     not a loading one: the world is already 72 km across in each direction, and
     the SHORT axis still shows all of it. The long axis shows the middle 60% and
     you drag for the rest, which is what every map does — none of them
     letterbox. Zooming in still stops at a metre a pixel. */
  const minS = Math.max(VW / wide, VH / tall);
  MAPV.s = clamp(MAPV.s, minS, 1);
  /* And the edge of the world may not be dragged inside the viewport. Where the
     world is narrower than the view — a generated grid city, or a skeleton that
     only came back at 9 km — there is no pan to allow, so it centres. */
  const halfW = VW / 2 / MAPV.s, halfH = VH / 2 / MAPV.s;
  const pin = (v, lo, hi) => lo > hi ? (lo + hi) / 2 : clamp(v, lo, hi);
  MAPV.cx = pin(MAPV.cx, W.minX + halfW, W.maxX - halfW);
  MAPV.cy = pin(MAPV.cy, W.minY + halfH, W.maxY - halfH);
}

function drawBigMap() {
  const cv = $('bigmapC'), g = cv.getContext('2d');
  const w = Math.floor(VW * DPR), h = Math.floor(VH * DPR);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = PAL.mapBg; g.fillRect(0, 0, w, h);
  if (!MAPV.s) mapFit();

  const s = MAPV.s * DPR;
  g.save();
  g.translate(w / 2, h / 2); g.scale(s, s); g.translate(-MAPV.cx, -MAPV.cy);

  // what's on screen, in metres, so everything below can cull against it
  const halfW = (w / 2) / s, halfH = (h / 2) / s;
  const x0 = MAPV.cx - halfW, x1 = MAPV.cx + halfW;
  const y0 = MAPV.cy - halfH, y1 = MAPV.cy + halfH;
  const near = f => f.bb.x1 >= x0 && f.bb.x0 <= x1 && f.bb.y1 >= y0 && f.bb.y0 <= y1;

  for (const f of W.parks) {
    if (!near(f)) continue;
    g.fillStyle = PAL.mapPark;
    g.beginPath();
    g.moveTo(f.pts[0].x, f.pts[0].y);
    for (let i = 1; i < f.pts.length; i++) g.lineTo(f.pts[i].x, f.pts[i].y);
    g.closePath(); g.fill();
  }

  /* Roads in THREE passes by class, finest first, so the arterials read on top
     of the lattice instead of being lost in it — and so the lattice can be
     dropped once it stops being one.

     Widths have a pixel floor, because at four kilometres across a true-to-scale
     8 m street is a quarter of a pixel and disappears. But a floor is a lie that
     gets worse the further out you go: the detailed centre of Belgrade is eleven
     thousand ways across 5.4 km, most of them service roads round the back of
     buildings, and floored to a pixel each with round joins they stop being
     streets and become one solid white rectangle sitting in the middle of the
     map. Which is exactly what it looked like.

     THE FLOOR WAS IN THE WRONG UNIT, and that is most of the fault. It read
     `1.4 * DPR / s`, which is 1.4 CSS pixels — four and a half DEVICE pixels on
     a phone. Two streets sixty metres apart are ten device pixels apart on a
     7 km view, so four-and-a-half-pixel strokes with round joins cover half the
     gap between them and close the rest at every junction. In device pixels the
     floor is a hairline instead, and the same streets come out as a grid you can
     read. Alleys and then the residential grid still fade out once they are
     finer than that, which is what every paper map does and the reason a road
     atlas doesn't draw every driveway in the county.

     The bands are metres per DEVICE pixel, so a phone and a desktop drop the
     same detail at the same apparent scale. */
  g.lineCap = 'round'; g.lineJoin = 'round';
  const mpp = 1 / s;                                  // metres per device pixel
  const fade = (gone, full) => clamp((gone - mpp) / (gone - full), 0, 1);
  const TIERS = [
    { max: 7,        col: PAL.mapRoad,    w: 5,  px: 0.9, alpha: fade(4, 2.5) },   // service, alleys
    { max: 11,       col: PAL.mapRoad,    w: 7,  px: 1.1, alpha: fade(14, 9) },    // the residential grid
    { max: Infinity, col: PAL.mapRoadBig, w: 13, px: 2.6 * DPR, alpha: 1 },        // arterials
  ];
  let lo = 0;
  for (const t of TIERS) {
    const from = lo; lo = t.max;
    if (t.alpha <= 0) continue;
    g.globalAlpha = t.alpha;
    g.strokeStyle = t.col;
    g.beginPath();
    for (const r of W.roads) {
      if (r.w < from || r.w >= t.max || !near(r)) continue;
      g.moveTo(r.pts[0].x, r.pts[0].y);
      for (let i = 1; i < r.pts.length; i++) g.lineTo(r.pts[i].x, r.pts[i].y);
    }
    // world metres, with a floor expressed in device pixels and converted back
    g.lineWidth = Math.max(t.w, t.px / s);
    g.stroke();
  }
  g.globalAlpha = 1;
  g.restore();

  // Landmarks and markers go on unscaled, so they stay the same size however far
  // you zoom out — a dot that shrinks with the map is a dot you cannot find.
  const toPx = (wx, wy) => [w / 2 + (wx - MAPV.cx) * s, h / 2 + (wy - MAPV.cy) * s];
  const dot = (wx, wy, col, rad) => {
    const [px, py] = toPx(wx, wy);
    if (px < -20 || py < -20 || px > w + 20 || py > h + 20) return;
    g.fillStyle = col; g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 1.4 * DPR;
    g.beginPath(); g.arc(px, py, rad * DPR, 0, TAU); g.fill(); g.stroke();
  };
  /* THE DOT STAYS UNDER THE FACE. The emoji says what it is; the coloured disc
     under it is what makes it findable at a glance across a whole city, and it
     is what still reads when the platform has no glyph for one of these and
     draws a box. Belt and braces on purpose — this map is opened to find one
     specific building. */
  const face = (wx, wy, kind, px) => {
    const [x, y] = toPx(wx, wy);
    if (x < -20 || y < -20 || x > w + 20 || y > h + 20) return;
    const e = POI_EMOJI[kind];
    if (!e) return;
    g.save();
    g.font = (px * DPR) + 'px ' + POI_FACE_FONT;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    /* A dark rim, drawn as a stroke behind the glyph. Emoji are drawn by the
       platform in their own colours and several of these are pale, which is
       invisible against a pale daylight map. */
    g.lineWidth = Math.max(2, px * .2) * DPR; g.strokeStyle = 'rgba(0,0,0,.55)';
    g.strokeText(e, x, y - px * .05 * DPR);
    g.fillText(e, x, y - px * .05 * DPR);
    g.restore();
  };
  /* The dot grows with the face it sits under, at the ratio the two had when
     both were fixed — 4.2 px of disc to 15 px of glyph — so zooming in scales
     the whole marker rather than sliding a growing emoji off a stuck dot. */
  const fpx = mapFaceSize(MAPV.s), dotR = fpx * .28;
  for (const p of W.pois) dot(p.x, p.y, POI_COL[p.kind], dotR);
  const goal = missionGoal();
  if (goal) dot(goal.at.x, goal.at.y, goal.col, dotR * 1.4);
  // faces over the top of every dot, so one landmark never hides another's
  for (const p of W.pois) face(p.x, p.y, p.kind, fpx);
  if (goal) face(goal.at.x, goal.at.y, goal.kind, fpx * 1.2);

  /* THE CAR, POINTING WHERE IT IS POINTING — and big enough to find.

     Reported as not being able to find yourself on the map. It was a 16 by 13
     device-pixel arrowhead, which on a phone at DPR 3 is five points across and
     is competing with a city; at 26 by 21 it is the largest single thing on the
     overlay, which is what it should be. The whole point of opening a map is to
     find yourself on it.

     IT DOES NOT SCALE WITH THE ZOOM, unlike the landmark faces beside it, and
     that is deliberate rather than an oversight: the landmarks grow because
     zooming in is asking to read the street they are on, while the car has to be
     equally findable at every zoom — most of all at the far end, where the
     reason to look is that you have lost track of where you are. */
  const ME = 15 * DPR;
  const [cx, cy] = toPx(P.car.x, P.car.y);
  g.save(); g.translate(cx, cy); g.rotate(P.car.h + Math.PI / 2);
  g.fillStyle = '#fff'; g.strokeStyle = '#12061d'; g.lineWidth = 2.2 * DPR;
  g.beginPath();
  g.moveTo(0, -ME); g.lineTo(ME * .71, ME * .78); g.lineTo(0, ME * .4); g.lineTo(-ME * .71, ME * .78);
  g.closePath(); g.fill(); g.stroke();
  g.restore();

  drawMapScale(g, w, h, s);
}

/* ------------------------- the objective's ping ------------------------- */
/* WHERE THE JOB IS, AS ONE ANSWER. Three places were each asking the question
   their own way — the big map's dot, the big map's face, the radar's blip — and
   a fourth about to. The colour is part of the answer: the pickup is the pink
   the arrow uses and the drop-off is GOLD, and getting that pair wrong in one
   of the four is precisely the kind of thing nobody notices for a month. */
function missionGoal() {
  const S = MISSION.state;
  if (S === 'pickup' && MISSION.pick) return { at: MISSION.pick, col: '#ff4fd8', kind: 'pickup' };
  if (S === 'deliver' && MISSION.drop) return { at: MISSION.drop, col: GOLD, kind: 'drop' };
  if (S === 'fire' && MISSION.fire) return { at: MISSION.fire, col: '#ff6a2b', kind: 'blaze' };
  /* THE RUNAWAY IS RED. It was the same blue the patrol cars and the police
     station blip are drawn in, which put the one car you are chasing in the
     livery of the people chasing it — on a shift where half the blips on the
     radar are police, the target was indistinguishable from the backup. */
  if (S === 'chase' && MISSION.chase) return { at: MISSION.chase, col: '#ff2e3f', kind: 'chase' };
  return null;
}

/* THE PING IS ON THE WALL CLOCK, not on the simulated one.
   SIMT stops while the map is open — the loop does not step a paused world — and
   below twelve frames a second it runs slow even while driving, so a pulse tied
   to it would freeze on the map and stutter on a struggling phone. This is
   decoration; it should breathe at the same rate whatever the game is doing. */
const PULSE_MS = 1500;
const pulseAt = now => (((now == null ? performance.now() : now) % PULSE_MS) / PULSE_MS);
/* TWO RINGS, HALF A PERIOD APART, and that is not decoration on the decoration.
   One ring leaves a dead beat every cycle where the old ping has faded out and
   the new one has not yet grown enough to see, which reads as a stutter rather
   than as a pulse. With a second ring offset by half a cycle there is always one
   on the way out and one on the way in. */
const PULSE_RINGS = [0, .5];
/* Drawn from the marker's own size out to three and a half times it, so the ping
   scales with the zoom exactly as the emoji and its dot now do. */
function pulseRing(g, x, y, base, col, k) {
  const r = base * (.55 + 2.9 * k);
  const a = Math.pow(1 - k, 1.7);
  if (a <= .02) return;
  g.save();
  g.globalAlpha = a * .9;
  g.strokeStyle = col;
  g.lineWidth = Math.max(1.5, base * .22) * (1 - k * .55);
  g.beginPath(); g.arc(x, y, r, 0, TAU); g.stroke();
  g.restore();
}

/* The big map's ping, on its own layer above the drawn city. Returns whether it
   found anything to draw, which is what the test asks it. */
function drawMapPulse(now) {
  const cv = $('bigmapFX');
  if (!cv) return false;
  const g = cv.getContext('2d');
  const w = Math.floor(VW * DPR), h = Math.floor(VH * DPR);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, w, h);
  const goal = missionGoal();
  if (!goal || !MAPV.s) return false;
  const s = MAPV.s * DPR;
  const x = w / 2 + (goal.at.x - MAPV.cx) * s;
  const y = h / 2 + (goal.at.y - MAPV.cy) * s;
  const base = mapFaceSize(MAPV.s) * DPR;
  // the ping reaches well past the marker, so the cull has to allow for it
  const pad = base * 3.6;
  if (x < -pad || y < -pad || x > w + pad || y > h + pad) return false;
  const k0 = pulseAt(now);
  for (const off of PULSE_RINGS) pulseRing(g, x, y, base, goal.col, (k0 + off) % 1);
  return true;
}
/* A scale bar, because "is that garage worth driving to" is a question about
   distance and the zoom moves. Picks a round number of metres that lands near a
   fifth of the screen. */
function drawMapScale(g, w, h, s) {
  const want = w / 5;
  const steps = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
  let m = steps[steps.length - 1];
  for (const st of steps) if (st * s >= want * .55) { m = st; break; }
  const px = m * s, x = 14 * DPR, y = h - 34 * DPR;
  g.save();
  g.strokeStyle = 'rgba(255,255,255,.75)'; g.fillStyle = 'rgba(255,255,255,.75)';
  g.lineWidth = 2 * DPR;
  g.beginPath();
  g.moveTo(x, y - 5 * DPR); g.lineTo(x, y); g.lineTo(x + px, y); g.lineTo(x + px, y - 5 * DPR);
  g.stroke();
  g.font = '600 ' + (11 * DPR) + 'px system-ui,sans-serif';
  g.textBaseline = 'bottom';
  g.fillText(m >= 1000 ? (m / 1000) + ' km' : m + ' m', x, y - 7 * DPR);
  g.restore();
}

/* ---- HUD text is DOM; only the numbers change, and only ~12×/s ---- */
let hudT = 0;
function drawHUD() {
  const c = P.car;
  $('spdN').textContent = Math.round(Math.hypot(c.vx, c.vy) * 3.6);
  hudT -= 1;
  if (hudT > 0) return;
  hudT = 5;
  $('cash').textContent = '$' + P.cash.toLocaleString();
  $('hpIn').style.width = clamp(c.hp, 0, 100) + '%';
  $('hpIn').style.background = c.hp > 55 ? 'linear-gradient(90deg,#48ff9e,#33e6ff)'
    : c.hp > 25 ? 'linear-gradient(90deg,#ffe36a,#ff9f5a)' : 'linear-gradient(90deg,#ff3355,#ff4fd8)';
  const w = Math.ceil(P.wanted);
  let s = '';
  for (let i = 0; i < 5; i++) s += i < w ? '★' : '<span class="off">★</span>';
  $('stars').innerHTML = s;
  const ch = $('chunk');
  if (CHUNK.note) { ch.textContent = CHUNK.note; ch.classList.add('on'); }
  else ch.classList.remove('on');
  if (MISSION.state === 'deliver') {
    $('timer').textContent = txt('hud.secs', { n: Math.max(0, Math.ceil(MISSION.time)) });
  } else $('timer').textContent = '';
}

/* The monuments in the world, cached against the building count. Buildings are
   only ever appended or filtered wholesale, so a change in length is exactly
   when this can go stale. */
let monuList = [], monuAt = -1;
function monumentList() {
  if (monuAt !== W.buildings.length) {
    monuAt = W.buildings.length;
    monuList = W.buildings.filter(b => b.mono);
  }
  return monuList;
}

function drawMini() {
  if (!W.map) return;
  const w = mini.width, h = mini.height, r = w / 2;
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.clearRect(0, 0, w, h);
  mctx.save();
  mctx.beginPath(); mctx.arc(r, r, r, 0, TAU); mctx.clip();
  mctx.fillStyle = PAL.mapBg; mctx.fillRect(0, 0, w, h);

  const showM = 230;                                  // metres across the radius
  const z = (r / showM) / W.mapScale;
  mctx.translate(r, r); mctx.rotate(rot); mctx.scale(z, z);
  mctx.translate(-(P.car.x - W.mapOrigin.x) * W.mapScale, -(P.car.y - W.mapOrigin.y) * W.mapScale);
  mctx.drawImage(W.map, 0, 0);
  mctx.restore();

  // blips, drawn unrotated relative to the rotated map
  const blip = (wx, wy, col, sz) => {
    const dx = (wx - P.car.x), dy = (wy - P.car.y);
    const px = r + (dx * cs - dy * sn) * (r / showM);
    const py = r + (dx * sn + dy * cs) * (r / showM);
    if (dist2(px, py, r, r) > r * r) return;
    mctx.fillStyle = col;
    mctx.beginPath(); mctx.arc(px, py, sz * DPR, 0, TAU); mctx.fill();
  };
  for (const t of traffic) blip(t.x, t.y, 'rgba(255,255,255,.45)', 1.6);

  /* LANDMARKS. They are already baked into the pre-rendered map — and at 0.6
     px/m, scaled down again to fit 230 m across a 98 px phone radar, a five
     pixel dot lands under two pixels. Which is why a player with two hundred
     repair shops around him could not find one. Drawn as blips they are the
     same size as everything else you are meant to see. */
  for (const p of W.pois) {
    if (Math.abs(p.x - P.car.x) > showM || Math.abs(p.y - P.car.y) > showM) continue;
    blip(p.x, p.y, POI_COL[p.kind], 3);
  }
  /* Monuments, in stone. They live in W.buildings rather than in W.pois — a
     memorial is a thing you drive round, not a service you drive to.

     LISTED ONCE, NOT SEARCHED EVERY FRAME. This walked the building spatial hash
     over the radar's window each frame and allocated a Set to de-duplicate the
     footprints that span several cells — a few hundred index lookups and one
     collection per frame, in the 2D renderer, for a handful of statues. It cost
     nine frames a second: drift.mjs measured 61 fps before it and 52 after,
     against a gate of 55, which is how it was noticed.

     There are only ever a few monuments in a world, so the answer is a list,
     rebuilt when the building count changes — which is tile streaming, a few
     times a minute — and simply read on every frame in between. */
  for (const m of monumentList()) {
    if (Math.abs(m.cx - P.car.x) > showM || Math.abs(m.cy - P.car.y) > showM) continue;
    blip(m.cx, m.cy, MONU_COL, 3.2);
  }

  for (const k of cops) blip(k.x, k.y, '#3fa2ff', 2.8);
  /* THE OBJECTIVE PINGS HERE TOO, in step with the big map's — same clock, same
     period, so opening the map does not restart it or catch it out of phase.
     This is the surface you actually look at while driving; a job blip that
     breathes is findable among two dozen static dots in a way a slightly bigger
     one is not.

     CLIPPED TO THE DISC, unlike the blips. A blip is culled by its centre, which
     is enough for a dot and not enough for a ring three times its width: near
     the rim the ping would spill onto the HUD. The CSS rounds the canvas off and
     would hide it on screen, which is exactly what makes this worth doing in the
     canvas — a test reads the pixels, not the border-radius. */
  const goal = missionGoal();
  if (goal) {
    blip(goal.at.x, goal.at.y, goal.col, 3.4);
    const dx = goal.at.x - P.car.x, dy = goal.at.y - P.car.y;
    const px = r + (dx * cs - dy * sn) * (r / showM);
    const py = r + (dx * sn + dy * cs) * (r / showM);
    if (dist2(px, py, r, r) <= r * r) {
      mctx.save();
      mctx.beginPath(); mctx.arc(r, r, r, 0, TAU); mctx.clip();
      const k0 = pulseAt();
      for (const off of PULSE_RINGS) pulseRing(mctx, px, py, 3.4 * DPR, goal.col, (k0 + off) % 1);
      mctx.restore();
    }
  }

  /* ON THE RIM, for the things worth driving to that are further off than the
     radar reaches. Everything above this only exists inside 230 m, which is
     about four seconds at speed — so anything you are deliberately heading for
     spends nearly all of its life invisible unless it gets a pointer. */
  /* TWO POINTERS IN THE SAME DIRECTION MUST NOT HIDE EACH OTHER, and before this
     the second one drawn simply painted over the first. The objective goes on
     after the garage, so whenever the two happened to lie along the same bearing
     the garage pointer vanished completely — and that is not a rare coincidence,
     it is what happens every time the job is up the road you would take to get
     repaired anyway, which is most of the time on a grid.

     It surfaced as a flaky test rather than as a bug report: radar.mjs failed
     about one run in eighteen, always on the garage rim pointer, which measured
     anywhere between 4 and 157 pixels of green depending on where that run's
     random delivery happened to land. Four pixels is the tip poking out from
     under a pink triangle.

     So each pointer remembers its bearing, and one that lands within a pointer's
     own width of an earlier one is pushed along the rim until it clears — away
     from its neighbour, so the pair opens outwards and both stay on the side
     they belong to. The label goes with it. A few degrees at the rim is under
     ten metres of implied direction at the distances these are used at, and a
     pointer you can see beats a bearing you cannot. */
  const taken = [];
  const SEP = .17;                             // radians; a pointer is ~0.14 wide
  const rimTo = (tx, ty, col, strong) => {
    const dx = tx - P.car.x, dy = ty - P.car.y;
    const d = Math.hypot(dx, dy);
    if (d <= showM) return;                    // it has a blip of its own in there
    let a = Math.atan2(dx * sn + dy * cs, dx * cs - dy * sn);   // into radar space
    for (const t of taken) {
      const gap = Math.atan2(Math.sin(a - t), Math.cos(a - t));
      if (Math.abs(gap) < SEP) a = t + (gap >= 0 ? SEP : -SEP);
    }
    taken.push(a);
    const rim = r - 5 * DPR;
    mctx.save();
    mctx.translate(r + Math.cos(a) * rim, r + Math.sin(a) * rim);
    mctx.rotate(a);
    mctx.globalAlpha = strong ? 1 : .8;
    mctx.fillStyle = col;
    mctx.shadowColor = col; mctx.shadowBlur = (strong ? 8 : 4) * DPR;
    const s2 = (strong ? 5.4 : 4.4) * DPR;
    mctx.beginPath();
    mctx.moveTo(s2, 0); mctx.lineTo(-s2 * .8, -s2 * .8); mctx.lineTo(-s2 * .8, s2 * .8);
    mctx.closePath(); mctx.fill();
    mctx.restore();
    /* How far, just inside the rim — the whole point is deciding whether to go.

       OUTLINED RATHER THAN SHADOWED, for legibility rather than for speed. A
       stroke under the fill holds its edge over the pale daylight map, where a
       soft black blur behind yellow-green text mostly just muddies it.

       It is cheaper too, since a blurred shadow is among the more expensive
       things a 2D canvas does — but not by anything worth claiming. The honest
       number, benchmarked by timing 400 drawMini() calls with the objective
       pointer present and absent, is that the whole pointer costs EIGHT
       MICROSECONDS a frame. It was briefly suspected of costing four frames a
       second in wasted.mjs; that was the test's own 7 fps run-to-run spread, and
       the test has been fixed rather than this. */
    mctx.save();
    mctx.globalAlpha = strong ? 1 : .85;
    mctx.font = '700 ' + (8.5 * DPR) + 'px system-ui,sans-serif';
    mctx.textAlign = 'center'; mctx.textBaseline = 'middle';
    const lr = rim - 11 * DPR;
    const lx = r + Math.cos(a) * lr, ly = r + Math.sin(a) * lr;
    const label = d > 950 ? (d / 1000).toFixed(1) + 'k' : Math.round(d) + '';
    mctx.lineWidth = 3 * DPR; mctx.lineJoin = 'round';
    mctx.strokeStyle = 'rgba(0,0,0,.85)';
    mctx.strokeText(label, lx, ly);
    mctx.fillStyle = col;
    mctx.fillText(label, lx, ly);
    mctx.restore();
  };

  // the nearest garage, brighter once the armour is low enough to want it
  const rep = nearestPOI('repair', P.car.x, P.car.y);
  if (rep) rimTo(rep.x, rep.y, POI_COL.repair, P.car.hp < 55);

  /* AND THE OBJECTIVE, which had no radar mark of any kind past 230 m — the one
     thing on screen the player is actually driving towards was the only thing
     without one. A delivery is routinely a kilometre off, so for almost the
     whole run the radar showed traffic, police and garages and said nothing
     about the job. Reported as "there is no violet arrow on the minimap", which
     is exactly right: the blip existed, it was just never in range.

     Always at full strength, because unlike the garage this is not a suggestion
     — it is the current task, and the colour matches the arrow on the screen and
     the marker on the city map. */
  // `goal` is already in hand from the blip above — the same one answer
  if (goal) rimTo(goal.at.x, goal.at.y, goal.col, true);

  // player triangle at centre, always pointing up
  mctx.save(); mctx.translate(r, r);
  mctx.fillStyle = '#fff'; mctx.strokeStyle = '#12061d'; mctx.lineWidth = 1.4 * DPR;
  mctx.beginPath();
  mctx.moveTo(0, -6 * DPR); mctx.lineTo(4.4 * DPR, 5 * DPR); mctx.lineTo(0, 2.6 * DPR); mctx.lineTo(-4.4 * DPR, 5 * DPR);
  mctx.closePath(); mctx.fill(); mctx.stroke();
  mctx.restore();
}
