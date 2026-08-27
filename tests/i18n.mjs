/* THE GAME IN TEN LANGUAGES, AND THE FIVE WAYS THAT GOES WRONG QUIETLY.
 *
 * A translated UI is unusually good at looking finished while being broken,
 * because the person who built it can only read one of the ten columns. Every
 * section here is a failure that a screenshot in English would not show.
 *
 *   THE SYSTEM LANGUAGE IS IGNORED. The whole request was "the language should
 *   be the language of the system", and the tags a real phone sends are not the
 *   keys in the table: sr-Latn-RS, pt-BR, zh-Hans-CN. Driven through seven real
 *   locale strings rather than by calling the picker with tidy two-letter codes.
 *
 *   A LANGUAGE HAS HOLES IN IT. One missing key renders as the key — `menu.drive`
 *   on the DRIVE button — so every locale is checked against English for the
 *   whole key set, in both directions.
 *
 *   THE MARKUP IS TRANSLATED AND THE GAME IS NOT, or the other way round. Half
 *   this UI is data-i18n in index.html and half is built in script, and the two
 *   halves fail independently. Both are read, in a language that shares no words
 *   with English, after actually starting a city.
 *
 *   IT DOES NOT SURVIVE A RELOAD, which for a language is most of the point.
 *
 *   AND IT OVERFLOWS. German is the long one and Japanese is the tall one, and a
 *   button whose text does not fit is a button you cannot read. Measured on a
 *   phone, against the elements that actually carry translated text.
 */
import { chromium, devices } from 'playwright';
import { CHROME, GAME, stubRadio } from './harness.mjs';

const LAT0 = 44.8125, LON0 = 20.4489;
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const toLL = (x, y) => ({ lat: LAT0 - y / 110540,
                          lon: LON0 + x / (111320 * Math.cos(LAT0 * Math.PI / 180)) });
const streets = () => ({ elements: [
  { type: 'way', id: 1, tags: { highway: 'secondary', name: 'Kneza Milosa' },
    geometry: [toLL(-900, 0), toLL(900, 0)] }
] });

const browser = await chromium.launch({ executablePath: CHROME });
const out = {};

/* One page, in one system language. `languages` is overridden before any script
   runs — Playwright's own `locale` sets navigator.language but the game reads
   navigator.languages, which is the list a real browser sends and the one that
   carries the user's ORDER of preference. */
async function open(langs, opts = {}) {
  const ctx = await browser.newContext({
    ...devices[opts.device || 'iPhone 13'], locale: langs[0]
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await p.addInitScript(l => {
    Object.defineProperty(navigator, 'languages', { get: () => l });
    Object.defineProperty(navigator, 'language', { get: () => l[0] });
  }, langs);
  await p.route('**://*/**', r =>
    (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{
    lat: String(LAT0), lon: String(LON0), display_name: 'Savski venac, Beograd',
    address: { country_code: 'rs', city: 'Beograd' }
  }])));
  await p.route('**/api/interpreter', r => {
    const q = decodeURIComponent(r.request().postData() || '');
    if (/"building"/.test(q) || (/amenity/.test(q) && !/highway/.test(q)))
      return r.fulfill(json({ elements: [] }));
    return r.fulfill(json(streets()));
  });
  await stubRadio(p);
  await p.goto(GAME);
  await p.waitForTimeout(450);
  await p.evaluate(() => window.__hideGLHelp && window.__hideGLHelp(false));
  return { ctx, p, errs };
}

/* ---- 1. THE LANGUAGE OF THE SYSTEM ----

   Seven phones, each set the way a real one is set. The sub-tag cases are the
   ones that matter: none of sr-Latn-RS, pt-BR or zh-Hans-CN is a key in the
   table, and a lookup that does not cut the tag down sends all three to English
   — which is the single most likely way this feature ships broken.

   The last case is the ORDER one. A phone listing an unsupported language first
   and a supported one second must take the second, and a phone listing two
   supported languages must take the one its owner put first — read as a set,
   both of those come out wrong. */
const CASES = [
  ['en-US'], ['sr-Latn-RS', 'en'], ['ru-RU'], ['de-DE'], ['pt-BR'], ['ja-JP'],
  ['zh-Hans-CN'],
  ['nl-NL', 'de-DE'],          // Dutch is not translated: fall through to German
  ['it-IT', 'fr-FR']           // both are: the first one wins
];
const WANT = ['en', 'sr', 'ru', 'de', 'pt', 'ja', 'zh', 'de', 'it'];

out.detect = [];
for (const langs of CASES) {
  const { ctx, p } = await open(langs);
  out.detect.push(await p.evaluate(() => ({
    lang: LANG, htmlAttr: document.documentElement.getAttribute('lang'),
    drive: document.getElementById('go').textContent,
    picker: document.getElementById('lang').value
  })));
  await ctx.close();
}
out.detected = out.detect.map(d => d.lang);
out.followsTheSystem = out.detected.join(',') === WANT.join(',') &&
  // and the <html lang> and the picker agree with it, which is what a screen
  // reader and the player respectively are told
  out.detect.every((d, i) => d.htmlAttr === WANT[i] && d.picker === WANT[i]);

