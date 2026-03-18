import { wsRequestDuration } from '../metrics/index.js';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  score?: number;
}

export interface WebSearchResponse {
  query: string;
  provider: string;
  results: WebSearchResult[];
  metadata: {
    durationMs: number;
    fallbackUsed: boolean;
    providersAttempted: string[];
  };
}

export interface WebSearchProviderInfo {
  name: string;
  available: boolean;
  avgLatencyMs: number;
  requestCount: number;
  errorCount: number;
  quotaRemaining: number | null;
  circuitOpen: boolean;
}

export class WebSearchClient {
  private host: string;
  private timeout: number = 15000;

  constructor(host: string) {
    this.host = host;
  }

  async search(query: string, maxResults = 5): Promise<WebSearchResponse> {
    const url = `${this.host}/api/v1/search`;
    const start = Date.now();

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, maxResults }),
        signal: AbortSignal.timeout(this.timeout),
      });

      const duration = (Date.now() - start) / 1000;
      wsRequestDuration.observe(duration);

      if (!response.ok) {
        throw new Error(`Web Search API error: ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as WebSearchResponse;
    } catch (error: unknown) {
      const duration = (Date.now() - start) / 1000;
      wsRequestDuration.observe(duration);

      if (error instanceof Error) {
        throw new Error(`Failed to fetch from Web Search Service: ${error.message}`);
      }
      throw error;
    }
  }

  async getProviders(): Promise<{ providers: WebSearchProviderInfo[] }> {
    const response = await fetch(`${this.host}/api/v1/providers`, {
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!response.ok) throw new Error(`Providers API error: ${response.status}`);
    return (await response.json()) as { providers: WebSearchProviderInfo[] };
  }
}
