#!/usr/bin/env bun
/**
 * media-probe (PET-869): a read-only check of the media assistant's reads against the live
 * hosts. A Mac session runs it (MED-4), posts the output, and the project thread fixes
 * what it finds. It writes nothing, restarts nothing and places no credential.
 *
 *   MTRACE_TOKEN=... bun scripts/media-probe.ts
 *   MTRACE_TOKEN_FILE=~/.config/mtrace/token bun scripts/media-probe.ts --ask "why is Survivor stuck"
 *
 * Checks, in order. Each prints what it examined, and the exit code is 1 when any failed:
 *   1. mtrace /health.
 *   2. The tool list on mtrace (GET /api/tools) against MTRACE_SPECS: a missing, extra or
 *      re-shaped tool is drift, and the probe says which.
 *   3. All eleven tools through the code the assistant uses (src/lab/tools/mtrace.ts), with
 *      timings. An `ok=false` finding is printed as a finding, not a failure.
 *   4. With BAZARR_API_KEY set (read the key in Bazarr's config.yaml on 222, never print it):
 *      bazarr_status, bazarr_find for PROBE_TITLE, and propose_action for it. These only read
 *      and resolve. The probe never runs the subtitle search, which only a Confirm tap runs.
 *   5. With --ask, the whole loop: the question goes to Ollama (OLLAMA_URL, default
 *      http://192.168.50.246:11434) with the eleven tools, and the probe prints which tools the
 *      model chose and its answer. The first call after the model unloads takes about 22 s.
 *
 * The token comes from MTRACE_TOKEN or the 0600 file MTRACE_TOKEN_FILE. It is never printed.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { ask, MEDIA_SYSTEM_PROMPT } from '../src/lab/agent.js';
import { ollamaCaller } from '../src/lab/ollama.js';
import { callTool, inputJsonSchema } from '../src/lab/tools/index.js';
import { MTRACE_SPECS, mtraceTools } from '../src/lab/tools/mtrace.js';
import { bazarrFindTool, bazarrStatusTool } from '../src/lab/tools/bazarr.js';
import { proposeActionTool } from '../src/lab/tools/propose.js';

const BASE = (process.env.MTRACE_URL ?? 'http://192.168.50.237:8237').replace(/\/$/, '');
const OLLAMA = process.env.OLLAMA_URL ?? 'http://192.168.50.246:11434';
const MODEL = process.env.LAB_MODEL ?? 'qwen3:8b';
const TITLE = process.env.PROBE_TITLE ?? 'Survivor';

let failures = 0;
const line = (ok: boolean | 'finding', what: string) => {
  if (ok === false) failures++;
  console.log(`${ok === true ? 'PASS' : ok === 'finding' ? 'FIND' : 'FAIL'}  ${what}`);
};

function token(): string {
  if (process.env.MTRACE_TOKEN) return process.env.MTRACE_TOKEN;
  const path = (process.env.MTRACE_TOKEN_FILE ?? '~/.config/mtrace/token').replace(/^~/, homedir());
  const mode = statSync(path).mode & 0o077;
  if (mode) throw new Error(`${path} grants group or other access; run chmod 600`);
  return readFileSync(path, 'utf8').split('\n')[0]!.trim();
}

const questions: string[] = [];
for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === '--ask' && process.argv[i + 1]) questions.push(process.argv[++i]!);

let tok: string;
try {
  tok = token();
} catch (err) {
  console.error(`media-probe: no token (${(err as Error).message}). Set MTRACE_TOKEN or MTRACE_TOKEN_FILE.`);
  process.exit(2);
}

// 1
try {
  const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) });
  line(res.ok, `1 mtrace /health: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
} catch (err) {
  line(false, `1 mtrace /health: unreachable (${(err as Error).message}). A refusal means this host is not on the allowlist.`);
}

// 2
try {
  const res = await fetch(`${BASE}/api/tools`, { headers: { authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  const list = (Array.isArray(body) ? body : (body as { tools?: unknown[] }).tools ?? []) as Array<{ name: string; parameters?: { properties?: Record<string, unknown>; required?: string[] } }>;
  const live = new Map(list.map((t) => [t.name, t]));
  const ours = new Map(MTRACE_SPECS.map((s) => [s.name, s]));
  const drift: string[] = [];
  for (const name of ours.keys()) if (!live.has(name)) drift.push(`missing on mtrace: ${name}`);
  for (const name of live.keys()) if (!ours.has(name)) drift.push(`not in MTRACE_SPECS: ${name}`);
  for (const [name, spec] of ours) {
    const t = live.get(name);
    if (!t) continue;
    const mine = inputJsonSchema(spec.input) as { properties?: Record<string, unknown>; required?: string[] };
    const keysLive = Object.keys(t.parameters?.properties ?? {}).sort().join(',');
    const keysMine = Object.keys(mine.properties ?? {}).sort().join(',');
    const reqLive = [...(t.parameters?.required ?? [])].sort().join(',');
    const reqMine = [...(mine.required ?? [])].sort().join(',');
    if (keysLive !== keysMine) drift.push(`${name}: arguments differ (mtrace: ${keysLive || 'none'}; ours: ${keysMine || 'none'})`);
    else if (reqLive !== reqMine) drift.push(`${name}: required differs (mtrace: ${reqLive || 'none'}; ours: ${reqMine || 'none'})`);
  }
  line(drift.length === 0, `2 tool list: ${live.size} on mtrace, ${ours.size} in MTRACE_SPECS${drift.length ? `\n      ${drift.join('\n      ')}` : ', names and arguments match'}`);
} catch (err) {
  line(false, `2 tool list: ${(err as Error).message}`);
}

/** The first readable line of a tool result: a string field of the data, else the raw start. */
function gist(text: string): string {
  try {
    const data = (JSON.parse(text.replace(/\n… truncated:.*$/s, '')) as { data?: Record<string, unknown> }).data ?? {};
    const hit = ['text', 'answer', 'summary', 'verdict', 'error'].map((k) => data[k]).find((v) => typeof v === 'string') as string | undefined;
    if (hit) return hit.split('\n')[0]!.slice(0, 160);
  } catch {
    // fall through to the raw start
  }
  return text.replace(/\s+/g, ' ').slice(0, 160);
}

