/**
 * lab-agent's HTTP surface (PET-669). It listens on 127.0.0.1 only.
 *
 *   POST /v1/ask   {"question": "..."} with the ask bearer. pete-bot's /lab command is the
 *                  one caller. Answers {answer, turns, toolCalls, incomplete, usage}.
 *   GET  /health   one flag per dependency: model, proxmox, vault clone, kuma. HTTP 503
 *                  unless every flag is up, so the deploy's assertion can fail on it.
 *   POST /v1/media/ask  {"question": "...", "history": [...]} with the ask bearer (PET-869).
 *                  The media assistant: the same loop over the media tools only. Absent
 *                  media tools, it answers 404, so an unconfigured host says so.
 *   POST /v1/media/act  {"kind": "series"|"movie", "id": 12} with the ask bearer (PET-869).
 *                  Runs the one write lab-agent holds, a Bazarr subtitle search, after the
 *                  owner tapped Confirm in Discord. 404 without a Bazarr key.
 *   POST /v1/drift/run  the nightly drift check, now, with the ask bearer (PET-671). It
 *                  answers with the run's outcome and DMs exactly as the nightly run does.
 *
 * ⚠ ONE QUESTION AT A TIME. Each answer spends from the lab-map cap, and Pedro is the only
 * asker, so a second request while one runs gets 429 instead of a second loop.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  ask,
  ASK_DEADLINE_MS,
  MEDIA_SYSTEM_PROMPT,
  type AskResult,
  type CallModel,
} from "./agent.js";
import { ModelError } from "./ollama.js";
import type { DriftOutcome } from "./drift.js";
import type { LabTool } from "./tools/index.js";

export type Check = () => Promise<string>;

export interface LabServerDeps {
  askToken: string;
  tools: Map<string, LabTool>;
  callModel: CallModel;
  model: string;
  /** Each check resolves with a short detail, or throws with the reason it is down. */
  checks: Record<string, Check>;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** Tests shorten it; production uses ASK_DEADLINE_MS. */
  deadlineMs?: number;
  /** The media assistant's tools (PET-869): mtrace and search. Absent, /v1/media/ask answers 404. */
  mediaTools?: Map<string, LabTool>;
  /** The confirmed subtitle search (PET-869). Absent, /v1/media/act answers 404. */
  actBazarr?: (kind: "series" | "movie", id: number) => Promise<string>;
  /** One drift run, single-flight (PET-671). Absent, POST /v1/drift/run answers 404. */
  runDrift?: () => Promise<DriftOutcome>;
}

const AskBody = z
  .object({ question: z.string().trim().min(3).max(500) })
  .strict();
const MediaBody = z
  .object({
    question: z.string().trim().min(2).max(1500),
    history: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.string().max(4000),
          })
          .strict(),
      )
      .max(12)
      .default([]),
  })
  .strict();
const ActBody = z
  .object({
    kind: z.enum(["series", "movie"]),
    id: z.number().int().min(0).max(10_000_000),
  })
  .strict();
const CHECK_TIMEOUT_MS = 10_000;

const digest = (s: string) => createHash("sha256").update(s).digest();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function runChecks(
  checks: Record<string, Check>,
): Promise<{
  ok: boolean;
  checks: Record<string, { up: boolean; detail: string }>;
}> {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, check]) => {
      try {
        const detail = await Promise.race([
          check(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(new Error(`no answer within ${CHECK_TIMEOUT_MS} ms`)),
              CHECK_TIMEOUT_MS,
            ),
          ),
        ]);
        return [name, { up: true, detail }] as const;
      } catch (err) {
        return [name, { up: false, detail: (err as Error).message }] as const;
      }
    }),
  );
  return {
    ok: entries.length > 0 && entries.every(([, c]) => c.up),
    checks: Object.fromEntries(entries),
  };
}

