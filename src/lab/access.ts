/**
 * Cloudflare Access checks for the lab MCP (PET-667, PET-904). The verifier now lives in
 * src/mcp-kit/access.ts, shared with the media MCP; this file keeps the lab's import path.
 */
export { AccessVerifier, parseAgents, type AccessConfig, type AccessResult } from '../mcp-kit/access.js';
