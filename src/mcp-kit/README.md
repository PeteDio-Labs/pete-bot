# @petedio/mcp-kit

The shared core for PeteDio MCP servers: one JSON-RPC handler, the Cloudflare Access verifier,
read and write tiers, redaction and a contract test suite. The standard it implements is in the
proposal doc for PET-924.

| Piece | File | What it does |
|---|---|---|
| Handler | `handler.ts` | Serves `initialize`, `ping`, `tools/list` and `tools/call`. Checks the tunnel peer and the Access JWT on every request. |
| Access | `access.ts` | Verifies the Access JWT for a person's email or an agent's service token. |
| Tool contract | `tool.ts` | A tool is a zod input, a `tier` and a `run` that returns `{ source, data }`. A failed read throws `McpToolError`, which becomes `isError`, never an empty success. |
| Redaction | `redact.ts` | Replaces bearer values, JWTs, Vault tokens and secret-named values in every result. |
| Contract suite | `contract.ts` | `runContract` proves the rules above against a server's own tools. |

## Tiers

- `read` changes nothing outside the process.
- `write` starts or changes something. A server lists it only when `exposeTiers` names `write`.
- There is no `destructive` tier. No MCP server exposes one.

Over MCP, a `write` tool requests; anything that changes host state goes through `lab-action.yml`.

## Renaming a tool

Set `aliases: ['old_name']` on the tool. The old name still answers `tools/call`, and the log line carries `alias`. `tools/list` shows only the new name. Remove the alias one release later.

## Use it from another repo

Copy or pin `src/mcp-kit` by commit from `pete-bot` and run `runContract` in your tests. `petedio-media-control`
this path once its MCP door moves to the kit.

## Status

`src/lab/mcp.ts` serves the lab MCP through `createMcpHandler`. `src/lab/access.ts` re-exports the
verifier, and `src/lab/tools/types.ts` adapts `LabTool` to the kit's tool contract, with
`readOnly: false` mapping to the `write` tier. `petedio-media-control` has not moved yet.
