/** Codex verdicts and the queue call (PET-645). */
import { describe, it, expect } from 'bun:test';
import { verdictOf, sshArgv, CodexQueue, CODEX_LOGIN, effortFor } from './codex.js';
import type { Review } from './github.js';

const opts = { target: 'codex@192.168.50.248', keyPath: '/etc/pete-bot/codex_ed25519', knownHostsPath: '/etc/pete-bot/codex_known_hosts', timeoutMs: 1000 };

function review(body: string, author = CODEX_LOGIN): Review {
  return { id: 1, author, commitId: 'a'.repeat(40), state: 'COMMENTED', body, htmlUrl: 'u', submittedAt: 't' };
}

describe('verdictOf', () => {
  it('reads each verdict from the first line', () => {
    expect(verdictOf(review('## Codex review: No blocking findings\n\nok'))?.verdict).toBe('no-blocking');
    expect(verdictOf(review('## Codex review: Changes requested\n'))?.verdict).toBe('changes-requested');
    expect(verdictOf(review('## Codex review: Escalate to Pedro'))?.verdict).toBe('escalate');
  });

  it('ignores the same words from anyone but the Codex App', () => {
    expect(verdictOf(review('## Codex review: No blocking findings', 'petedillo'))).toBeNull();
    expect(verdictOf(review('## Codex review: No blocking findings', 'petedio-codex-review'))).toBeNull();
  });

  it('reads only the first line, so a quoted diff cannot add a verdict', () => {
    expect(verdictOf(review('Some preamble\n## Codex review: No blocking findings'))).toBeNull();
  });

  it('ignores an unknown verdict', () => {
    expect(verdictOf(review('## Codex review: Unrecognized verdict'))).toBeNull();
  });
});

describe('the queue call', () => {
  it('sends the gate exactly four words as one argument', () => {
    const argv = sshArgv(opts, 'petedio-workspace', 12, 'medium');
    expect(argv.at(-1)).toBe('codex-review petedio-workspace 12 medium');
    expect(argv.at(-2)).toBe('codex@192.168.50.248');
    expect(argv).toContain('StrictHostKeyChecking=yes');
    expect(argv).toContain('BatchMode=yes');
  });

  it('refuses a repository name the gate would refuse', () => {
    expect(() => sshArgv(opts, 'x; rm -rf /', 1, 'low')).toThrow();
    expect(() => sshArgv(opts, 'Petedio', 1, 'low')).toThrow();
    expect(() => sshArgv(opts, 'ok', 0, 'low')).toThrow();
  });

  it('runs one review at a time', async () => {
    let running = 0;
    let peak = 0;
    const q = new CodexQueue({
      ...opts,
      spawn: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return { exitCode: 0, output: 'done' };
      },
    });
    const results = await Promise.all([q.enqueue('a', 1, 'low'), q.enqueue('b', 2, 'low'), q.enqueue('c', 3, 'low')]);
    expect(peak).toBe(1);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('reports a failed or crashed run, and keeps the queue moving', async () => {
    let calls = 0;
    const q = new CodexQueue({
      ...opts,
      spawn: async () => {
        calls++;
        if (calls === 1) return { exitCode: 255, output: 'ssh: connect to host: timed out' };
        if (calls === 2) throw new Error('spawn failed');
        return { exitCode: 0, output: '' };
      },
    });
    const [a, b, c] = await Promise.all([q.enqueue('a', 1, 'low'), q.enqueue('b', 2, 'low'), q.enqueue('c', 3, 'low')]);
    expect(a).toMatchObject({ ok: false, exitCode: 255 });
    expect(a!.tail).toContain('timed out');
    expect(b).toMatchObject({ ok: false, exitCode: null, tail: 'spawn failed' });
    expect(c!.ok).toBe(true);
  });

  it('maps tiers to effort', () => {
    expect([effortFor(0), effortFor(1), effortFor(2)]).toEqual(['low', 'medium', 'high']);
  });
});
