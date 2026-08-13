import { chromium } from 'playwright';
import { CHROME, GAME, ROOT } from './harness.mjs';
const b = await chromium.launch({ executablePath: CHROME });
for (const [w, h, label] of [[1280,800,'desktop'],[390,664,'phone-portrait'],[750,342,'phone-landscape'],[820,1180,'ipad-portrait']]) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  await p.goto(GAME);
  await p.waitForTimeout(250);
  const r = await p.evaluate(() => {
    const m = document.getElementById('menu');
    const cr = document.getElementById('menuCredit') || document.querySelector('#menu .credit');
    const perk = document.getElementById('perkM');
    const rect = e => { const q = e.getBoundingClientRect(); return { top: Math.round(q.top), bottom: Math.round(q.bottom) }; };
    return { scrollH: m.scrollHeight, clientH: m.clientHeight,
             perk: rect(perk), credit: rect(cr), vh: innerHeight,
             logoTop: Math.round(document.querySelector('#menu .logo').getBoundingClientRect().top) };
  });
  const clipped = r.scrollH > r.clientH + 1 || r.perk.bottom > r.vh || r.logoTop < 0;
  console.log(label.padEnd(16), 'content', r.scrollH, 'box', r.clientH, 'perk', JSON.stringify(r.perk),
              'credit.bottom', r.credit.bottom, 'logoTop', r.logoTop, clipped ? '<< CLIPPED' : 'ok');
  await p.close();
}
await b.close();
