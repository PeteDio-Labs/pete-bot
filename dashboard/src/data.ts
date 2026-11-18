/**
 * Where the dashboard's data comes from. The app calls `getData()` and nothing else, so moving
 * from the local feed to the AWS feed changes the URL here and no view.
 */
import { parseDashboard, type DashboardData, type Side } from './model.ts';

export interface Feed {
  load(): Promise<{ data: DashboardData; problems: string[] }>;
  /** Null when this feed cannot request a switch. The panel then says so. */
  requestSwitch: ((service: string, to: Side) => Promise<{ ok: boolean; message: string }>) | null;
}

export function httpFeed(url: string, switchUrl: string | null, fetchImpl: typeof fetch = fetch): Feed {
  return {
    async load() {
      let res: Response;
      try {
        // `include` sends the Access cookie to a feed on another origin (reports.pdlab.dev).
        res = await fetchImpl(url, { headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'include' });
      } catch {
        // A blocked or redirected cross-origin read looks the same as an offline feed: say how to fix the likely cause.
        const origin = /^https?:/i.test(url) ? new URL(url).origin : null;
        throw new Error(origin ? `the feed could not be read; open ${origin} once to sign in, then reload` : 'the feed could not be read');
      }
      if (!res.ok) throw new Error(`the feed answered ${res.status}`);
      return parseDashboard(await res.json());
    },
    requestSwitch: switchUrl
      ? async (service, to) => {
          const res = await fetchImpl(switchUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service, to }) });
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          return { ok: res.ok, message: String(body.message ?? (res.ok ? 'Request queued.' : `The request failed with ${res.status}.`)).slice(0, 200) };
        }
      : null,
  };
}

/** The feed named by the page's `<meta name="dashboard-feed">`, or the fixture feed. */
export function getFeed(doc: Document = document): Feed {
  const meta = (name: string): string | null => doc.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content.trim() || null;
  return httpFeed(meta('dashboard-feed') ?? '/fixtures/dashboard.json', meta('dashboard-switch'));
}
