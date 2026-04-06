# Pete Bot

Ollama-powered AI Discord bot for PeteDio homelab. Provides slash commands with an extensible tool-calling loop for infrastructure management, search, and general queries. Responses are delivered via DM.

## Quick Start

```bash
bun install
cp .env.example .env  # configure DISCORD_TOKEN, DISCORD_CLIENT_ID, ALLOWED_USER_IDS
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

Pushed to `docker.toastedbytes.com/pete-bot` via GitHub Actions. ArgoCD Image Updater handles digest pinning. K8s manifests live in `infrastructure/kubernetes/mission-control`. Deployed in `mission-control` namespace.
