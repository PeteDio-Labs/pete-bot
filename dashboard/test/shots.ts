// Screenshots of the built dashboard for review: every tab at 390 and 1280 px, with the fixture as shipped (stale) and
// with its times moved to the present (fresh). Usage: bun run test/shots.ts <out-dir> <prefix>. Run `bun run build` first.
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const [outDir = 'shots', prefix = 'after'] = process.argv.slice(2);
const root = `${import.meta.dir}/../dist`;
const raw = await Bun.file(`${root}/fixtures/dashboard.json`).text();
const base = Date.parse(JSON.parse(raw).generatedAt);
/** Moves every ISO time by the same amount, so the feed reads as written a minute ago. */
const fresh = raw.replace(/"(\d{4}-\d\d-\d\dT[\d:.]+Z)"/g, (_, t: string) => `"${new Date(Date.parse(t) + (Date.now() - 60_000 - base)).toISOString()}"`);
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    const f = Bun.file(root + (pathname === '/' ? '/index.html' : pathname));
    return (await f.exists()) ? new Response(f) : new Response('nf', { status: 404 });
  },
});
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let n = 0;
try {
  for (const [name, w, h, scale] of [['phone', 390, 844, 2], ['desktop', 1280, 800, 1]] as const) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: scale, reducedMotion: 'reduce' });
    for (const state of ['fresh', 'stale'] as const) {
      for (const tab of ['now', 'act', 'services', 'health', 'work']) {
        if (state === 'stale' && tab !== 'now' && tab !== 'services') continue;
        const p = await ctx.newPage();
        if (state === 'fresh') await p.route('**/fixtures/dashboard.json', (r) => r.fulfill({ contentType: 'application/json', body: fresh }));
        await p.goto(`${server.url.origin}/#${tab}`, { waitUntil: 'networkidle' });
        await p.waitForFunction(() => !document.body.textContent?.includes('Reading the feed.'));
        await p.screenshot({ path: `${outDir}/${prefix}-${tab}-${state}-${name}.png`, fullPage: true });
        n++;
        await p.close();
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  server.stop(true);
}
console.log(`shots: wrote ${n} screenshots to ${outDir}/ (prefix ${prefix})`);
