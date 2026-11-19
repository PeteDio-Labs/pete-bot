import { describe, expect, test } from 'bun:test';
import { llmCallsHandler, llmUsageHandler } from './llm.js';

const run = (h: (req: never, res: never) => void, auth?: string) => {
  let status = 200;
  let body: unknown;
  const res = { status: (s: number) => ((status = s), res), json: (b: unknown) => ((body = b), res) };
  h({ header: () => auth, query: {} } as never, res as never);
  return { status, body };
};

describe('llm routes', () => {
  test('refuse with no token configured, even when a header is sent', () => {
    delete process.env.LLM_READ_BEARER_TOKEN;
    expect(run(llmCallsHandler(), 'Bearer x').status).toBe(401);
    expect(run(llmUsageHandler(), undefined).status).toBe(401);
  });
  test('answer with the right token and say what was examined', () => {
    process.env.LLM_READ_BEARER_TOKEN = 'tok';
    const r = run(llmCallsHandler(), 'Bearer tok');
    expect(r.status).toBe(200);
    expect((r.body as { examined: number }).examined).toBe(0);
    expect(run(llmUsageHandler(), 'Bearer tok').status).toBe(200);
  });
});
