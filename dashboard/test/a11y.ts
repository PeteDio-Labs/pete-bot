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
const TABS = ['now', 'alerts', 'cve', 'services', 'plane'];
const RUN = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const fail: string[] = [];
let runs = 0, rules = 0, measured = 0;
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
    // The switch panel in its confirm state, and a refused (disabled) switch with its reason.
    const p = await ctx.newPage();
    await p.goto(`${server.url.origin}/#services`, { waitUntil: 'load' });
    await p.waitForSelector('.dash-service');
    const enabled = p.locator('.dash-btn:not([disabled])');
    if ((await enabled.count()) !== 0) fail.push(`services @${w}: a switch is enabled on a read-only feed`);
    for (const reason of await p.locator('.dash-reason').allTextContents()) if (!reason.trim()) fail.push(`services @${w}: a service shows no reason for its switch state`);
    const sw = await p.evaluate(() => [...document.querySelectorAll('.dash-service')].filter((li) => { const b = li.querySelector('button[role="switch"]'); return !b || !b.getAttribute('aria-label') || !['true', 'false'].includes(b.getAttribute('aria-checked') ?? ''); }).length);
    if (sw) fail.push(`services @${w}: ${sw} services lack a labelled switch with a checked state`);
    const tall = await p.evaluate(() => [...document.querySelectorAll<HTMLElement>('.dash-btn')].filter((b) => b.getBoundingClientRect().height < 44).length);
    if (tall) fail.push(`services @${w}: ${tall} buttons are under 44 px tall`);
    // The confirm flow, with a feed that can request a switch: the HTML gets the switch meta and /sw answers.
    {
      const q = await ctx.newPage();
      await q.route(server.url.origin + '/', async (r) => r.fulfill({ contentType: 'text/html', body: (await Bun.file(`${root}/index.html`).text()).replace('<title>', '<meta name="dashboard-switch" content="/sw"><title>') }));
      await q.route('**/sw', (r) => r.fulfill({ json: { message: 'Request queued. Waiting for the lab-write tap.' } }));
      await q.goto(`${server.url.origin}/#services`, { waitUntil: 'load' });
      await q.waitForSelector('.dash-service');
      // The fixture's timestamps are old, so the sides read as unknown and the switch refuses. A fresh feed makes it allowed.
      const refused = await q.locator('.dash-btn:not([disabled])').count();
      if (refused !== 0) fail.push(`services @${w}: a switch is enabled against stale watchdog records`);
      await q.unroute('**/fixtures/dashboard.json');
      await q.route('**/fixtures/dashboard.json', (r) => {
        const now = new Date().toISOString();
        const fresh = JSON.parse(JSON.stringify(fixture));
        for (const sv of fresh.services) for (const k of ['lab', 'cloud']) if (sv[k]) sv[k].checkedAt = now;
        return r.fulfill({ json: fresh });
      });
      await q.reload({ waitUntil: 'load' });
      await q.waitForSelector('.dash-btn:not([disabled])');
      await q.locator('.dash-btn:not([disabled])').first().click();
      const focused = await q.evaluate(() => document.activeElement?.textContent ?? '');
      if (!focused.startsWith('Confirm')) fail.push(`services @${w}: focus is on "${focused}" after Switch, not the Confirm button`);
      await q.addScriptTag({ url: '/__axe.js' });
      const cr = await q.evaluate((run) => (window as any).axe.run(document, { runOnly: run }), RUN);
      runs++;
      for (const v of cr.violations) fail.push(`confirm state @${w}: ${v.id}: ${v.help}`);
      await q.getByRole('button', { name: /^Confirm/ }).click();
      await q.waitForFunction(() => document.querySelector('.dash-status')?.textContent?.includes('queued'));
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
      for (const el of document.querySelectorAll<HTMLElement>('main *')) {
        if (el.closest('[hidden], [aria-hidden="true"], svg')) continue;
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
console.log(`a11y: ${runs} axe runs (5 tabs x 4 feed states x 2 widths, plus the confirm state at each width), the switch confirm flow and skip link at 2 widths, ${measured} elements measured at 320 px; ${rules} rule passes, ${fail.length} failures`);
if (runs !== TABS.length * Object.keys(states).length * 2 + 2 || measured < 20) { console.error(`a11y check read too little: ${runs} runs, ${measured} elements measured`); process.exit(1); }
if (fail.length) { console.error('a11y check FAILED:\n- ' + fail.join('\n- ')); process.exit(1); }
