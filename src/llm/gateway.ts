/**
 * The model gateway: every model request goes through `ask`. It queues the call per provider,
 * refuses a Haiku call that would pass the monthly budget, runs it under a deadline, and writes
 * one tracker record whatever happened. A refusal is a record too, so the audit shows what did not run.
 */
import { randomUUID } from 'node:crypto';
import { PriorityQueue, QueueFullError } from './queue.js';
import { Tracker, callId, sha } from './tracker.js';
import type { CallResult, LlmRequest, Provider, ProviderCall, CallRecord } from './types.js';

export interface ProviderSetup {
  model: string;
  call: ProviderCall;
  concurrency: number;
  /** USD per million tokens. Ollama is 0. */
  usdPerMTokIn: number;
  usdPerMTokOut: number;
  timeoutMs: number;
}

export interface GatewayOptions {
  providers: Partial<Record<Provider, ProviderSetup>>;
  tracker: Tracker;
  /** Monthly Haiku cap in USD. A call is refused once recorded spend reaches it. */
  haikuMonthlyCapUsd: number;
  now?: () => Date;
}

export interface AskResult {
  ok: boolean;
  text: string;
  record: CallRecord;
}

export class Gateway {
  private queues = new Map<Provider, PriorityQueue>();
  constructor(private o: GatewayOptions) {
    for (const [p, s] of Object.entries(o.providers) as Array<[Provider, ProviderSetup]>) this.queues.set(p, new PriorityQueue(s.concurrency));
  }

  depth(): Record<string, number> {
    return Object.fromEntries([...this.queues].map(([p, q]) => [p, q.depth]));
  }

  async ask(req: LlmRequest): Promise<AskResult> {
    const now = this.o.now ?? (() => new Date());
    const setup = this.o.providers[req.provider];
    const enqueued = Date.now();
    const base = {
      id: callId(req.caller, req.requestId ?? randomUUID()),
      at: now().toISOString(),
      caller: req.caller,
      provider: req.provider,
      model: setup?.model ?? 'unconfigured',
      promptHash: sha(`${req.system ?? ''}\u0000${req.prompt}`),
      promptChars: req.prompt.length + (req.system?.length ?? 0),
    };
    const finish = (result: CallResult, extra: Partial<CallRecord> = {}, text = ''): AskResult => {
      const record: CallRecord = {
        ...base,
        responseHash: text ? sha(text) : '',
        responseChars: text.length,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        queueMs: 0,
        latencyMs: 0,
        result,
        ...extra,
      };
      this.o.tracker.record(record);
      return { ok: result === 'ok', text, record };
    };

    if (!setup) return finish('error', { error: `provider ${req.provider} is not configured` });
    if (req.provider === 'haiku' && this.o.tracker.monthSpend('haiku', now()) >= this.o.haikuMonthlyCapUsd) {
      return finish('budget_blocked', { error: `haiku spend reached the $${this.o.haikuMonthlyCapUsd} monthly cap` });
    }

    const q = this.queues.get(req.provider)!;
    try {
      return await q.add(req.priority ?? 5, async () => {
        const started = Date.now();
        const queueMs = started - enqueued;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), setup.timeoutMs);
        try {
          const r = await setup.call(req, ac.signal);
          const cost = (r.tokensIn * setup.usdPerMTokIn + r.tokensOut * setup.usdPerMTokOut) / 1_000_000;
          return finish('ok', { tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: cost, queueMs, latencyMs: Date.now() - started }, r.text);
        } catch (e) {
          const timedOut = ac.signal.aborted;
          return finish(timedOut ? 'timeout' : 'error', { queueMs, latencyMs: Date.now() - started, error: timedOut ? `no answer in ${setup.timeoutMs} ms` : (e as Error).message.slice(0, 200) });
        } finally {
          clearTimeout(timer);
        }
      });
    } catch (e) {
      if (e instanceof QueueFullError) return finish('queue_full', { error: e.message });
      throw e;
    }
  }
}
