/* BUILD THE SITE FOR A DOMAIN OF ITS OWN.
 *
 * GitHub Pages serves this from a subpath — /GoogleMapsGTA/ — and a domain
 * serves it from the root. Almost nothing cares: every script, stylesheet,
 * icon and data file in index.html is referenced relatively, and manifest.json
 * uses "./", so the game itself runs from either place unchanged. What does
 * care is the handful of ABSOLUTE urls, which are metadata: the canonical link,
 * the Open Graph and Twitter cards, and the JSON-LD block. Left pointing at
 * github.io they tell every crawler and every chat app that unfurls a link that
 * the real address is somewhere else, which is exactly wrong on the copy that
 * is meant to be the address.
 *
 *   node tools/mirror.mjs                          # https://realcityauto.com
 *   node tools/mirror.mjs https://example.com      # anywhere else
 *
 * Writes dist/<host>/ and dist/<host>.zip. Upload the CONTENTS of that folder
 * into public_html — index.html has to sit directly in public_html, not in a
 * subfolder.
 *
 * A BUILD STEP RATHER THAN A HAND-EDITED COPY, because the site changes most
 * days and a mirror that is edited by hand is a mirror that silently falls
 * behind. Re-run this and re-upload; it is the same two commands every time.
 *
 * What it does NOT copy: tests/, tools/, README.md, .github/ and .nojekyll.
 * None of them are the site, .nojekyll means nothing off Pages, and the test
 * suite is several megabytes of fixtures nobody should be serving.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = 'https://raushansakhibzadin.github.io/GoogleMapsGTA/';

const arg = process.argv[2] || 'https://realcityauto.com';
const origin = arg.replace(/\/+$/, '');                    // no trailing slash
let host;
try { host = new URL(origin).host; }
catch { throw new Error(`mirror: "${arg}" is not a url — try https://realcityauto.com`); }

const OUT = join(ROOT, 'dist', host);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/* The site, and only the site. Named rather than globbed so that a new
   directory in the repo root cannot quietly end up on the public web. */
const FILES = ['index.html', 'style.css', 'manifest.json', 'favicon.svg',
               'icon-180.png', 'icon-192.png', 'icon-512.png', 'og.jpg', 'version.txt'];
const DIRS = ['js', 'data'];
for (const f of FILES) {
  if (!existsSync(join(ROOT, f))) throw new Error(`mirror: ${f} is missing`);
  cpSync(join(ROOT, f), join(OUT, f));
}
for (const d of DIRS) cpSync(join(ROOT, d), join(OUT, d), { recursive: true });

// the metadata, pointed at the domain it is being served from
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const fixed = html.split(PAGES).join(origin + '/');
const moved = html.split(PAGES).length - 1;
if (!moved) throw new Error('mirror: found no urls to rewrite — has the canonical link changed?');
writeFileSync(join(OUT, 'index.html'), fixed);

writeFileSync(join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${origin}/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`);

/* AND A robots.txt, which the Pages build cannot have. robots.txt is only ever
   read from a domain root, and for a project Pages site that root belongs to a
   different repository — the note in sitemap.xml says as much. On a domain of
   its own the sitemap can simply be advertised. */
writeFileSync(join(OUT, 'robots.txt'), `User-agent: *
Allow: /

Sitemap: ${origin}/sitemap.xml
`);

let zip = null;
try {
  execFileSync('zip', ['-qr', join(ROOT, 'dist', host + '.zip'), '.'], { cwd: OUT });
  zip = join('dist', host + '.zip');
} catch {
  // no zip binary — the folder is the deliverable either way
}
const version = readFileSync(join(ROOT, 'version.txt'), 'utf8').trim();
console.log(`mirror of ${origin} built at dist/${host}/  (asset stamp ${version})`);
console.log(`  ${moved} absolute urls repointed, sitemap.xml and robots.txt written`);
if (zip) console.log(`  ${zip} — upload its CONTENTS into public_html`);
