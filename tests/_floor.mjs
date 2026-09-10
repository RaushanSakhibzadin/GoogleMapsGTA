import { chromium } from 'playwright';
import { GAME, CHROME, stubRadio } from './harness.mjs';
const b = await chromium.launch({ executablePath: CHROME });
for (const w of [280, 320, 360, 390, 430]) {
  const p = await b.newPage({ viewport: { width: w, height: 700 }, deviceScaleFactor: 1 });
  await stubRadio(p); await p.goto(GAME);
  await p.waitForFunction(() => document.getElementById('skip'), null, { timeout: 30000 }).catch(()=>{});
  await p.evaluate(() => { const s = document.getElementById('skip'); if (s) s.click(); });
  await p.waitForFunction(() => window.state === 'play', null, { timeout: 60000 }).catch(()=>{});
  const r = await p.evaluate(() => {
    document.body.classList.remove('ctrl-stick'); document.body.classList.add('ctrl-pads');
    document.getElementById('touch').style.display = 'block';
    for (const e of document.querySelectorAll('.sprayCan')) e.classList.add('on');
    const m = id => { const q = document.getElementById(id).getBoundingClientRect();
      return { w: +q.width.toFixed(1), inset: id === 'sprayBtn' ? +q.left.toFixed(1) : +(innerWidth - q.right).toFixed(1), fb: +(innerHeight - q.bottom).toFixed(1) }; };
    return { can: m('sprayBtn'), drift: m('tH') };
  });
  const pair = Math.abs(r.can.w - r.drift.w) < .6 && Math.abs(r.can.inset - r.drift.inset) < .6 && Math.abs(r.can.fb - r.drift.fb) < .6;
  console.log(`vw=${String(w).padStart(4)}  size=${String(r.can.w).padStart(5)}  >=44:${r.can.w >= 44 ? 'yes' : 'NO '}  mirrored:${pair ? 'yes' : 'NO '}`);
  await p.close();
}
await b.close();
