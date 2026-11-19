import { describe, expect, test } from 'bun:test';
import { Gateway, Tracker, type ProviderSetup } from './index.js';

const setup = (call: ProviderSetup['call'], over: Partial<ProviderSetup> = {}): ProviderSetup => ({
  model: 'm', call, concurrency: 1, usdPerMTokIn: 1, usdPerMTokOut: 5, timeoutMs: 1000, ...over,
});
const mk = (providers: ConstructorParameters<typeof Gateway>[0]['providers'], cap = 100) => {
  const lines: string[] = [];
  const tracker = new Tracker({ line: (s) => lines.push(s) });
  return { g: new Gateway({ providers, tracker, haikuMonthlyCapUsd: cap }), tracker, lines };
};

describe('gateway', () => {
  test('records an ok call with hashes, tokens and cost, and no text', async () => {
    const { g, lines } = mk({ haiku: setup(async () => ({ text: 'answer', tokensIn: 1_000_000, tokensOut: 100_000 })) });
    const r = await g.ask({ caller: 't', provider: 'haiku', prompt: 'secret prompt' });
    expect(r.ok).toBe(true);
    expect(r.record.costUsd).toBeCloseTo(1.5);
    expect(lines[0]).not.toContain('secret prompt');
    expect(lines[0]).not.toContain('"answer"');
    expect(r.record.promptHash).toHaveLength(16);
  });

  test('refuses haiku past the monthly cap and records the refusal', async () => {
    const { g, tracker } = mk({ haiku: setup(async () => ({ text: 'x', tokensIn: 1_000_000, tokensOut: 0 })) }, 1);
    expect((await g.ask({ caller: 't', provider: 'haiku', prompt: 'a' })).ok).toBe(true);
    const blocked = await g.ask({ caller: 't', provider: 'haiku', prompt: 'b' });
    expect(blocked.record.result).toBe('budget_blocked');
    expect(tracker.calls().map((c) => c.result)).toEqual(['budget_blocked', 'ok']);
  });

  test('same request id gives the same record id, and a replay is not counted twice', async () => {
    const { g, tracker } = mk({ ollama: setup(async () => ({ text: 'x', tokensIn: 1, tokensOut: 1 })) });
    await g.ask({ caller: 't', provider: 'ollama', prompt: 'p', requestId: 'r1' });
    await g.ask({ caller: 't', provider: 'ollama', prompt: 'p', requestId: 'r1' });
    expect(tracker.calls()).toHaveLength(1);
  });

  test('timeout and error become records, not throws', async () => {
    const { g } = mk({
      ollama: setup((_r, signal) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))), { timeoutMs: 20 }),
      haiku: setup(async () => { throw new Error('boom'); }),
    });
    expect((await g.ask({ caller: 't', provider: 'ollama', prompt: 'p' })).record.result).toBe('timeout');
    expect((await g.ask({ caller: 't', provider: 'haiku', prompt: 'p' })).record.result).toBe('error');
  });

  test('queue runs lower priority number first and caps concurrency', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { g } = mk({ ollama: setup(async (req) => { order.push(req.prompt); if (req.prompt === 'first') await gate; return { text: 'x', tokensIn: 0, tokensOut: 0 }; }) });
    const a = g.ask({ caller: 't', provider: 'ollama', prompt: 'first' });
    const b = g.ask({ caller: 't', provider: 'ollama', prompt: 'low', priority: 9 });
    const c = g.ask({ caller: 't', provider: 'ollama', prompt: 'urgent', priority: 0 });
    release();
    await Promise.all([a, b, c]);
    expect(order).toEqual(['first', 'urgent', 'low']);
  });

  test('unconfigured provider is an error record', async () => {
    const { g } = mk({});
    expect((await g.ask({ caller: 't', provider: 'haiku', prompt: 'p' })).record.result).toBe('error');
  });
});