/* ---- 2. EVERY LANGUAGE HAS EVERY KEY ----
   A missing one renders as the key itself. Checked both ways: a key English does
   not have is a typo in a translation that will never be seen. */
{
  const { ctx, p, errs } = await open(['en-US']);
  out.tables = await p.evaluate(() => {
    const en = Object.keys(STR.en);
    const rows = {};
    for (const [code, tab] of Object.entries(STR)) {
      rows[code] = {
        missing: en.filter(k => !(k in tab)),
        extra: Object.keys(tab).filter(k => !en.includes(k)),
        empty: en.filter(k => typeof tab[k] === 'string' && !tab[k].trim())
      };
    }
    return { keys: en.length, locales: Object.keys(STR).length, rows,
             declared: LANGS.map(l => l.code),
             named: LANGS.every(l => l.name && l.name.trim()) };
  });
  const rows = Object.values(out.tables.rows);
  out.every = {
    broken: Object.entries(out.tables.rows)
      .filter(([, r]) => r.missing.length || r.extra.length || r.empty.length)
      .map(([c]) => c)
  };
  out.everyLocaleIsComplete =
    out.tables.locales === 10 && out.tables.keys > 90 &&
    out.every.broken.length === 0 &&
    // and the picker offers exactly the locales that have a table behind them
    out.tables.declared.join(',') === Object.keys(out.tables.rows).join(',') &&
    out.tables.named;

  /* ---- 3. AND NOTHING IN THE PAGE IS STILL A KEY ----
     The other half of the same failure: a data-i18n pointing at a key that was
     renamed shows the key. Nothing translated may look like `word.word`. */
  out.leaks = await p.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('[data-i18n],[data-i18n-html]')) {
      const s = (el.textContent || '').trim();
      if (/^[a-z]+\.[a-zA-Z]+$/.test(s)) bad.push(s);
    }
    return bad;
  });
  out.noKeysOnScreen = out.leaks.length === 0;
  out.enErrs = errs.slice(0, 3);
  await ctx.close();
}

/* ---- 4. THE MARKUP AND THE GAME, BOTH, IN A LANGUAGE THAT LOOKS DIFFERENT ----

   Russian shares no words with English, so "did this actually translate" is
   answerable by looking. Both halves are read: the static markup, and the
   strings the game writes into the HUD itself while running. A build where
   index.html is marked up and the toasts are not passes any check that only
   reads the menu. */
{
  const { ctx, p, errs } = await open(['ru-RU']);
  out.ruMenu = await p.evaluate(() => ({
    drive: document.getElementById('go').textContent,
    tag: document.querySelector('.tag').textContent,
    hint: document.querySelector('.hint span').innerHTML,
    ph: document.getElementById('q').getAttribute('placeholder'),
    logTitle: document.getElementById('logBtn').getAttribute('title'),
    credit: document.querySelector('.credit').innerHTML
  }));
  const cyr = s => /[А-Яа-яЁё]/.test(s);
  out.markupIsTranslated =
    cyr(out.ruMenu.drive) && cyr(out.ruMenu.tag) && cyr(out.ruMenu.hint) &&
    cyr(out.ruMenu.ph) && cyr(out.ruMenu.logTitle) && cyr(out.ruMenu.credit) &&
    // the hint keeps its markup rather than being flattened to text
    /<b>|<kbd>/.test(out.ruMenu.hint) &&
    // and the credit still carries the OpenStreetMap link the licence needs
    /<a [^>]*openstreetmap/i.test(out.ruMenu.credit);

  await p.fill('#q', 'Savski venac');
  await p.tap('#go');
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
  await p.waitForTimeout(800);
  out.ruGame = await p.evaluate(() => {
    // the objective line and the armor label are written by two different files
    const obj = document.getElementById('objT').textContent;
    const armor = document.getElementById('hpLbl').textContent;
    // a toast, produced by the game rather than by the markup
    const before = document.getElementById('toast').textContent;
    window.__addWanted(1);
    const wanted = document.getElementById('toast').textContent;
    return { obj, armor, before, wanted, radio: window.__radio().label };
  });
  out.theGameIsTranslated =
    cyr(out.ruGame.obj) && cyr(out.ruGame.armor) && cyr(out.ruGame.wanted) &&
    cyr(out.ruGame.radio);
  out.ruErrs = errs.slice(0, 3);
  await ctx.close();
}

