# Pete Bot

A Discord surface for the PeteDio homelab. It holds no tools of its own.

**Type at it in the DM, or use `/ask <question>`.** Either forwards to
[mtrace](https://github.com/PeteDio-Labs/petedio-media-control) on media-dash-237 and
renders the answer. mtrace owns the tool set and the routing, including the
deterministic keyword router that answers when Ollama is unreachable — so the CLI and
Discord cannot disagree about the same stack.

**`POST /v1/alert`** takes an Uptime Kuma webhook and puts it in the owner's DM. One
message per incident, edited in place.

> ⚠ **Plain messages need the Message Content intent**, which is privileged: enable it in
> the Developer Portal under **Bot → Privileged Gateway Intents**. Requesting it while it
> is disabled makes login fail outright, which the deploy's login check catches. With it
> off but not requested, `content` arrives empty and the bot appears to ignore you —
> which is why it answers that case explicitly instead of staying quiet.

## It is a user-installed app, not a server bot

It is installed to one Discord account and lives in no server. Commands declare
`integration_types: [1]` and the `PRIVATE_CHANNEL` context, which is what makes `/ask`
work in a DM with the app.

An app in zero servers **can** start a DM. Verified 2026-09-09 against a 0-guild account
with no prior contact: `users.fetch(id).createDM().send()` succeeded. The documentation
never promises this, so read it as measured rather than guaranteed.

## One message per incident

Uptime Kuma watches 19 monitors and re-notifies on an interval. Posting a DM per
heartbeat produces a channel you mute, and a muted channel is how a nine-and-a-half-hour
Vault outage reached nobody (PET-374). So `/v1/alert` groups:

| What arrives | What happens |
|---|---|
| A monitor goes down | A DM is sent, and its message id is remembered |
| The same monitor is still down | The **existing** message is edited, with a check count |
| Another monitor fails inside `ALERT_COALESCE_MS` | It joins that message — a node reboot is one DM |
| A monitor fails after the window | A **new** message, because an edit notifies nobody |
| A monitor recovers | Its line turns green; the message closes when all recover |

Open incidents live in `ALERT_STATE_PATH`, so a restart between the failure and the
recovery still edits the original message instead of orphaning it.

## Answers are paged, never truncated

An answer longer than one embed is split across sequential embeds. mtrace's long answers
are its deep ones — a trace crossing six hosts over SSH — and a trace states its
conclusion last, so cutting the tail throws away the answer and keeps the preamble.

Every reply footers with how long it took, split:

```
routed by keyword · 6.8s (route 1ms, tool 6770ms)
```

Route and tool are reported separately because they fail for different reasons. A slow
route means the inference host is busy or asleep; a slow tool means the media stack is.

## Quick start

```bash
bun install
cp .env.example .env  # configure DISCORD_TOKEN, DISCORD_CLIENT_ID, OWNER_USER_ID
bun dev
```

## Scripts

```bash
bun dev            # dev server (hot reload)
bun test           # run tests
bun run typecheck
bun run lint
bun run build:binary   # standalone linux-x64 executable, what the deploy ships
```

## Commands

| Command | What it does |
|---------|--------------|
| `/ask <question>` | Forwards the question to mtrace and renders the answer, ephemerally |
| `/status` | Reports whether mtrace is reachable, how many incidents are open, and uptime |
| `/update check [target]` | Shows current and available versions through GitHub Actions; changes nothing |
| `/update apply <target> [force]` | Applies available updates through the same workflow. Plex skips itself while anyone is watching, unless `force` |

A plain DM does the same thing as `/ask`, without the slash.

### `/update` (PET-395)

`/update` holds no access to the media hosts. It starts petedio-media-iac's
`media-updates.yml` with a token that can run workflows in that one repo, follows the run,
and shows the report the run printed. The run mints its own narrow Vault role and runs
Ansible from a homelab runner.

Targets are `plex`, `sonarr`, `radarr`, `prowlarr`, `arr` (all three), and `plex-and-arr`,
the default for `check`. Each result says how the run ended: green when nothing is left to
do, yellow for an available update or a service that skipped itself, and red for a failure.
A run that never appears, or is still going after 30 minutes, says so. Past Discord's
15-minute interaction token, the result arrives as a DM.

To enable it:

1. Create a fine-grained token limited to `PeteDio-Labs/petedio-media-iac`, with
   **Actions** read and write.
2. Store it in Vault without it reaching your shell history:

   ```bash
   read -rs T; printf '%s' "$T" | vault kv patch kv/services/pete-bot github_updates_token=-; unset T
   ```

3. Deploy. An empty token leaves `/update` answering that it is not configured.

## HTTP surface

Port 3015, separate from the metrics port so app traffic cannot affect a scrape.

| Route | Auth | What it does |
|-------|------|--------------|
| `GET /health` | none | Liveness. Carries uptime and the number of open incidents |
| `POST /v1/alert` | bearer | Uptime Kuma webhook → the owner's DM |

`/v1/alert` takes a **bearer token, not HMAC**, and that is forced rather than chosen:
Kuma's generic webhook cannot sign a body. Do not "fix" this by adding HMAC and
wondering why Kuma 401s.

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_TOKEN` | Yes | — | Discord bot token |
| `DISCORD_CLIENT_ID` | Yes | — | Discord application client id |
| `OWNER_USER_ID` | Yes | — | The only account this app answers, and the only one it DMs |
| `MTRACE_URL` | No | `http://127.0.0.1:8237` | mtrace on the same host, over loopback |
| `MTRACE_API_TOKEN` | No | — | Bearer for mtrace's `/api` routes |
| `MTRACE_TIMEOUT_MS` | No | `60000` | `fetch` has no default timeout; this is the bound |
| `HTTP_SERVER_ENABLED` | No | `true` | Serve `/health` and `/v1/alert` |
| `HTTP_SERVER_PORT` | No | `3015` | Port for the above |
| `ALERT_BEARER_TOKEN` | No | — | Token Uptime Kuma sends on `/v1/alert` |
| `ALERT_COALESCE_MS` | No | `60000` | Grouping window; `0` disables grouping |
| `ALERT_STATE_PATH` | No | — | Open incidents on disk; empty means memory only |
| `GITHUB_UPDATES_TOKEN` | No | — | Token `/update` dispatches with; empty leaves `/update` saying it is not configured |
| `UPDATES_REPO` | No | `PeteDio-Labs/petedio-media-iac` | Repo that holds the update workflow |
| `UPDATES_WORKFLOW` | No | `media-updates.yml` | The workflow `/update` dispatches |
| `UPDATES_FIND_TIMEOUT_MS` | No | `90000` | How long a dispatched run may take to appear |
| `UPDATES_RUN_TIMEOUT_MS` | No | `1800000` | How long `/update` follows a run |
| `UPDATES_POLL_MS` | No | `10000` | How often it asks GitHub about the run |
| `METRICS_ENABLED` | No | `true` | Serve `/metrics` |
| `METRICS_PORT` | No | `9090` | Port for `/metrics` |
| `LOG_LEVEL` | No | `info` | Pino log level |

## Metrics

Every series below has a write site, and a test asserts the registry holds these and
only these — five metrics once shipped for months describing an event stream that had
been deleted, so a working `/ask` and a broken one scraped identically.

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `discord_bot_up` | Gauge | — | 1 connected, 0 disconnected |
| `discord_bot_websocket_latency_seconds` | Gauge | — | Websocket ping |
| `pete_bot_ask_total` | Counter | `surface`, `status` | Questions by surface (`ask`/`dm`) and outcome |
| `pete_bot_ask_duration_seconds` | Histogram | `surface` | Question to rendered answer |
| `pete_bot_alert_dms_total` | Counter | `action`, `status` | Alerts delivered, sent vs edited |
| `pete_bot_alert_batches_open` | Gauge | — | Incidents currently open |

## Project structure

```
src/
├── clients/      # mtraceClient — ask() and health(), the only thing it knows how to call
├── commands/     # /ask and /status definitions, and registration
├── events/       # interactionCreate (slash), messageCreate (plain DMs)
├── metrics/      # Prometheus registry and the metrics server
├── server/       # HTTP app, /v1/alert, and the incident store
└── utils/        # logger, answer paging, typing keepalive, the footer
```

## What this used to be

An Ollama tool-calling bot for Mission Control, ArgoCD and Kubernetes. All three are torn
down, so the tool layer, the SSE event stream, the plan-expiry sweep and the HMAC-gated
Mission Control routes are gone with them.

## Deployment

On merge to `main`, `deploy.yml` compiles the standalone binary on a homelab x64 runner
and installs it to media-dash-237 by running `configure-pete-bot.yml` from
`petedio-iac`. Secrets come from Vault over GitHub OIDC. The play proves the process
reached Discord by grepping the journal for `logged in as`, because a bad token leaves
`/health` perfectly green.
