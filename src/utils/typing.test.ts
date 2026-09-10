/**
 * PET-384 UC-3 — the typing indicator lasts as long as the wait.
 *
 * messageCreate called sendTyping() exactly once. Discord's indicator expires after
 * about ten seconds; MTRACE_TIMEOUT_MS is 60000. Between those two numbers the DM reads
 * as a bot that ignored you — which is the thing that call's own comment says it is
 * there to prevent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withTyping, TYPING_INTERVAL_MS } from './typing.js';

function fakeChannel() {
  return { sendTyping: vi.fn().mockResolvedValue(undefined) };
}

describe('withTyping', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts typing before the work does', async () => {
    const channel = fakeChannel();
    const work = vi.fn().mockResolvedValue('answer');
    const promise = withTyping(channel, work);
    expect(channel.sendTyping).toHaveBeenCalledTimes(1);
    await expect(promise).resolves.toBe('answer');
  });

  it('keeps typing across a 40-second answer', async () => {
    const channel = fakeChannel();
    let release!: (v: string) => void;
    const promise = withTyping(channel, () => new Promise<string>((r) => (release = r)));

    await vi.advanceTimersByTimeAsync(40_000);
    // One immediate call plus one per interval.
    const expected = 1 + Math.floor(40_000 / TYPING_INTERVAL_MS);
    expect(channel.sendTyping).toHaveBeenCalledTimes(expected);

    release('done');
    await expect(promise).resolves.toBe('done');
  });

  it('stops typing once the answer lands', async () => {
    const channel = fakeChannel();
    await withTyping(channel, async () => 'quick');
    const afterWork = channel.sendTyping.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(channel.sendTyping).toHaveBeenCalledTimes(afterWork);
  });

  it('stops typing when the work throws, and rethrows', async () => {
    const channel = fakeChannel();
    await expect(
      withTyping(channel, async () => {
        throw new Error('mtrace returned 502');
      }),
    ).rejects.toThrow('mtrace returned 502');

    const afterWork = channel.sendTyping.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(channel.sendTyping).toHaveBeenCalledTimes(afterWork);
  });

  it('answers even when the channel refuses to show typing', async () => {
    const channel = { sendTyping: vi.fn().mockRejectedValue(new Error('Missing Access')) };
    await expect(withTyping(channel, async () => 'answer')).resolves.toBe('answer');
  });

  it('types under a real timer too, not only a fake one', async () => {
    vi.useRealTimers();
    const channel = fakeChannel();
    await withTyping(channel, async () => 'answer');
    expect(channel.sendTyping).toHaveBeenCalled();
  });
});
