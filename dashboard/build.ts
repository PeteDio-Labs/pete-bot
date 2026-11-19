// Builds the dashboard into dist/: the Preact bundle, the Tailwind CSS, index.html, the kit's fonts and the fixtures.
// Exits non-zero when a step fails or an output is missing, and says what it wrote.
import { cp, mkdir, rm } from 'node:fs/promises';
import { TABBAR } from './src/app.tsx';
import { buildBadge, masthead, settingsMenu, skipLink, esc } from 'toonish-ui/markup';

const out = 'dist';
const feed = process.env.DASHBOARD_FEED || '/fixtures/dashboard.json';
const switchUrl = process.env.DASHBOARD_SWITCH ?? '';
// The key manager's API, a path on this page's own origin. Unset, the Secrets screen shows no keys and no button. Staging and the
// AWS dashboard leave it unset, so neither has a path to the lab's keys.
const keysUrl = process.env.DASHBOARD_KEYS ?? '';
if (keysUrl && !/^\/[A-Za-z0-9._~\/-]*$/.test(keysUrl)) {
  console.error('build: DASHBOARD_KEYS must be a path on the same origin, such as /api/keys');
  process.exit(1);
}
// A staging build sets BUILD_ENV=staging and BUILD_SHA to the commit, and the page then names its build. A build with no BUILD_ENV, or
// with `production`, draws nothing. The badge is decided here, at build time, so the page never guesses its environment from its URL.
const buildEnv = process.env.BUILD_ENV ?? '';
const buildSha = process.env.BUILD_SHA ?? '';
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const js = await Bun.build({ entrypoints: ['src/app.tsx'], outdir: out, naming: 'app.js', minify: true, target: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
if (!js.success) {
  for (const l of js.logs) console.error(l);
  process.exit(1);
}
const css = Bun.spawnSync(['bunx', '--bun', '@tailwindcss/cli', '-i', 'src/app.css', '-o', `${out}/app.css`, '--minify'], { stdout: 'inherit', stderr: 'inherit' });
if (css.exitCode !== 0) process.exit(1);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="dashboard-feed" content="${esc(feed)}">
${switchUrl ? `<meta name="dashboard-switch" content="${esc(switchUrl)}">` : ''}
${keysUrl ? `<meta name="dashboard-keys" content="${esc(keysUrl)}">` : ''}
<title>Lab dashboard</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
${skipLink('main', 'Skip to content')}
<div class="dash-header">${masthead({ title: 'Lab dashboard', eyebrow: 'PeteDio Labs' })}${settingsMenu({ id: 'settings', cls: 'dash-settings', items: [{ label: 'Secrets', href: '#secrets' }] })}</div>
<main id="main" class="dash-main">
${TABBAR}
<div id="app"></div>
<noscript><p>This dashboard needs JavaScript to read its feed.</p></noscript>
</main>
${buildBadge({ env: buildEnv, sha: buildSha })}
<script type="module" src="/app.js"></script>
</body>
</html>
`;
await Bun.write(`${out}/index.html`, html);
await cp('fixtures', `${out}/fixtures`, { recursive: true });
const fonts = Bun.spawnSync(['sh', '-c', `[ -d node_modules/toonish-ui/dist/fonts ] && cp -r node_modules/toonish-ui/dist/fonts ${out}/fonts`]);
const need = ['index.html', 'app.js', 'app.css', 'fixtures/dashboard.json'];
const missing = need.filter((f) => !Bun.file(`${out}/${f}`).size);
if (missing.length) {
  console.error(`build: missing or empty: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`built ${need.length} outputs into ${out}/ (feed ${feed}, switch ${switchUrl || 'off'}, fonts ${fonts.exitCode === 0 ? 'copied' : 'not copied'})`);
