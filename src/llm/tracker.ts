/**
 * The call tracker. Every model call writes one record here, whatever its result.
 *
 * Records go three places: a ring buffer (the dashboard route), a JSON line on stdout (promtail
 * ships it to Loki), and an optional direct Loki push. The record id is a hash of the caller and
 * request id, so a replay carries the same id and a reader can drop the duplicate. The tracker
 * stores hashes and lengths, never prompt or response text.
 */
import { createHash } from 'node:crypto';
import type { CallRecord } from './types.js';

export const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

export function callId(caller: string, requestId: string): string {
  return sha(`${caller}\u0000${requestId}`);
}

export interface TrackerOptions {
  ringSize?: number;
  /** Receives each record's JSON line. Defaults to stdout. */
  line?: (s: string) => void;
  lokiUrl?: string;
  fetchImpl?: typeof fetch;
}

export class Tracker {
  private ring: CallRecord[] = [];
  private seen = new Set<string>();
  private lokiFailures = 0;
  constructor(private opts: TrackerOptions = {}) {}

  record(r: CallRecord): boolean {
    if (this.seen.has(r.id) && r.result === 'ok') {
      const prior = this.ring.find((x) => x.id === r.id);
      if (prior?.result === 'ok') return false;
    }
    this.seen.add(r.id);
    this.ring.push(r);
    const max = this.opts.ringSize ?? 2000;
    if (this.ring.length > max) this.ring.splice(0, this.ring.length - max);
    const line = JSON.stringify({ event: 'llm_call', ...r });
    (this.opts.line ?? ((s) => process.stdout.write(`${s}\n`)))(line);
    void this.push(line, r.at);
    return true;
  }

  private async push(line: string, at: string): Promise<void> {
    if (!this.opts.lokiUrl) return;
    const ns = String(BigInt(Date.parse(at)) * 1_000_000n);
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(this.opts.lokiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streams: [{ stream: { job: 'llm-gateway', event: 'llm_call' }, values: [[ns, line]] }] }),
      });
      if (!res.ok) this.lokiFailures++;
    } catch {
      this.lokiFailures++;
    }
  }

  calls(limit = 100): CallRecord[] {
    return this.ring.slice(-limit).reverse();
  }

  /** What the dashboard reads. `examined` says how many records the numbers cover. */
  usage(now = new Date()) {
    const month = now.toISOString().slice(0, 7);
    const by: Record<string, { calls: number; costUsd: number; tokensIn: number; tokensOut: number; errors: number }> = {};
    let examined = 0;
    for (const r of this.ring) {
      if (!r.at.startsWith(month)) continue;
      examined++;
      const k = `${r.provider}:${r.model}`;
      const b = (by[k] ??= { calls: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, errors: 0 });
      b.calls++;
      b.costUsd += r.costUsd;
      b.tokensIn += r.tokensIn;
      b.tokensOut += r.tokensOut;
      if (r.result !== 'ok') b.errors++;
    }
    return { month, examined, ringSize: this.ring.length, lokiFailures: this.lokiFailures, by };
  }

  /** Spend for a provider this month, from the records held. */
  monthSpend(provider: string, now = new Date()): number {
    const month = now.toISOString().slice(0, 7);
    return this.ring.filter((r) => r.provider === provider && r.at.startsWith(month)).reduce((a, r) => a + r.costUsd, 0);
  }
}
