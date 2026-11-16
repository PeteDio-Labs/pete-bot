// Serves dist/ for the staging host and local preview: the SPA at /, fixtures at /fixtures/, and /health.
// It reads no lab data. Staging shows synthetic fixtures only, so it needs no credential and no lab route.
import { resolve, sep } from 'node:path';
const root = resolve(`${import.meta.dir}/dist`);
const port = Number(process.env.PORT ?? 8090);
Bun.serve({
  port,
  async fetch(req) {
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url).pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    // Resolve, then require the result to stay under dist/, instead of searching for "..".
    const target = resolve(root + (path === '/' ? '/index.html' : path));
    if (path === '/health') return Response.json({ ok: true, feed: 'fixture' });
    if (!target.startsWith(root + sep)) return new Response('Bad request', { status: 400 });
    const file = Bun.file(target);
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex' };
    if (await file.exists()) return new Response(file, { headers });
    return new Response('Not found', { status: 404, headers });
  },
});
console.log(`serving dist/ on http://localhost:${port}`);
