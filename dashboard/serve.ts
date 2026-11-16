// Serves dist/ for the staging host and local preview: the SPA at /, fixtures at /fixtures/, and /health.
// It reads no lab data. Staging shows synthetic fixtures only, so it needs no credential and no lab route.
const root = `${import.meta.dir}/dist`;
const port = Number(process.env.PORT ?? 8090);
Bun.serve({
  port,
  async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (path.includes('..')) return new Response('Bad request', { status: 400 });
    if (path === '/health') return Response.json({ ok: true, feed: 'fixture' });
    const file = Bun.file(root + (path === '/' ? '/index.html' : path));
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex' };
    if (await file.exists()) return new Response(file, { headers });
    return new Response('Not found', { status: 404, headers });
  },
});
console.log(`serving dist/ on http://localhost:${port}`);
