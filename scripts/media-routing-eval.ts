#!/usr/bin/env bun
/**
 * Wrong-tool rate for the media assistant (Pedro, 2026-11-12). Asks a fixed set of questions
 * through POST /v1/media/ask and compares the tools the model called with the tool each
 * question needs. Run it after the tool list changes, and compare the printed rate with the
 * `tools` value it reports, which is the count the model was offered.
 *
 *   LAB_ASK_TOKEN=... bun scripts/media-routing-eval.ts [--url http://127.0.0.1:3016]
 *
 * Read-only: every question is a read. The token comes from the environment and is never
 * printed. Run it on 237, where lab-agent listens on 127.0.0.1 only.
 *
 * A case passes when the model called at least one expected tool. A call to an unexpected
 * tool is reported as `extra`, not as a failure. A question answered with no tool call is
 * a miss. The exit code is 1 when any case misses or errors, so a run that asked nothing
 * cannot look clean: the last line says how many cases ran.
 */
import { CASES } from '../src/lab/routingCases.ts';

if (import.meta.main) {
  const token = process.env.LAB_ASK_TOKEN ?? '';
  const urlArg = process.argv.indexOf('--url');
  const base = (urlArg > 0 ? process.argv[urlArg + 1] : process.env.LAB_URL) ?? 'http://127.0.0.1:3016';
  if (!token) {
    console.error('LAB_ASK_TOKEN is not set, so no question was asked.');
    process.exit(2);
  }
  let missed = 0;
  let ran = 0;
  const offered = new Set<string>();
  for (const c of CASES) {
    try {
      const res = await fetch(`${base}/v1/media/ask`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ question: c.question, history: [] }),
        signal: AbortSignal.timeout(120_000),
      });
      const body = (await res.json()) as { toolCalls?: Array<{ name: string; ok: boolean }>; error?: string };
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.error ?? 'no reason'}`);
      ran++;
      const called = (body.toolCalls ?? []).map((t) => t.name);
      const hit = called.some((n) => c.expect.includes(n));
      const extra = called.filter((n) => !c.expect.includes(n));
      if (!hit) missed++;
      console.log(`${hit ? 'ok  ' : 'MISS'} ${c.question} -> ${called.join(', ') || 'no tool'}${extra.length ? ` (extra: ${[...new Set(extra)].join(', ')})` : ''}`);
    } catch (e) {
      missed++;
      console.log(`ERR  ${c.question} -> ${(e as Error).message}`);
    }
  }
  try {
    const m = await (await fetch(`${base}/metrics`)).text();
    const t = /^lab_agent_media_tools_offered (\d+)/m.exec(m)?.[1];
    if (t) offered.add(t);
  } catch {
    // /metrics is optional here; the summary says the tool count was not read.
  }
  console.log(`eval: ${ran} of ${CASES.length} questions answered, ${missed} missed or failed, wrong-tool rate ${CASES.length ? ((100 * missed) / CASES.length).toFixed(0) : '0'}%, tools offered ${[...offered].join(',') || 'not read'}`);
  process.exit(missed ? 1 : 0);
}