/* ---- 5. CHANGING IT, AND IT STAYING CHANGED ----

   The setting has to beat the system language — somebody who picked Japanese on
   a German phone has said what they want — and it has to survive a reload, or it
   is not a setting. Switching also has to re-say the things the game already
   wrote into the page, which is the part that quietly does not work: a HUD label
   put there by script stays in the old language unless something asks for it
   again. */
{
  const { ctx, p, errs } = await open(['de-DE']);
  out.switch = await p.evaluate(() => {
    const before = { lang: LANG, drive: document.getElementById('go').textContent };
    document.getElementById('lang').value = 'ja';
    document.getElementById('lang').dispatchEvent(new Event('change'));
    return { before, after: { lang: LANG, drive: document.getElementById('go').textContent,
                              armor: document.getElementById('hpLbl').textContent,
                              htmlAttr: document.documentElement.getAttribute('lang') } };
  });
  out.pickerChangesIt =
    out.switch.before.lang === 'de' && /LOSFAHREN/.test(out.switch.before.drive) &&
    out.switch.after.lang === 'ja' && out.switch.after.drive === '走る' &&
    out.switch.after.armor === '装甲' && out.switch.after.htmlAttr === 'ja';

  await p.reload();
  await p.waitForTimeout(450);
  out.afterReload = await p.evaluate(() => ({
    lang: LANG, drive: document.getElementById('go').textContent,
    picker: document.getElementById('lang').value
  }));
  // still Japanese on a German phone: the choice outranks the system
  out.choiceSurvivesReload = out.afterReload.lang === 'ja' &&
                             out.afterReload.drive === '走る' &&
                             out.afterReload.picker === 'ja';

  /* And a live switch re-says what the game wrote, not just what the markup did.
     Started here so the objective line exists to be re-said. */
  await p.evaluate(() => { document.getElementById('lang').value = 'de';
                           document.getElementById('lang').dispatchEvent(new Event('change')); });
  await p.fill('#q', 'Savski venac');
  await p.tap('#go');
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
  await p.waitForTimeout(700);
  out.liveSwitch = await p.evaluate(() => {
    const de = { obj: document.getElementById('objT').textContent,
                 mode: document.getElementById('modeBtn').getAttribute('title') };
    document.getElementById('lang').value = 'ru';
    document.getElementById('lang').dispatchEvent(new Event('change'));
    const ru = { obj: document.getElementById('objT').textContent,
                 mode: document.getElementById('modeBtn').getAttribute('title'),
                 armor: document.getElementById('hpLbl').textContent };
    return { de, ru };
  });
  out.switchingMidGameResays =
    /[A-Za-z]/.test(out.liveSwitch.de.obj) &&
    /[А-Яа-я]/.test(out.liveSwitch.ru.obj) &&
    /[А-Яа-я]/.test(out.liveSwitch.ru.mode) &&
    /[А-Яа-я]/.test(out.liveSwitch.ru.armor);
  out.switchErrs = errs.slice(0, 3);
  await ctx.close();
}

/* ---- 6. AND IT ALL STILL FITS ----

   German is about a third longer than English and Japanese is taller per line,
   and this UI is full of fixed-size buttons on a 390-point phone. Measured
   rather than eyeballed: nothing that carries translated text may spill out of
   its own box or push the page sideways.

   scrollWidth on the element is the test for the button labels — a <button> does
   not wrap, so text too wide for it overflows rather than resizing it — and the
   document's own scrollWidth is the test for the page. */
out.fit = {};
for (const code of ['de', 'ru', 'ja', 'pt']) {
  const { ctx, p } = await open(['en-US']);
  await p.evaluate(c => { document.getElementById('lang').value = c;
                          document.getElementById('lang').dispatchEvent(new Event('change')); }, code);
  await p.waitForTimeout(120);
  out.fit[code] = await p.evaluate(() => {
    const ids = ['go', 'skip', 'resume', 'newLoc', 'mixDone', 'glOk', 'glNever', 'lang'];
    const over = [];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      // measured with the card visible, or a hidden element reports zero
      const card = el.closest('.screen');
      const wasHidden = card && card.classList.contains('hide');
      if (wasHidden) card.classList.remove('hide');
      if (el.scrollWidth > el.clientWidth + 1) over.push(id + ':' + el.scrollWidth + '>' + el.clientWidth);
      if (wasHidden) card.classList.add('hide');
    }
    return { over, pageW: document.documentElement.scrollWidth, vw: innerWidth,
             menuH: document.getElementById('menu').scrollHeight, vh: innerHeight };
  });
  await ctx.close();
}
out.nothingOverflows = Object.values(out.fit).every(f =>
  f.over.length === 0 && f.pageW <= f.vw);

out.errs = [].concat(out.enErrs, out.ruErrs, out.switchErrs).filter(Boolean);
out.pass = out.followsTheSystem && out.everyLocaleIsComplete && out.noKeysOnScreen &&
           out.markupIsTranslated && out.theGameIsTranslated &&
           out.pickerChangesIt && out.choiceSurvivesReload &&
           out.switchingMidGameResays && out.nothingOverflows && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
