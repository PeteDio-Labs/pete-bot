/**
 * The GitHub Actions client behind /update (PET-395). GitHub is faked at fetch, so these
 * pin the requests this sends and every way a run can end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  dispatch,
  findRun,
  jobLog,
  extractReport,
  runUpdate,
  REPORT_BEGIN,
  REPORT_END,
} from './githubActions.js';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const noSleep = () => Promise.resolve();

describe('dispatch', () => {
  it('posts the inputs to the workflow on main, with the token', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await dispatch('apply', 'plex', true, 'pb-x-1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://api.github.com/repos/PeteDio-Labs/petedio-media-iac/actions/workflows/media-updates.yml/dispatches',
    );
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-gh-token');
    expect(JSON.parse(init.body)).toEqual({
      ref: 'main',
      inputs: { mode: 'apply', target: 'plex', force: 'true', request_id: 'pb-x-1' },
    });
  });

  it('says what GitHub answered when it refuses', async () => {
    fetchMock.mockResolvedValue(new Response('Resource not accessible by personal access token', { status: 403 }));
    await expect(dispatch('check', 'plex', false, 'pb-x-1')).rejects.toThrow(/HTTP 403/);
  });
});

describe('findRun', () => {
  it('matches the run whose name carries the request id', async () => {
    fetchMock.mockResolvedValue(
      json({
        workflow_runs: [
          { id: 1, html_url: 'u1', display_title: 'media-updates check plex [pb-other]' },
          { id: 2, html_url: 'u2', display_title: 'media-updates check plex [pb-mine]' },
        ],
      }),
    );
    expect(await findRun('pb-mine')).toEqual({ id: 2, url: 'u2' });
  });

  it('does not match an id that is only a prefix of another', async () => {
    fetchMock.mockResolvedValue(
      json({ workflow_runs: [{ id: 1, html_url: 'u1', display_title: 'media-updates check plex [pb-mine-2]' }] }),
    );
    expect(await findRun('pb-mine')).toBeUndefined();
  });
});

describe('jobLog', () => {
  it('follows the log redirect without sending the token to the blob host', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ jobs: [{ id: 77 }] }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://blob.example/log.txt' } }))
      .mockResolvedValueOnce(new Response('the log'));

    expect(await jobLog(5)).toBe('the log');
    const [blobUrl, blobInit] = fetchMock.mock.calls[2]!;
    expect(blobUrl).toBe('https://blob.example/log.txt');
    expect(blobInit?.headers?.Authorization).toBeUndefined();
    expect(fetchMock.mock.calls[1]![1].redirect).toBe('manual');
  });
});

describe('extractReport', () => {
  it('strips the timestamps and returns the lines between the markers', () => {
    const log = [
      '2026-09-11T16:00:00.1234567Z ##[group]Run umask 077',
      `2026-09-11T16:00:01.0000000Z ${REPORT_BEGIN}`,
      '2026-09-11T16:00:01.0000001Z  MEDIA STACK — UPDATE CHECK',
      '2026-09-11T16:00:01.0000002Z plex   1.43.4   —   apt',
      `2026-09-11T16:00:01.0000003Z ${REPORT_END}`,
    ].join('\n');
    expect(extractReport(log)).toBe(' MEDIA STACK — UPDATE CHECK\nplex   1.43.4   —   apt');
  });

  it('returns nothing when the run never printed a report', () => {
    expect(extractReport('2026-09-11T16:00:00.1Z ##[error]Process completed with exit code 2.')).toBeUndefined();
  });
});

describe('runUpdate', () => {
  it('finds the run, waits for it, and returns its conclusion and report', async () => {
    const started = vi.fn();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ workflow_runs: [] }))
      .mockResolvedValueOnce(
        json({ workflow_runs: [{ id: 9, html_url: 'run-url', display_title: 'media-updates check plex [pb-t]' }] }),
      )
      .mockResolvedValueOnce(json({ status: 'in_progress', conclusion: null }))
      .mockResolvedValueOnce(json({ status: 'completed', conclusion: 'success' }))
      .mockResolvedValueOnce(json({ jobs: [{ id: 3 }] }))
      .mockResolvedValueOnce(new Response(`${REPORT_BEGIN}\nplex ok\n${REPORT_END}`));

    const outcome = await runUpdate('check', 'plex', false, { requestId: 'pb-t', sleep: noSleep, onStarted: started });

    expect(outcome).toEqual({ kind: 'completed', conclusion: 'success', url: 'run-url', report: 'plex ok' });
    expect(started).toHaveBeenCalledWith({ id: 9, url: 'run-url' });
  });

  it('carries a failed conclusion through', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        json({ workflow_runs: [{ id: 9, html_url: 'run-url', display_title: 'media-updates apply plex [pb-t]' }] }),
      )
      .mockResolvedValueOnce(json({ status: 'completed', conclusion: 'failure' }))
      .mockResolvedValueOnce(json({ jobs: [{ id: 3 }] }))
      .mockResolvedValueOnce(new Response('no markers here'));

    const outcome = await runUpdate('apply', 'plex', false, { requestId: 'pb-t', sleep: noSleep });
    expect(outcome).toMatchObject({ kind: 'completed', conclusion: 'failure', report: undefined });
  });

  it('reports a run that never appeared instead of waiting forever', async () => {
    let t = 0;
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    // A fresh Response per poll: a body can be read only once.
    fetchMock.mockImplementation(async () => json({ workflow_runs: [] }));

    const outcome = await runUpdate('check', 'plex', false, {
      requestId: 'pb-t',
      sleep: noSleep,
      now: () => (t += 10_000),
    });
    expect(outcome).toMatchObject({ kind: 'not-found', requestId: 'pb-t' });
  });

  it('stops following a run that outlives its deadline, and says so', async () => {
    let t = 0;
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        json({ workflow_runs: [{ id: 9, html_url: 'run-url', display_title: 'media-updates apply arr [pb-t]' }] }),
      );
    fetchMock.mockImplementation(async () => json({ status: 'in_progress', conclusion: null }));

    const outcome = await runUpdate('apply', 'arr', false, {
      requestId: 'pb-t',
      sleep: noSleep,
      now: () => (t += 60_000),
    });
    expect(outcome).toEqual({ kind: 'timeout', url: 'run-url' });
  });

  it('keeps following the run when showing its link fails', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        json({ workflow_runs: [{ id: 9, html_url: 'run-url', display_title: 'media-updates check plex [pb-t]' }] }),
      )
      .mockResolvedValueOnce(json({ status: 'completed', conclusion: 'success' }))
      .mockResolvedValueOnce(json({ jobs: [{ id: 3 }] }))
      .mockResolvedValueOnce(new Response(`${REPORT_BEGIN}\nok\n${REPORT_END}`));

    const outcome = await runUpdate('check', 'plex', false, {
      requestId: 'pb-t',
      sleep: noSleep,
      onStarted: () => Promise.reject(new Error('discord hiccup')),
    });
    expect(outcome).toMatchObject({ kind: 'completed', conclusion: 'success', report: 'ok' });
  });
});
