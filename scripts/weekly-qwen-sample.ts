/**
 * Runs the weekly report's Qwen summary on real merged PRs and prints a Markdown report (PET-868).
 * It writes nothing: the host session posts the output as a comment on PET-868.
 *
 *   bun scripts/weekly-qwen-sample.ts [--weeks 2026-10-19,2026-10-26,2026-11-02]
 *       [--ollama http://192.168.50.246:11434] [--runs 2] [--org PeteDio-Labs]
 *
 * Needs `gh` signed in (the Mac has it) and a route to the Ollama host. Each week is summarized
 * `--runs` times, because the question is whether the answer is stable as well as correct.
 * The report lists the PR titles behind it, so a reader can judge the summary against them.
 *
 * ⚠ A SAMPLE SAYS WHAT IT READ. The report header gives how many PRs each week fed the model.
 * A week with no PR prints "no PRs read" and no summary; GitHub failing exits non-zero.
 */
import { weekStart } from '../src/reports/merged.js';
import { lintSummary, ollamaSummarizer, summaryPrompt, WEEKLY_MODEL, type WeekPr } from '../src/reports/weekly.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const weeks = arg('weeks', '2026-10-19,2026-10-26,2026-11-02').split(',');
const ollama = arg('ollama', 'http://192.168.50.246:11434');
const runs = Number(arg('runs', '2'));
const org = arg('org', 'PeteDio-Labs');
const DAY = 86_400_000;

async function gh(path: string): Promise<unknown> {
  const p = Bun.spawn(['gh', 'api', '-X', 'GET', path], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`gh api failed (${code}): ${err.slice(0, 200)}`);
  return JSON.parse(out);
}

interface Item { number: number; title: string; html_url: string; user: { login: string } | null; pull_request?: { merged_at?: string | null }; repository_url: string }

async function mergedIn(week: string): Promise<WeekPr[]> {
  const from = new Date(Date.parse(`${week}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
  const to = new Date(Date.parse(`${week}T00:00:00Z`) + 8 * DAY).toISOString().slice(0, 10);
  const out: WeekPr[] = [];
  for (let page = 1; page <= 10; page++) {
    const q = encodeURIComponent(`org:${org} is:pr is:merged merged:${from}..${to}`);
    const body = (await gh(`search/issues?q=${q}&per_page=100&page=${page}`)) as { items: Item[] };
    for (const it of body.items) {
      const mergedAt = it.pull_request?.merged_at;
      if (!mergedAt || weekStart(new Date(mergedAt)) !== week) continue;
      out.push({ repo: it.repository_url.split('/').pop()!, number: it.number, title: it.title, url: it.html_url, author: it.user?.login ?? 'unknown', mergedAt, petKeys: [] });
    }
    if (body.items.length < 100) break;
  }
  return out;
}

const summarize = ollamaSummarizer(ollama);
const lines: string[] = [`# Weekly summary sample (${WEEKLY_MODEL} at ${ollama})`, '', `Runs per week: ${runs}. Generated ${new Date().toISOString()}.`, ''];
let failures = 0;
for (const week of weeks) {
  const prs = await mergedIn(week);
  lines.push(`## Week of ${week}: ${prs.length} PRs read`, '');
  if (prs.length === 0) {
    lines.push('no PRs read, so no summary was asked for.', '');
    continue;
  }
  for (let r = 1; r <= runs; r++) {
    const t0 = Date.now();
    try {
      const text = await summarize(prs, week);
      const problems = lintSummary(text, prs);
      lines.push(`**Run ${r}** (${((Date.now() - t0) / 1000).toFixed(1)} s): ${text}`, '', problems.length ? `Flags: ${problems.join('; ')}` : 'Flags: none', '');
    } catch (err) {
      failures++;
      lines.push(`**Run ${r}** failed after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${(err as Error).message}`, '');
    }
  }
  lines.push('<details><summary>What the model saw</summary>', '', summaryPrompt(prs, week).user, '', '</details>', '');
}
console.log(lines.join('\n'));
if (failures > 0) process.exit(1);
