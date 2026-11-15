/**
 * The lab tool contract (PET-668). The mechanics (callTool, capText, inputJsonSchema, the error
 * class) live in src/mcp-kit, shared with the media MCP. This file keeps the lab's `LabTool`
 * shape and adapts it, so no lab tool changes. Every read the lab-map agent and the lab MCP make goes
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
import {
  callTool as kitCallTool,
  capText,
  fetchWithTimeout,
  inputJsonSchema,
  McpToolError,
  type McpTool,
  type Tier,
  type ToolOutput,
  type ToolResult,
} from '../../mcp-kit/index.js';

export { capText, fetchWithTimeout, inputJsonSchema, type ToolOutput, type ToolResult };
/** A read that failed in a way the caller should see. The message must carry no secret. */
export { McpToolError as LabToolError };

/** The most text one tool call returns. A model pays for every byte of a tool result. */
export const DEFAULT_OUTPUT_CAP_BYTES = 16 * 1024;

export interface LabTool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  /** Earlier names the lab MCP still answers (see McpTool.aliases). */
  aliases?: readonly string[];
  description: string;
  input: S;
  /**
   * Keys to drop before validation, so the strict schema refuses everything else. Set it
   * only on a read-only tool whose extra key cannot change what it reads: the media
   * assistant's model adds `title` to no-argument tools such as list_queue, and the refusal
   * cost a retry and a "1 read(s) failed" note on every follow-up (2026-11-12).
   */
  ignoredKeys?: readonly string[];
  /** Default true. A tool that sets false changes something outside this process, and is the kit's `write` tier. */
  readOnly?: boolean;
  run(input: z.infer<S>): Promise<ToolOutput>;
}

/** The kit tier of a lab tool: `write` when `readOnly` is false, `read` otherwise. */
export const tierOf = (tool: LabTool): Tier => (tool.readOnly === false ? 'write' : 'read');

/** A lab tool in the shape the kit's handler and callTool take. */
export const toMcpTool = (tool: LabTool): McpTool => ({ ...tool, tier: tierOf(tool) });

/** Validate the input, run the tool, and render the result as capped JSON text. */
export function callTool(tool: LabTool, rawInput: unknown, capBytes = DEFAULT_OUTPUT_CAP_BYTES): Promise<ToolResult> {
  return kitCallTool(toMcpTool(tool), rawInput, capBytes);
}
