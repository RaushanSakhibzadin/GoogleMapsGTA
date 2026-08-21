/* PUT A VERSION ON EVERY SCRIPT AND STYLESHEET index.html ASKS FOR.
 *
 *     node tools/stamp.mjs            rewrite the stamps
 *     node tools/stamp.mjs --check    exit 1 if any are stale, change nothing
 *
 * A deployed build was invisible to the person who asked for it: the phone had
 * index.html and eleven .js files in Safari's cache, every one of them addressed
 * by a name that never changes, and it went on running a fortnight-old game long
 * after the new one was live. Told to look again, it fetched some of the files
 * and not others.
 *
 * THAT SECOND FAILURE IS THE DANGEROUS ONE. HTML and its subresources expire
 * independently, so a cache is free to pair a NEW index.html with an OLD
 * render3d.js — or the reverse. Both halves work perfectly on their own. This
 * build added js/carmesh.js and called it from render3d.js, so a cached index
 * that has never heard of carmesh.js, serving a fresh render3d.js that calls
 * carModel(), is a ReferenceError on the first frame and a black 3D view. A
 * stale build is a disappointment; a half-stale one is a crash.
 *
 * So every local script and stylesheet carries ?v=<hash>, and the hash is of the
 * CONTENT of all of them together. Which gives the property that matters: the
 * URLs change if and only if the code changes. Nothing to remember to bump, no
 * dates, and a byte-identical rebuild produces byte-identical URLs that stay
 * cached exactly as they should. A single shared hash rather than one per file
 * because these files are one program — they are written to be loaded together
 * in a fixed order, they change together, and the whole set is about 200 KB.
 *
 * index.html itself is the one thing that cannot be stamped, since its URL is
 * the site. GitHub Pages serves it with max-age=600, so a stale index lasts ten
 * minutes and then picks up whatever the current stamps are.
 *
 * NO BUILD STEP, still. This edits one file in place and is run by hand before a
 * deploy; tests/stamp.mjs fails the suite if it was forgotten. Opening
 * index.html off the disk works exactly as it did — a query string on a file://
 * URL is ignored by every browser.
 */
import { readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = join(ROOT, 'index.html');

/* Matches src="js/foo.js" and href="style.css", with or without a stamp already
   on them. Deliberately narrow: it must not touch the icons, the manifest, the
   canonical URL or any absolute link. */
const REF = /(src|href)="((?:js\/[\w.-]+\.js)|(?:style\.css))(\?v=[0-9a-f]+)?"/g;

export function refsOf(html) {
  const out = [];
  for (const m of html.matchAll(REF)) out.push({ file: m[2], stamp: m[3] || '' });
  return out;
}

/* Loaded by js/world.js at runtime rather than by index.html, so it gets the
   version through window.BUILD instead of through a tag — but it is shipped code
   and it belongs in the hash like everything else. */
const EXTRA = ['data/belgrade.js'];
const BUILD = /(window\.BUILD\s*=\s*')[0-9a-f]*(')/;

/* The hash covers the files IN THE ORDER index.html loads them, and the names
   as well as the bodies. Order is part of what this program is — these scripts
   share one global scope and a reordering is a different build even if every
   byte is the same — and including the names means adding or removing a file
   moves the hash even in the impossible case that the bytes cancel out. */
export function versionOf(html) {
  const h = createHash('sha1');
  for (const f of refsOf(html).map(r => r.file).concat(EXTRA)) {
    h.update(f);
    h.update(readFileSync(join(ROOT, f)));
  }
  return h.digest('hex').slice(0, 10);
}

export function stamp(html, v) {
  return html.replace(REF, (_, attr, file) => `${attr}="${file}?v=${v}"`)
             .replace(BUILD, (_, a, b) => a + v + b);
}

/* Run as a command, not imported. Compared as a resolved path rather than by
   name: tests/stamp.mjs imports this, and an endsWith('stamp.mjs') check matched
   the TEST's name too — so importing the module ran the command-line half of it,
   which printed a line and then called process.exit(0) before the test had
   asserted anything. It exited zero, so the suite would have called it a pass. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const html = readFileSync(HTML, 'utf8');
  const v = versionOf(html);
  const next = stamp(html, v);
  const check = process.argv.includes('--check');
  if (next === html) {
    console.log('stamps up to date: v=' + v);
    process.exit(0);
  }
  if (check) {
    const stale = refsOf(html).filter(r => r.stamp !== '?v=' + v);
    console.error('stale or missing stamps (want v=' + v + '):');
    for (const r of stale) console.error('  ' + r.file + ' ' + (r.stamp || '(none)'));
    console.error('run: node tools/stamp.mjs');
    process.exit(1);
  }
  writeFileSync(HTML, next);
  console.log('stamped ' + refsOf(next).length + ' files at v=' + v);
}
