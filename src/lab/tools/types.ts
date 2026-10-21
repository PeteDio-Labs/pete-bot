/**
 * The lab tool contract (PET-668). Every read the lab-map agent and the lab MCP make goes
 * through one of these, so each read is built and tested once.
 *
 * A TOOL IS A FIXED, TYPED CALL. It takes a zod-checked input, reads one source, and returns
 * its data with a `source` line saying what it read. There is no shell tool and no free-form
 * command, so a prompt that steers the caller can only choose among these reads.
 *
 * ⚠ A FAILED READ IS AN ERROR, NEVER AN EMPTY SUCCESS. The recurring bug in this lab is a
 * green check over work that never happened (PET-298, PET-374). A tool that cannot reach its
 * source, or reaches it and gets nothing back where something must exist, throws a
 * LabToolError. callTool turns that into `{ ok: false }`, which the caller sees as a failure.
 *
 * ⚠ SAY WHAT WAS EXAMINED. `source` names the source and the count it covered, such as
 * "21 guests from Proxmox cluster/resources", so "0 down of 19" and "read nothing" never
 * look alike.
 */
import { z } from 'zod';

/** The most text one tool call returns. A model pays for every byte of a tool result. */
export const DEFAULT_OUTPUT_CAP_BYTES = 16 * 1024;

export interface ToolOutput {
  /** What the tool read and how much, in one line. */
  source: string;
  data: unknown;
}

export interface LabTool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  input: S;
  run(input: z.infer<S>): Promise<ToolOutput>;
}

export type ToolResult = { ok: true; text: string; truncated: boolean } | { ok: false; error: string };

/** A read that failed in a way the caller should see. The message must carry no secret. */
export class LabToolError extends Error {
  override name = 'LabToolError';
}

/**
 * Cut text to at most `capBytes` UTF-8 bytes, on a character boundary, and say how much
 * was dropped. The note is part of the cap, so the result never exceeds it.
 */
export function capText(text: string, capBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= capBytes) return { text, truncated: false };
  const note = (dropped: number) => `\n… truncated: ${dropped} of ${bytes.length} bytes dropped`;
  const room = Math.max(0, capBytes - Buffer.byteLength(note(bytes.length), 'utf8'));
  let kept = bytes.subarray(0, room).toString('utf8');
  // A cut inside a multi-byte character decodes to U+FFFD; drop that partial character.
  if (kept.endsWith('�')) kept = kept.slice(0, -1);
  return { text: kept + note(bytes.length - Buffer.byteLength(kept, 'utf8')), truncated: true };
}

/** Validate the input, run the tool, and render the result as capped JSON text. */
export async function callTool(
  tool: LabTool,
  rawInput: unknown,
  capBytes = DEFAULT_OUTPUT_CAP_BYTES,
): Promise<ToolResult> {
  // Unknown keys are refused, as the advertised schema says (additionalProperties: false).
  const schema = tool.input instanceof z.ZodObject ? tool.input.strict() : tool.input;
  const parsed = schema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`);
    return { ok: false, error: `${tool.name}: invalid input: ${issues.join('; ')}` };
  }
  try {
    const out = await tool.run(parsed.data);
    const { text, truncated } = capText(JSON.stringify(out, null, 1), capBytes);
    return { ok: true, text, truncated };
  } catch (err) {
    // A LabToolError carries a message written for the caller. Anything else is a bug, and
    // its message may hold internals, so only its class name crosses.
    const message = err instanceof LabToolError ? err.message : `internal error (${(err as Error)?.name ?? 'unknown'})`;
    return { ok: false, error: `${tool.name}: ${message}` };
  }
}

/**
 * The JSON Schema of a tool's input, for the Anthropic `tools` array and the MCP
 * `tools/list` answer. It covers the zod shapes the lab tools use and throws on any other,
 * so a new shape fails a test instead of shipping a wrong schema.
 */
export function inputJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return toJson(schema);
}

function toJson(schema: z.ZodTypeAny): Record<string, unknown> {
  const withDescription = (out: Record<string, unknown>) =>
    schema.description ? { ...out, description: schema.description } : out;

  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    const inner = toJson(schema._def.innerType);
    const def = schema instanceof z.ZodDefault ? { default: schema._def.defaultValue() } : {};
    return { ...inner, ...def, ...(schema.description ? { description: schema.description } : {}) };
  }
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = toJson(value);
      if (!value.isOptional()) required.push(key);
    }
    return withDescription({
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    });
  }
  if (schema instanceof z.ZodString) {
    const out: Record<string, unknown> = { type: 'string' };
    for (const check of schema._def.checks) {
      if (check.kind === 'min') out.minLength = check.value;
      if (check.kind === 'max') out.maxLength = check.value;
      if (check.kind === 'regex') out.pattern = check.regex.source;
    }
    return withDescription(out);
  }
  if (schema instanceof z.ZodNumber) {
    const out: Record<string, unknown> = { type: schema.isInt ? 'integer' : 'number' };
    for (const check of schema._def.checks) {
      if (check.kind === 'min') out.minimum = check.value;
      if (check.kind === 'max') out.maximum = check.value;
    }
    return withDescription(out);
  }
  if (schema instanceof z.ZodArray) {
    const out: Record<string, unknown> = { type: 'array', items: toJson(schema._def.type) };
    if (schema._def.minLength) out.minItems = schema._def.minLength.value;
    if (schema._def.maxLength) out.maxItems = schema._def.maxLength.value;
    return withDescription(out);
  }
  if (schema instanceof z.ZodEnum) {
    return withDescription({ type: 'string', enum: [...schema.options] });
  }
  throw new Error(`inputJsonSchema: unsupported zod type ${schema.constructor.name}`);
}

/** fetch with a deadline. fetch has no default timeout, so a stalled source would hang a call. */
export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit & { tls?: { ca?: string } },
  timeoutMs: number,
  what: string,
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const e = err as Error;
    const reason = e?.name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : `unreachable (${e?.message ?? e})`;
    throw new LabToolError(`${what}: ${reason}`);
  }
}