// 3
const tools = mtraceTools({ baseUrl: BASE, token: tok, timeoutMs: 60_000 });
let ran = 0;
for (const tool of tools) {
  const args = tool.name === 'trace_request' ? { title: TITLE } : {};
  const started = Date.now();
  const res = await callTool(tool, args, 4096);
  const ms = Date.now() - started;
  ran++;
  if (!res.ok) line(false, `3 ${tool.name} (${ms} ms): ${res.error}`);
  else line(res.text.includes('ok=false') ? 'finding' : true, `3 ${tool.name} (${ms} ms): ${gist(res.text)}`);
}
console.log(`      examined ${ran} of ${tools.length} tools; trace_request used title "${TITLE}"`);

// 4
if (process.env.BAZARR_API_KEY) {
  const bz = { baseUrl: process.env.BAZARR_URL ?? 'http://192.168.50.222:6767', apiKey: process.env.BAZARR_API_KEY, timeoutMs: 30_000 };
  const checks: Array<[string, ReturnType<typeof bazarrFindTool>, Record<string, unknown>]> = [
    ['bazarr_status', bazarrStatusTool(bz), {}],
    ['bazarr_find', bazarrFindTool(bz), { title: TITLE }],
    ['propose_action (resolve only)', proposeActionTool(bz), { action: 'subtitles', title: TITLE }],
  ];
  for (const [label, tool, args] of checks) {
    const started = Date.now();
    const res = await callTool(tool, args, 4096);
    line(res.ok, `4 ${label} (${Date.now() - started} ms): ${res.ok ? res.text.replace(/\s+/g, ' ').slice(0, 200) : res.error}`);
  }
} else {
  console.log('      step 4 skipped: set BAZARR_API_KEY to check the Bazarr reads');
}

// 5
const map = new Map(tools.map((t) => [t.name, t] as const));
const call = ollamaCaller(OLLAMA, 8192);
for (const q of questions) {
  const started = Date.now();
  try {
    const r = await ask(q, map, call, MODEL, AbortSignal.timeout(80_000), { system: MEDIA_SYSTEM_PROMPT });
    const names = r.toolCalls.map((t) => `${t.name}${t.ok ? '' : ' (failed)'}`).join(', ') || 'none';
    line(!r.incomplete && r.toolCalls.every((t) => t.ok), `5 "${q}" (${Date.now() - started} ms, ${r.turns} turns, tools: ${names})\n      ${r.answer.replace(/\n/g, '\n      ')}`);
  } catch (err) {
    line(false, `5 "${q}": ${(err as Error).message}`);
  }
}
if (questions.length === 0) console.log('      step 5 skipped: pass --ask "<question>" to run the model loop');

console.log(failures === 0 ? '\nmedia-probe: no failures' : `\nmedia-probe: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
