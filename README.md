# Pete Bot

A Discord surface for the PeteDio homelab. It holds no tools of its own.

**Type at it in the DM, or use `/ask <question>`.** Either forwards to
[mtrace](https://github.com/PeteDio-Labs/petedio-media-control) on media-dash-237 and
renders the answer.

> ⚠ **Plain messages need the Message Content intent**, which is privileged: enable it in
> the Developer Portal under **Bot → Privileged Gateway Intents**. Requesting it while it
> is disabled makes login fail outright, which the deploy's login check catches. With it
> off but not requested, `content` arrives empty and the bot appears to ignore you —
> which is why it answers that case explicitly instead of staying quiet. mtrace owns the tool set and the routing,
including the deterministic keyword router that answers when Ollama is unreachable — so
the CLI and Discord cannot disagree about the same stack.

**`POST /v1/alert`** takes an Uptime Kuma webhook and puts it in the owner's DM, editing
the original message when the service recovers rather than posting a second one.

## It is a user-installed app, not a server bot

It is installed to one Discord account and lives in no server. Commands declare
`integration_types: [1]` and the `PRIVATE_CHANNEL` context, which is what makes `/ask`
work in a DM with the app.

> ⚠ **The DM push is the part to verify, not assume.** `POST /v1/alert` calls
> `users.fetch().createDM().send()`. Discord permits that after user-initiated contact
> and refuses it with `50007` otherwise. Opening the DM once and running `/ask` should
> satisfy that permanently — but until a `/v1/alert` call has been delivered with no
> mutual guild, treat alerting as unproven. See PET-375.

## What this used to be

An Ollama tool-calling bot for Mission Control, ArgoCD and Kubernetes. All three are
torn down, so the tool layer, the SSE event stream, the plan-expiry sweep and the
HMAC-gated Mission Control routes are gone. `pete-bot-gitops` deploys to a cluster that
no longer exists.

## Quick Start

```bash
bun install
cp .env.example .env  # configure DISCORD_TOKEN, DISCORD_CLIENT_ID, OWNER_USER_ID
bun dev
```

## Scripts

```bash
bun dev          # dev server (hot reload)
bun build        # production build
bun test         # run tests
bun run lint
bun run typecheck
```

## Stack

- **Runtime:** Bun
- **Framework:** discord.js, TypeScript
- **AI:** Ollama (tool-calling loop, configurable model)
- **Logging:** Pino
- **Metrics:** prom-client (Prometheus)

## Architecture

```
User ──/ask──→ Discord Bot
                   │
                   ├──→ Ollama (LLM tool-calling loop, max 5 iterations)
                   │       │
                   │       ├──→ mission_control (inventory, ArgoCD, Proxmox, events)
                   │       ├──→ infrastructure (K8s hosts, pods, workloads)
                   │       ├──→ argocd (app sync/health)
                   │       ├──→ alerts (recent infrastructure events)
                   │       ├──→ web_search (multi-provider via web-search-service)
                   │       ├──→ qbittorrent (torrent management)
                   │       ├──→ calculate (math expressions)
                   │       └──→ get_current_time (timezone queries)
                   │
                   └──→ DM (full response embed with question, answer, tools used)
```

## Slash Commands

| Command | Description |
|---------|-------------|
| `/ask <question>` | Ask the AI a question — response sent to DMs |
| `/tools [tool]` | List available tools or view tool details |
| `/help [topic]` | Bot help with example prompts |
| `/info` | Bot status and service health |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_TOKEN` | Yes | — | Discord bot token |
| `DISCORD_CLIENT_ID` | Yes | — | Discord application client ID |
| `ALLOWED_USER_IDS` | Yes | — | Comma-separated authorized user IDs |
| `OLLAMA_HOST` | No | `http://localhost:11434` | Ollama API endpoint |
| `OLLAMA_MODEL` | No | `qwen2.5:7b` | Ollama model name |
| `METRICS_ENABLED` | No | `true` | Enable Prometheus metrics |
| `METRICS_PORT` | No | `9090` | Metrics server port |
| `QBIT_ENABLED` | No | `true` | Enable qBittorrent tool |
| `QBIT_HOST` | No | — | qBittorrent WebUI URL |
| `MISSION_CONTROL_URL` | No | — | Mission Control backend URL |
| `NOTIFICATION_SERVICE_URL` | No | — | Notification service URL |
| `WEB_SEARCH_URL` | No | — | Web search service URL |
| `LOG_LEVEL` | No | `info` | Pino log level |

## Project Structure

```
src/
├── ai/              # OllamaClient, ToolExecutor, ToolRegistry
├── clients/         # MissionControlClient, QBittorrentClient, WebSearchClient
├── commands/        # Slash command definitions and handlers
├── data/            # Tool catalog metadata
├── events/          # Discord event handlers
├── metrics/         # Prometheus metrics
├── notifications/   # Channel notification utilities (alert-ready)
├── tools/           # AI tool implementations (auto-loaded *.tool.ts)
└── utils/           # Logger, permissions
```

## Prometheus Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `discord_bot_up` | Gauge | 1=connected, 0=disconnected |
| `discord_bot_websocket_latency_seconds` | Gauge | WebSocket ping latency |
| `discord_bot_messages_processed_total` | Counter | Interactions by command and status |
| `discord_bot_request_duration_seconds` | Histogram | Command processing duration |
| `tool_executions_total` | Counter | Tool calls by name and status |
| `tool_execution_duration_seconds` | Histogram | Per-tool execution time |
| `ollama_available` | Gauge | Ollama service reachability |
| `ollama_request_duration_seconds` | Histogram | AI request latency |
| `mission_control_available` | Gauge | Mission Control reachability |
| `qbittorrent_available` | Gauge | qBittorrent reachability |

## Adding Tools

1. Create `src/tools/my-tool.tool.ts`
2. Extend `BaseTool`, implement `execute()`
3. Auto-loaded at startup — no manual registration needed

## Deployment

Pushed to `docker.pdlab.dev/pete-bot` via GitHub Actions. ArgoCD Image Updater handles digest pinning. K8s manifests live in `infrastructure/kubernetes/mission-control`. Deployed in `mission-control` namespace.
