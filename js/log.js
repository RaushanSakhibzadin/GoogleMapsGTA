"use strict";
/* VICE MAPS — The session log: what the map servers said, and what went wrong.

   Part of a set of plain <script> files sharing one global scope. They are NOT
   modules on purpose: ES modules are blocked over file://, and opening
   index.html straight off disk with no build step is the point of this thing.
   Load order is fixed in index.html and matters — this one comes before geo.js,
   because the first Overpass reply has to be captured and geo.js is what fetches
   it.

   WHY THIS EXISTS. Every bug in this game gets diagnosed against a fixture I
   wrote by hand, because the machine doing the diagnosing cannot reach Overpass.
   That is a guess about the shape of real data dressed up as a test: the "car
   crawls on tarmac" fault was pedestrian squares in real Belgrade, and it was
   only reproducible once the fixture happened to contain one. A file with the
   actual server replies in it removes the guess — the same city, the same
   tagging, through the same code. */

/* ------------------------------ 0.5 log ------------------------------ */
const LOG = (() => {
  const T0 = Date.now();
  /* Whole megabytes of map data, kept deliberately. The alternative is a
     summary, and a summary is exactly the guess this is meant to replace. The
     cap keeps the earliest replies rather than the newest: the opening streets,
     the skeleton and the first tiles ARE the city you started in, and a later
     building tile from six kilometres away is the least useful thing here. */
  const MAX_BYTES = 25 * 1024 * 1024;
  const MAX_ERRORS = 600;             // a loop in a hot path must not eat the heap
  const osm = [], errors = [];
  let bytes = 0, dropped = 0, droppedBytes = 0;

  const at = () => +((Date.now() - T0) / 1000).toFixed(2);

  /* One reply from a map server, kept verbatim. `body` is the exact text that
     arrived, before anything parsed it — anything less and this stops being a
     recording and starts being my opinion of the recording. */
  function addOsm(rec) {
    const size = (rec.body || '').length;
    if (bytes + size > MAX_BYTES) { dropped++; droppedBytes += size; return; }
    bytes += size;
    osm.push(Object.assign({ at: at() }, rec));
  }

  function addError(level, msg, stack) {
    if (errors.length >= MAX_ERRORS) return;
    // a stuck error repeating every frame becomes one line with a count
    const last = errors[errors.length - 1];
    if (last && last.level === level && last.msg === msg) { last.n = (last.n || 1) + 1; last.lastAt = at(); return; }
    errors.push({ at: at(), level, msg, stack: stack || undefined });
  }

  const text = a => Array.prototype.map.call(a, v => {
    if (v instanceof Error) return v.message;
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }).join(' ');

  addEventListener('error', e => {
    // resource errors (a missing file) carry no message and a target instead
    if (!e.message && e.target && e.target.src) return addError('resource', 'failed to load ' + e.target.src);
    addError('error', e.message + (e.filename ? ' @ ' + e.filename.split('/').pop() + ':' + e.lineno : ''),
             e.error && e.error.stack);
  }, true);
  addEventListener('unhandledrejection', e => {
    const r = e.reason;
    addError('rejection', r && r.message ? r.message : String(r), r && r.stack);
  });

  /* The game reports its real failures through console.warn — a chunk that never
     arrived, a skeleton rung that timed out, buildings refused. Those are the
     lines worth having, so the console is wrapped rather than asking every call
     site to remember to log twice. */
  for (const level of ['error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = function () { addError(level, text(arguments)); orig.apply(null, arguments); };
  }

  return {
    osm: addOsm,
    note: (level, msg) => addError(level, msg),
    stats: () => ({ osm: osm.length, errors: errors.length, bytes, dropped }),
    /* The file. OSM replies FIRST, because that is what someone reading this is
       here for; the state of the game when the button was pressed, and then
       everything that went wrong, after. */
    build() {
      return {
        vicemaps: 1,
        /* WHICH BUILD THIS IS, at the very top, because the first question about
           any report is whether it describes the code in front of you. Every
           script and stylesheet is already addressed by this hash — it is a hash
           of their contents — so it names the running program exactly, and a
           phone quietly serving a fortnight-old cache says so here instead of
           being argued about. */
        build: typeof BUILD === 'string' ? BUILD : (window.BUILD || 'unknown'),
        savedAt: new Date().toISOString(),
        sessionSeconds: at(),
        osm,
        capture: { bytes, cappedAt: MAX_BYTES, repliesDropped: dropped, bytesDropped: droppedBytes },
        snapshot: typeof snapshot === 'function' ? snapshot() : null,
        errors
      };
    }
  };
})();

/* What the game looked like at the moment the button was pressed. Wrapped so a
   half-built world — pressing the button on the menu, or mid-load — reports what
   it has instead of throwing and costing us the whole file. */
function snapshot() {
  const s = { url: location.href, ua: navigator.userAgent,
              screen: innerWidth + 'x' + innerHeight + ' @' + (devicePixelRatio || 1),
              state: typeof state !== 'undefined' ? state : null };
  try {
    s.city = W.name; s.procedural = W.procedural;
    s.world = { roads: W.roads.length, drive: W.driveRoads.length, buildings: W.buildings.length,
                parks: W.parks.length, pois: W.pois.length, grid: W.gw + 'x' + W.gh,
                bounds: { x0: W.minX, y0: W.minY, x1: W.maxX, y1: W.maxY },
                skeleton: W.skelRect ? (W.skelRect.x1 - W.skelRect.x0) / 2 : null,
                wideMap: typeof WIDE_MAP !== 'undefined' ? WIDE_MAP : null };
    // roaded is the count of tiles whose STREETS have landed, which is the
    // question a report of "no roads here" is really asking
    s.tiles = { loaded: CHUNK.loaded, roaded: ROADED.size, failed: CHUNK.failed,
                evicted: CHUNK.evicted, live: W.tiles.size };
  } catch (e) { s.worldError = String(e && e.message || e); }
  try {
    const c = P.car;
    s.car = { x: +c.x.toFixed(1), y: +c.y.toFixed(1), h: +c.h.toFixed(2),
              kmh: Math.round(Math.hypot(c.vx, c.vy) * 3.6), hp: Math.round(c.hp),
              onRoad: !!c.road, onTarmac: onTarmac(c.x, c.y),
              roadDataHere: roadDataHere(c.x, c.y), ghost: typeof GHOST !== 'undefined' ? GHOST : null,
              street: NAV.street, zone: NAV.zone, cash: P.cash, wanted: P.wanted };
  } catch (e) { s.carError = String(e && e.message || e); }
  try { s.perf = { upd: +PERF.upd.toFixed(2), ren: +PERF.ren.toFixed(2), steps: +PERF.steps.toFixed(2) }; } catch (e) {}
  /* THE STATE OF THE CHASE VIEW, whether or not anybody pressed the button.
     "3D is not available" was reported twice with a log that had no way to say
     anything about it: no record of whether a context had ever been asked for,
     what the browser said when it refused, or whether the machine has WebGL at
     all. `probe` is the honest answer to "could this phone do it right now" —
     a throwaway canvas, so it costs nothing and cannot disturb the real one. */
  try {
    s.gl = { mode3d: typeof MODE3D !== 'undefined' ? MODE3D : null,
             attempts: GL.attempts, ready: !!GL.gl, fail: GL.fail,
             why: GL.why, webgl1: GL.webgl1, renderer: GL.renderer, lost: GL.lost };
    if (!GL.gl) {
      let probe = 'no';
      try {
        const c = document.createElement('canvas');
        probe = c.getContext('webgl2') ? 'yes' : (c.getContext('webgl') ? 'webgl1 only' : 'no');
      } catch (e) { probe = String(e && e.message || e); }
      s.gl.probe = probe;
    }
  } catch (e) { s.glError = String(e && e.message || e); }
  try { s.shops = W.shops.length; } catch (e) {}
  return s;
}

/* Hand the file over. On a phone this is the whole feature working or not: a
   Blob download is routinely swallowed by iOS Safari, which opens the JSON in a
   tab and leaves you with no way to keep it. The share sheet is the path that
   actually offers Save to Files, AirDrop and Messages — and iOS only honours it
   from inside a real tap, which is why everything here is synchronous up to the
   share() call and nothing awaits before it. */
function saveLog() {
  const name = 'vicemaps-' + (() => {
    try { return (W.name || 'log').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'log'; }
    catch (e) { return 'log'; }
  })() + '-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.json';

  let blob;
  try {
    blob = new Blob([JSON.stringify(LOG.build())], { type: 'application/json' });
  } catch (e) {
    toast('LOG TOO BIG TO SAVE', 2200);
    return { ok: false, how: 'failed', error: String(e && e.message || e) };
  }

  const file = (() => {
    try { return new File([blob], name, { type: 'application/json' }); } catch (e) { return null; }
  })();

  if (file && navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
    navigator.share({ files: [file], title: name })
      .then(() => toast('LOG SAVED', 1600))
      // a cancelled share is not a failure; anything else falls back to a download
      .catch(err => { if (!err || err.name !== 'AbortError') download(blob, name); });
    return { ok: true, how: 'share', name, bytes: blob.size };
  }
  download(blob, name);
  return { ok: true, how: 'download', name, bytes: blob.size };
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // long enough for the download to start; revoking immediately kills it on Safari
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast('LOG SAVED', 1600);
}
