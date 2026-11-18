// Accessibility check of the built dashboard: axe at WCAG 2.2 AA on every tab at 390 and 1280 px, in four feed states
// (fixture, a failed feed, an empty feed, a feed with unreadable rows), plus the switch confirm state, the skip link,
// one h1 and one main, and no sideways scroll at 320 px. It fails on any violation and prints what it examined.
// Run `bun run build` first. Set CHROMIUM_PATH to use a browser Playwright did not install.
import { chromium, type Page } from 'playwright-core';

const root = `${import.meta.dir}/../dist`;
const fixture = await Bun.file(`${root}/fixtures/dashboard.json`).json();
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === '/__axe.js') return new Response(Bun.file(`${import.meta.dir}/../node_modules/axe-core/axe.min.js`), { headers: { 'content-type': 'text/javascript' } });
    const f = Bun.file(root + (pathname === '/' ? '/index.html' : pathname));
    return (await f.exists()) ? new Response(f) : new Response('nf', { status: 404 });
  },
});

const states: Record<string, (p: Page) => Promise<void>> = {
  fixture: async () => {},
  'feed failed': async (p) => void (await p.route('**/fixtures/dashboard.json', (r) => r.fulfill({ status: 502, body: 'bad' }))),
  'feed empty': async (p) => void (await p.route('**/fixtures/dashboard.json', (r) => r.fulfill({ json: { generatedAt: '2026-11-16T22:00:00Z', source: 'test', needs: [], alerts: [], services: [], triage: null, cve: null, plane: null } }))),
  'rows unreadable': async (p) => void (await p.route('**/fixtures/dashboard.json', (r) => r.fulfill({ json: { ...fixture, services: [{ name: 'x' }, ...fixture.services], alerts: [{ monitor: 'm', state: 'x' }] } }))),
};
const TABS = ['now', 'act', 'services', 'health', 'work'];
const RUN = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const fail: string[] = [];
let runs = 0, rules = 0, measured = 0, polls = 0;
const state_demo = (text: string | null): boolean => !text?.includes('Demo data');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  for (const [w, h] of [[390, 844], [1280, 800]] as const) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce' });
    for (const [state, setup] of Object.entries(states)) {
      for (const tab of TABS) {
        const p = await ctx.newPage();
        await setup(p);
        await p.goto(`${server.url.origin}/#${tab}`, { waitUntil: 'load' });
        await p.waitForFunction(() => !document.body.textContent?.includes('Reading the feed.'));
        await p.addScriptTag({ url: '/__axe.js' });
        const r = await p.evaluate((run) => (window as any).axe.run(document, { runOnly: run }), RUN);
        runs++; rules += r.passes.length;
        for (const v of r.violations) fail.push(`${state}/${tab} @${w}: ${v.id} (${v.nodes.length}): ${v.help}; first ${v.nodes[0].target.join(' ')}`.slice(0, 300));
        const shown = await p.evaluate(() => [...document.querySelectorAll<HTMLElement>('[role=tabpanel]')].filter((e) => !e.hidden).map((e) => e.id));
        if (shown.length !== 1 || shown[0] !== tab) fail.push(`${state}/${tab} @${w}: visible panels are [${shown}]`);
        if (state === 'feed failed' && !(await p.locator('[role=alert]').count())) fail.push(`${state}/${tab} @${w}: a failed feed shows no alert`);
        if (state === 'fixture' && tab === 'now' && !(await p.textContent('main'))!.includes('Read ')) fail.push(`fixture/now @${w}: the view does not say what it read`);
        await p.close();
      }
    }
    // The switch panel: one pressed side per service, a reason under every card, and no way to ask on a read-only feed.
    const p = await ctx.newPage();
    await p.goto(`${server.url.origin}/#services`, { waitUntil: 'load' });
    await p.waitForSelector('.toon-switch-card');
    const OPEN = '[data-toon-switch-to][aria-pressed="false"]:not([aria-disabled="true"])';
    if ((await p.locator(OPEN).count()) !== 0) fail.push(`services @${w}: a switch is enabled on a read-only feed`);
    for (const reason of await p.locator('.toon-switch-card-reason').allTextContents()) if (!reason.trim()) fail.push(`services @${w}: a service shows no reason for its switch state`);
    const cards = await p.evaluate(() => { const cs = [...document.querySelectorAll('.toon-switch-card')]; return { n: cs.length, bad: cs.filter((c) => c.querySelectorAll('button[aria-pressed="true"]').length !== 1 || c.querySelectorAll('button[aria-pressed]').length !== 2 || !c.querySelector('.toon-switch-card-reason')).length, short: [...document.querySelectorAll<HTMLElement>('.toon-switch-card-side')].filter((b) => b.getBoundingClientRect().height < 44).length }; });
    if (cards.n !== fixture.services.length) fail.push(`services @${w}: ${cards.n} cards for ${fixture.services.length} services`);
    if (cards.bad) fail.push(`services @${w}: ${cards.bad} cards lack two sides, one pressed side or a reason`);
    if (cards.short) fail.push(`services @${w}: ${cards.short} side buttons are under 44 px tall`);
    if (state_demo(await p.textContent('main'))) fail.push(`services @${w}: the fixture feed shows no demo banner`);
    // The confirm flow, with a feed that can request a switch: the HTML gets the switch meta and /sw answers.
    {
      const q = await ctx.newPage();
      await q.route(server.url.origin + '/', async (r) => r.fulfill({ contentType: 'text/html', body: (await Bun.file(`${root}/index.html`).text()).replace('<title>', '<meta name="dashboard-switch" content="/sw"><title>') }));
      await q.route('**/sw', (r) => r.fulfill({ json: { message: 'Request queued. Waiting for the lab-write tap.' } }));
      // A live feed with old watchdog records: every side reads as unknown, so no switch may be asked for.
      await q.route('**/fixtures/dashboard.json', (r) => r.fulfill({ json: { ...fixture, source: 'pete-bot' } }));
      await q.goto(`${server.url.origin}/#services`, { waitUntil: 'load' });
      await q.waitForSelector('.toon-switch-card');
      if ((await q.locator(OPEN).count()) !== 0) fail.push(`services @${w}: a switch is enabled against stale watchdog records`);
      if ((await q.textContent('main'))!.includes('Demo data')) fail.push(`services @${w}: a live feed shows the demo banner`);
      await q.unroute('**/fixtures/dashboard.json');
      await q.route('**/fixtures/dashboard.json', (r) => {
        const now = new Date().toISOString();
        const fresh = JSON.parse(JSON.stringify(fixture));
        fresh.source = 'pete-bot';
        fresh.generatedAt = now;
        for (const sv of fresh.services) for (const k of ['lab', 'cloud']) if (sv[k]) sv[k].checkedAt = now;
        return r.fulfill({ json: fresh });
      });
      await q.reload({ waitUntil: 'load' });
      await q.waitForSelector(OPEN);
      await q.locator(OPEN).first().click();
      const focused = await q.evaluate(() => document.activeElement?.textContent ?? '');
      if (!focused.startsWith('Confirm')) fail.push(`services @${w}: focus is on "${focused}" after a tap on the idle side, not the Confirm button`);
      await q.addScriptTag({ url: '/__axe.js' });
      const cr = await q.evaluate((run) => (window as any).axe.run(document, { runOnly: run }), RUN);
      runs++;
      for (const v of cr.violations) fail.push(`confirm state @${w}: ${v.id}: ${v.help}`);
      // Cancel returns focus to the side that opened the step, and a second tap confirms.
      await q.getByRole('button', { name: 'Cancel' }).click();
      const back = await q.evaluate(() => document.activeElement?.getAttribute('data-toon-switch-to') ?? '');
      if (!back) fail.push(`services @${w}: Cancel did not return focus to the side button`);
      await q.locator(OPEN).first().click();
      await q.getByRole('button', { name: /^Confirm/ }).click();
      await q.waitForFunction(() => document.querySelector('.dash-status')?.textContent?.includes('queued'));
      // A pressed side asks for nothing.
      await q.locator('.toon-switch-card-side[aria-pressed="true"]').first().click();
      if (await q.getByRole('button', { name: /^Confirm/ }).count()) fail.push(`services @${w}: a tap on the serving side opened the confirm step`);
      await q.close();
    }
    // A poll must not close a row the reader opened, or move their focus.
    {
      const q = await ctx.newPage();
      let n = 0;
      await q.route('**/fixtures/dashboard.json', (r) => r.fulfill({ json: { ...fixture, source: 'pete-bot', generatedAt: new Date(Date.now() - n++ * 7000).toISOString() } }));
      await q.goto(`${server.url.origin}/#act`, { waitUntil: 'load' });
      await q.waitForSelector('#act details');
      const last = q.locator('#act details.toon-disclosure-details summary').last();
      await last.click();
      const before = await q.evaluate(() => ({ open: [...document.querySelectorAll<HTMLDetailsElement>('#act details.toon-disclosure-details')].map((d) => d.open).join(), id: document.activeElement?.id }));
      const html = await q.locator('#act').innerHTML();
      await q.evaluate(() => (window as any).__dashPoll?.());
      await q.waitForFunction((h) => document.getElementById('act')!.innerHTML !== h, html);
      const after = await q.evaluate(() => ({ open: [...document.querySelectorAll<HTMLDetailsElement>('#act details.toon-disclosure-details')].map((d) => d.open).join(), id: document.activeElement?.id }));
      if (before.open !== after.open || before.id !== after.id || !after.id) fail.push(`act @${w}: a poll changed the open rows or the focus (${JSON.stringify(before)} to ${JSON.stringify(after)})`);
      polls++;
      await q.close();
    }
    // The skip link is the first stop on a fresh load with no hash; a hash makes the kit move focus to its tab.
    await p.goto(server.url.origin + '/', { waitUntil: 'load' });
    await p.keyboard.press('Tab');
    const first = await p.evaluate(() => document.activeElement?.className);
    if (!String(first).includes('toon-skip')) fail.push(`@${w}: the first tab stop is "${first}", not the skip link`);
    const s = await p.evaluate(() => ({ h1: document.querySelectorAll('h1').length, main: document.querySelectorAll('main').length, lang: document.documentElement.lang }));
    if (s.h1 !== 1 || s.main !== 1 || !s.lang) fail.push(`@${w}: ${s.h1} h1, ${s.main} main, lang "${s.lang}"`);
    await p.close();
    await ctx.close();
  }
  const ctx = await browser.newContext({ viewport: { width: 320, height: 640 }, reducedMotion: 'reduce' });
  for (const tab of TABS) {
    const p = await ctx.newPage();
    await p.goto(`${server.url.origin}/#${tab}`, { waitUntil: 'load' });
    await p.waitForFunction(() => !document.body.textContent?.includes('Reading the feed.'));
    const sw = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (sw > 0) fail.push(`${tab} @320: scrolls sideways by ${sw}px`);
    const cut = await p.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      let n = 0;
      const out: string[] = [];
      // A data table is the one thing WCAG 1.4.10 lets scroll in two dimensions. The kit puts it
      // in .toon-table-wrap, so the cells are exempt here and the wrap is checked instead: it has
      // to fit the page, and a keyboard has to reach it under a name.
      for (const w of document.querySelectorAll<HTMLElement>('main .toon-table-wrap')) {
        if (w.closest('[hidden]')) continue;
        const r = w.getBoundingClientRect();
        if (!r.width) continue;
        n++;
        if (r.right > vw + 2 || r.left < -2) out.push(`table wrap ${Math.round(r.left)} to ${Math.round(r.right)} of ${vw}`);
        if (w.scrollWidth > w.clientWidth && !(w.tabIndex === 0 && w.getAttribute('role') === 'region' && (w.getAttribute('aria-label') || w.getAttribute('aria-labelledby'))))
          out.push('table wrap scrolls with no keyboard reach or no name');
      }
      for (const el of document.querySelectorAll<HTMLElement>('main *')) {
        if (el.closest('[hidden], [aria-hidden="true"], svg, .toon-table-wrap')) continue;
        if (![...el.childNodes].some((t) => t.nodeType === 3 && t.textContent!.trim())) continue;
        const r = el.getBoundingClientRect();
        if (!r.width) continue;
        n++;
        if (r.right > vw + 2 || r.left < -2) out.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(r.left)} to ${Math.round(r.right)} of ${vw}`);
      }
      return { n, out };
    });
    measured += cut.n;
    for (const c of cut.out.slice(0, 3)) fail.push(`${tab} @320: cut off: ${c}`);
    await p.close();
  }
  await ctx.close();
} finally {
  await browser.close();
  server.stop(true);
}
console.log(`a11y: ${runs} axe runs (5 tabs x 4 feed states x 2 widths, plus the confirm state at each width), the switch confirm flow, ${polls} poll checks and the skip link at 2 widths, ${measured} elements measured at 320 px; ${rules} rule passes, ${fail.length} failures`);
if (runs !== TABS.length * Object.keys(states).length * 2 + 2 || measured < 20 || polls !== 2) { console.error(`a11y check read too little: ${runs} runs, ${measured} elements measured`); process.exit(1); }
if (fail.length) { console.error('a11y check FAILED:\n- ' + fail.join('\n- ')); process.exit(1); }
