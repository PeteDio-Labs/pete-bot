/**
 * The client's half of a DTO mirrored by hand across two repos. petedio-media-control
 * owns the shape; nothing type-checks the seam, which is how PET-89 happened.
 *
 * Most of this is characterization — it pins what already ships. The `ok:false` case is
 * PET-384 and is a real defect: mtrace answers a TOOL failure with HTTP 200 and
 * {ok:false,error}, deliberately, because "sonarr is not answering" is a finding about
 * the stack rather than a transport error. The client read only `text`, found none, and
 * threw "mtrace returned no text" — so the finding was replaced with a message that
 * says the dashboard is broken when the dashboard is the only thing working.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ask, health } from './mtraceClient.js';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('ask', () => {
  it('reads the wrapped shape mtrace actually sends', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        ok: true,
        result: { text: 'plex is up', via: 'keyword', timing: { routeMs: 1, toolMs: 20, totalMs: 21 } },
      }),
    );
    await expect(ask('is plex up')).resolves.toEqual({
      text: 'plex is up',
      routedBy: 'keyword',
      timing: { routeMs: 1, toolMs: 20, totalMs: 21 },
      notice: undefined,
    });
  });

  it('reads a bare shape too, for a caller that unwraps', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: 'plex is up', via: 'ollama' }));
    await expect(ask('is plex up')).resolves.toMatchObject({ text: 'plex is up', routedBy: 'ollama' });
  });

  it('sends the bearer and the question to /api/ask', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ result: { text: 'ok' } }));
    await ask('why is sonarr stuck');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/ask$/);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-mtrace-token');
    expect(JSON.parse(init.body)).toEqual({ question: 'why is sonarr stuck' });
  });

  it('bounds the request, because fetch has no default timeout', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ result: { text: 'ok' } }));
    await ask('anything');
    expect(fetchMock.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });

  it('reports an HTTP failure with its status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401));
    await expect(ask('anything')).rejects.toThrow(/401/);
  });

  // ── PET-384: the finding must survive the trip ──────────────────────────────
  it('surfaces a tool failure that mtrace reports as ok:false at HTTP 200', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'sonarr is not answering' }));
    await expect(ask('why is sonarr stuck')).rejects.toThrow('sonarr is not answering');
  });

  it('does not disguise that failure as an empty answer', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'ssh: connect to host plex port 22' }));
    await expect(ask('trace plex')).rejects.not.toThrow(/no text/i);
  });

  it('still complains when mtrace claims success and sends nothing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, result: { via: 'keyword' } }));
    await expect(ask('anything')).rejects.toThrow(/no text/i);
  });

  it('carries the degraded-answer notice through', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, result: { text: 'plex is up', via: 'keyword', notice: 'ollama unreachable' } }),
    );
    await expect(ask('is plex up')).resolves.toMatchObject({ notice: 'ollama unreachable' });
  });
});

// ── PET-384 UC-6: /status needs something to ask ──────────────────────────────
describe('health', () => {
  it('reports mtrace reachable, and never sends the bearer', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, service: 'mtrace', model: 'qwen2.5:7b' }));
    const result = await health();
    expect(result).toMatchObject({ reachable: true, service: 'mtrace', model: 'qwen2.5:7b' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/health$/);
    expect(init?.headers?.Authorization).toBeUndefined();
  });

  it('reports unreachable with the reason instead of throwing', async () => {
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8237'));
    await expect(health()).resolves.toMatchObject({ reachable: false, detail: expect.stringContaining('ECONNREFUSED') });
  });

  it('treats a non-2xx health as unreachable rather than healthy', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false }, 503));
    await expect(health()).resolves.toMatchObject({ reachable: false });
  });
});
