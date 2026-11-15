# @petedio/mcp-kit

The shared core for PeteDio MCP servers: one JSON-RPC handler, the Cloudflare Access verifier,
read and write tiers, redaction and a contract test suite. The standard it implements is in the
proposal doc for PET-924.

| Piece | File | What it does |
|---|---|---|
| Handler | `src/handler.ts` | Serves `initialize`, `ping`, `tools/list` and `tools/call`. Checks the tunnel peer and the Access JWT on every request. |
| Access | `src/access.ts` | Verifies the Access JWT for a person's email or an agent's service token. |
| Tool contract | `src/tool.ts` | A tool is a zod input, a `tier` and a `run` that returns `{ source, data }`. A failed read throws `McpToolError`, which becomes `isError`, never an empty success. |
| Redaction | `src/redact.ts` | Replaces bearer values, JWTs, Vault tokens and secret-named values in every result. |
| Contract suite | `test/contract.ts` | `runContract` proves the rules above against a server's own tools. |

## Tiers

- `read` changes nothing outside the process.
- `write` starts or changes something. A server lists it only when `exposeTiers` names `write`.
- There is no `destructive` tier. No MCP server exposes one.

Over MCP, a `write` tool requests; anything that changes host state goes through `lab-action.yml`.

## Use it from another repo

Pin this directory by commit and run `runContract` in your tests. `petedio-media-control` follows
this path once its MCP door moves to the kit.

## Status

Nothing imports the kit yet. `src/lab/mcp.ts` and `src/lab/access.ts` still serve the lab MCP, and
the next change moves them onto it with the contract suite green before and after.