export function createLabHandler(
  deps: LabServerDeps,
): (req: Request) => Promise<Response> {
  const log = deps.log ?? (() => {});
  const want = digest(deps.askToken);
  let busy = false;
  const authorized = (req: Request) => {
    const bearer =
      /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ??
      "";
    return Boolean(bearer) && timingSafeEqual(digest(bearer), want);
  };

  return async (req) => {
    const url = new URL(req.url);

    if (url.pathname === "/v1/drift/run" && deps.runDrift) {
      if (req.method !== "POST") return json({ error: "use POST" }, 405);
      if (!authorized(req)) return json({ error: "unauthorized" }, 401);
      // runDrift is single-flight: a call during a run waits for that run's outcome.
      // 502 when the run examined nothing or its DM was not delivered, so a caller that
      // reads only the status never mistakes either for a clean run.
      const outcome = await deps.runDrift();
      return json(
        outcome,
        outcome.kind === "read-failed" || outcome.delivered === false
          ? 502
          : 200,
      );
    }

    if (req.method === "GET" && url.pathname === "/health") {
      const result = await runChecks(deps.checks);
      return json(
        { status: result.ok ? "ok" : "degraded", ...result },
        result.ok ? 200 : 503,
      );
    }

    if (url.pathname === "/v1/media/act" && deps.actBazarr) {
      if (req.method !== "POST") return json({ error: "use POST" }, 405);
      if (!authorized(req)) return json({ error: "unauthorized" }, 401);
      let body: z.infer<typeof ActBody>;
      try {
        const parsed = ActBody.safeParse(await req.json());
        if (!parsed.success)
          return json(
            {
              error:
                'body must be {"kind": "series" or "movie", "id": <whole number>}',
            },
            400,
          );
        body = parsed.data;
      } catch {
        return json({ error: "body is not JSON" }, 400);
      }
      try {
        const message = await deps.actBazarr(body.kind, body.id);
        log("media act done", { kind: body.kind, id: body.id });
        return json({ ok: true, message });
      } catch (err) {
        // A LabToolError message is written for the caller and holds no key.
        const message =
          err instanceof Error && err.name === "LabToolError"
            ? err.message
            : `internal error (${(err as Error)?.name ?? "unknown"})`;
        log("media act failed", {
          kind: body.kind,
          id: body.id,
          error: message,
        });
        return json({ ok: false, error: message }, 502);
      }
    }

    const isMedia =
      url.pathname === "/v1/media/ask" && Boolean(deps.mediaTools);
    if (url.pathname === "/v1/ask" || isMedia) {
      if (req.method !== "POST") return json({ error: "use POST" }, 405);
      if (!authorized(req)) return json({ error: "unauthorized" }, 401);

      let body: {
        question: string;
        history: Array<{ role: "user" | "assistant"; content: string }>;
      };
      try {
        const raw: unknown = await req.json();
        if (isMedia) {
          const parsed = MediaBody.safeParse(raw);
          if (!parsed.success)
            return json(
              {
                error:
                  'body must be {"question": "<2 to 1500 characters>", "history": [{role, content}] (at most 12)}',
              },
              400,
            );
          body = parsed.data;
        } else {
          const parsed = AskBody.safeParse(raw);
          if (!parsed.success)
            return json(
              { error: 'body must be {"question": "<3 to 500 characters>"}' },
              400,
            );
          body = { question: parsed.data.question, history: [] };
        }
      } catch {
        return json({ error: "body is not JSON" }, 400);
      }

      if (busy) return json({ error: "a question is already running" }, 429);
      busy = true;
      const started = Date.now();
      try {
        const signal = AbortSignal.any([
          req.signal,
          AbortSignal.timeout(deps.deadlineMs ?? ASK_DEADLINE_MS),
        ]);
        const result: AskResult = isMedia
          ? await ask(
              body.question,
              deps.mediaTools!,
              deps.callModel,
              deps.model,
              signal,
              { system: MEDIA_SYSTEM_PROMPT, history: body.history },
            )
          : await ask(
              body.question,
              deps.tools,
              deps.callModel,
              deps.model,
              signal,
            );
        log(isMedia ? "media ask answered" : "ask answered", {
          ms: Date.now() - started,
          turns: result.turns,
          tools: result.toolCalls,
          toolErrors: result.toolErrors,
          usage: result.usage,
          incomplete: result.incomplete,
        });
        return json(result);
      } catch (err) {
        const message =
          err instanceof ModelError
            ? err.message
            : `internal error (${(err as Error)?.name ?? "unknown"})`;
        log(isMedia ? "media ask failed" : "ask failed", {
          ms: Date.now() - started,
          error: message,
        });
        return json({ error: message }, 502);
      } finally {
        busy = false;
      }
    }

    return json({ error: "not found" }, 404);
  };
}
