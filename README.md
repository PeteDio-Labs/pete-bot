# Pete Bot

A Discord surface for the PeteDio homelab. It relays alerts and starts media updates,
and it holds no tools of its own.

**`POST /v1/alert`** takes an Uptime Kuma webhook and puts it in the owner's DM. One
message per incident, edited in place.

**`POST /v1/notify`** puts one free-text message in the same DM, for a session that has
something to tell the owner. It adds no incident state.

**`/update`** starts petedio-media-iac's update workflow and reports what the run did.

**The merge desk** merges low-risk PRs after a clean Codex review, and DMs a Merge button
for the rest (PET-645).

It asks [mtrace](https://github.com/PeteDio-Labs/petedio-media-control) nothing. `/ask`
and plain-DM questions went in PET-518, when Bobbert took over asking mtrace with its own
token. The bot reads no messages, so it requests no privileged intent.

## It is a user-installed app, not a server bot

It is installed to one Discord account and lives in no server. Commands declare
`integration_types: [1]` and the `PRIVATE_CHANNEL` context, which is what makes its
commands work in a DM with the app.

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

## The merge desk (PET-645)

The merge desk merges low-risk pull requests without a person, and asks Pedro for one tap
on the rest. It polls every open PR in `DESK_REPOS` every three minutes and decides each one
from facts GitHub reports. No model decides a merge.

| Step | What the desk checks |
|---|---|
| Is it ours? | Not a draft, not a fork, authored by someone on `DESK_AUTHORS`, aimed at the default branch, and not labelled `merge-desk/hold` |
| Tier | petedio-iac's `scripts/pr-blast-radius.py`, read from petedio-iac's default branch and run against the base repository's workflows on its default branch. A renamed file counts by both paths. Until the rules on main grade the desk's own guard paths tier 2, every PR is tier 2 |
| Codex | A review of the head SHA by `petedio-codex-review[bot]`. None yet: the desk queues `codex-review <repo> <n> <effort>` on codex-248, with `low`, `medium` or `high` for tiers 0, 1 and 2 |
| Gates | No conflict, every check run and status passed, and no unresolved review thread. A skipped or neutral check, or no check at all in a repo not on `DESK_NO_CI_REPOS`, goes to Pedro instead of merging |
| Who merges | Tiers 0 and 1 with "No blocking findings" merge here. Tier 2, or a Codex "Escalate to Pedro", arrive as a DM with a **Merge** button |

The merge is a squash pinned to the reviewed head, so a push after the review blocks it
until Codex reviews the new head. The desk approves the PR first, which satisfies a
required review and records the evidence. After the merge it reads the default branch
back, then posts one comment on the PR and one DM. Both are saved first and retried on
later polls until they land.

A tap merges only the SHA on its button, only for the owner, and only after the desk
reads every fact again. A moved head, a new thread or a red check refuses the tap and
says why.

After two blocking Codex rounds the desk stops, comments once, and DMs both reviews with a
**Review again** button that queues one more round, of the same head if nothing was pushed.
A failed Codex queue, or one cut off by a restart, gets the same button.

`DESK_MODE=dry-run` runs every step except the approval and the merge, and DMs each merge
it would have made. Use it first on a new repository. `/health` reports the desk as `off`,
`misconfigured` (with the reason), `starting` or `running`, and a running desk names the
PRs its last poll read.

What the desk needs on the host is in `.env.example`: pete-bot's own GitHub App key, an
ssh key that codex-248 forces to `codex-review-gate`, a pinned `known_hosts` for 248, and
`python3` with PyYAML for the classifier. The App needs **Contents** and **Pull requests**
write, **Checks** and **Commit statuses** read, and **Metadata** read.

## The lab tool library (PET-668)

`src/lab/tools/` holds the read-only tools that the lab-map agent's `/lab` loop (PET-669)
and the lab MCP at `pdlab.dev/mcp/lab` (PET-667) both call. Nothing in the pete-bot process
imports it: it runs in its own `lab-agent` process, never beside the desk key.

| Tool | Reads |
|---|---|
| `find_host`, `host_note` | host notes and the live inventory table from a read-only `petedio-vault` clone |
| `pve_guests`, `pve_guest` | the Proxmox API, GET only, with a `PVEAuditor` token and the cluster CA |
| `kuma_status` | Uptime Kuma's status-page JSON on Pete-Pi |
| `git_history` | commits in the iac repos by path or message text, with their PET keys |

Each tool takes a zod-checked input, returns its data with a `source` line saying what it
read, and caps its output at 16 KB. A read that fails, or that finds nothing where
something must exist, returns an error, never an empty success.

## lab-agent and /lab (PET-669)

`lab-agent` is a second binary from this repo (`bun run build:lab-binary`, entry
`src/lab/main.ts`). It runs as its own Unix user and systemd unit on 237 and listens on
`127.0.0.1:3016`.

| Route | What it does |
|---|---|
| `POST /v1/ask` | Takes `{"question": "..."}` with the ask bearer, runs the agent loop, and answers with the text, the tools it called, and the tokens it used |
| `GET /health` | One flag per dependency: gateway (an empty probe that proves the bearer and spends nothing), proxmox, vault clone, kuma. HTTP 503 unless all are up |

The loop calls Haiku through the gateway as the `lab-map` caller, with at most 8 model turns,
1,024 output tokens per turn, and an 80-second deadline per answer, inside pete-bot's 120-second
wait. The last turn offers no tools, so the model answers from what it read. A tool error
reaches the model marked as an error. An answer that hit a limit, was cut or came back empty
is marked incomplete, and `/lab` shows it in yellow. One question runs at a time; a second
gets 429.

`/lab <question>` in Discord posts to that route and relays the answer, with a footer naming
the tools, any failed reads and the tokens. pete-bot runs no model for it and gives
`lab-agent` none of its own credentials. With `LAB_ASK_TOKEN` empty, `/lab` answers "not
configured". `lab-agent` refuses to start on a missing or malformed setting.

## The nightly drift check (PET-671)

`lab-agent` compares live Proxmox guests with the vault's `Hosts/hosts-inventory.md` and the
host notes' frontmatter, once a day at `LAB_DRIFT_AT` (11:15 UTC by default). Code finds the
drift: a guest with no row or no note, a row or a note naming a guest Proxmox lacks, and a
node, state or name that disagrees. The check calls no model: the DM is the header below
plus one plain line per finding.

- Every DM leads with what the run read, such as `21 guests from Proxmox, 21 inventory rows,
  27 guest notes (petedio-vault @ 1a2b3c4)`.
- A clean run logs those counts and sends nothing.
- A failed read sends a failure DM. It never reports "no drift".
- A vault file or table row the check cannot read is a finding, listed first as `vault:`. A
  `Hosts/` file with no `type: host`, an inventory row that does not parse, and a guest note
  with no numeric `vmid` or an unknown `kind` are all reported, never skipped.
- A DM that pete-bot refuses is tried three times, with waits of 15 s and 60 s, so a restart at
  11:15 UTC does not lose the night. `/health` reports `drift` down if all three fail.
- The DM holds about 1,700 characters. Past that it drops whole lines and says how many. Every
  finding is in the run's `drift check` log line (`journalctl -u lab-agent`) and in the
  `lines` field of the `POST /v1/drift/run` answer.

The DM goes through pete-bot's `/v1/notify` with `LAB_NOTIFY_TOKEN`. To run the check
without waiting for the schedule, `POST /v1/drift/run` with the ask bearer; it DMs exactly
as the nightly run does, and returns the outcome with every finding.

## The lab MCP (PET-667)

`lab-agent` also serves the lab tools to claude.ai project threads as an MCP server, at
`https://pdlab.dev/mcp/lab` through the Cloudflare tunnel. It stays off until
`LAB_ACCESS_AUD` is set, and then every setting below must be valid.

| Setting | What it is |
|---|---|
| `LAB_MCP_HOST`, `LAB_MCP_PORT` | The LAN address and port it listens on, `192.168.50.237:3017` |
| `LAB_MCP_PEER` | The only source it accepts, the tunnel host `192.168.50.112` |
| `LAB_ACCESS_TEAM_DOMAIN`, `LAB_ACCESS_AUD` | The Access team and the lab app's AUD tag, for the JWT check |
| `LAB_ACCESS_EMAILS` | The emails it admits, comma-separated |

- **Transport:** Streamable HTTP, stateless. Each POST carries one JSON-RPC request:
  `initialize`, `ping`, `tools/list` or `tools/call`. There is no stream, no session and no
  `ask` tool, because a thread is already a model.
- **Two checks on every request:** the source address must be the tunnel host, and the
  `Cf-Access-Jwt-Assertion` JWT must verify against the team's keys, the app's AUD tag, the
  issuer, its expiry and the email list. Either failure gets 403 and runs nothing.
- **Audit:** every call logs the caller's email, the tool, its input, its outcome, its size
  and its duration to the journal.

Phase 1 adds three tools to the library for both doors:

| Tool | Reads |
|---|---|
| `desk_status` | pete-bot's `/health`: the merge desk's mode and last poll, and the gateway state |
| `systemd_status` | `systemctl show` for `pete-bot.service` and `lab-agent.service` only |
| `vault_presence` | KV v2 metadata under `kv/metadata/services/`: names, versions and times, never a value or a field name |

`vault_presence` uses a periodic token with read and list on that metadata path only.
`lab-agent` renews it twice a day. While Vault is sealed, the tool says so.
`LAB_VAULT_TOKEN` and `LAB_VAULT_CA_FILE` are required even while the MCP door is off, so
`lab-agent` starts only after `PET-670`'s seed script has minted that token.

## Quick start

```bash
bun install
cp .env.example .env  # configure DISCORD_TOKEN, DISCORD_CLIENT_ID, OWNER_USER_ID
bun dev
```

## Scripts

```bash
bun dev            # dev server (hot reload)
bun test           # run tests (Bun is the only runtime; see bunfig.toml)
bun run typecheck
bun run lint
bun run build:binary   # standalone linux-x64 executable, what the deploy ships
scripts/smoke-binary.sh   # start that binary and check it loads, as CI does
```

Bun 1.4.2 or later is required.

## Commands

| Command | What it does |
|---------|--------------|
| `/status` | Reports how many incidents are open, whether `/update` is configured, and uptime |
| `/lab <question>` | Asks lab-agent where something runs, whether it is up, or what changed (PET-669) |
| `/update check [target]` | Shows current and available versions through GitHub Actions; changes nothing |
| `/update apply <target> [force]` | Applies available updates through the same workflow. Plex skips itself while anyone is watching, unless `force` |

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
| `GET /health` | none | Liveness. Carries uptime, the number of open incidents, and the gateway state in `llm` |
| `POST /v1/alert` | alert bearer | Uptime Kuma webhook → the owner's DM |
| `POST /v1/notify` | notify bearer | `{from, message}` → one DM to the owner. Records nothing |
| `POST /v1/llm/v1/messages` | a caller's gateway bearer | The Messages API, proxied with the homelab's key. `/v1/llm/messages` is the same route |

`/v1/alert` takes a **bearer token, not HMAC**, and that is forced rather than chosen:
Kuma's generic webhook cannot sign a body. Do not "fix" this by adding HMAC and
wondering why Kuma 401s.

`/v1/notify` takes its own `NOTIFY_BEARER_TOKEN` (PET-584), and neither token opens the
other route. The notify token sits on the session hosts, so a session that can DM the owner
cannot post a fake alert. The body is `{"from": "<1–100 characters>",
"message": "<1–1800 characters>"}`, and unknown keys are ignored. The DM leads with the
sender in bold so a phone's notification preview says who is talking, and it pings no one,
whatever the text mentions. A success returns `{ok, action: "sent", channelId, messageId}`.
A bad body returns 400, and a Discord failure returns 502. The log holds the sender and the
message id, never the text.

`/v1/llm/v1/messages` is the Anthropic API gateway (PET-617). The homelab's one Anthropic key
lives in this process, and no caller holds it. A caller points the official SDK at
`http://<host>:3015/v1/llm`, with its own gateway token as `apiKey`. Each caller has a
monthly cap in dollars and a list of models, set in `LLM_GATEWAY_CALLERS`. Every answered
request goes into a SQLite ledger at `LLM_LEDGER_PATH`, with its tokens and its cost in
integer nano-dollars, and the cap reads that ledger. The gateway refuses:

- every request with 503 while it is off (no key) or misconfigured, and `/health` says which.
  A ledger path that cannot be opened makes it misconfigured
- an unknown token with 401, before the body is read
- a missing `model` or `max_tokens`, `stream: true`, a body that is not JSON, a code execution
  tool, or any parameter the gateway cannot price, with 400. `speed`, `inference_geo` and
  `service_tier` bill above the published rates, so they are refused. Streaming is not
  written yet
- a body over 8 MB with 413
- a model the caller was not given, or a caller at its cap, with 403, which the SDK does not
  retry
- a caller's third concurrent request with 429, which the SDK retries
- every request with 503 after a ledger write fails, until a restart

The cap is checked before a request, so one request can cross it, and at most two can,
since a caller may have two open. An answer whose `usage` is missing, partial or
unreadable is charged the rest of the caller's monthly cap, because nothing in a request
bounds its cost: an image by URL, a web search or a tool's system prompt bills tokens the
body does not show. The charge is in the ledger, so the caller is refused, across
restarts, until the month turns over or its cap rises. The log holds the caller, the model, the token counts and the cost, never
the prompt or the answer.

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_TOKEN` | Yes | — | Discord bot token |
| `DISCORD_CLIENT_ID` | Yes | — | Discord application client id |
| `OWNER_USER_ID` | Yes | — | The only account this app answers, and the only one it DMs |
| `HTTP_SERVER_ENABLED` | No | `true` | Serve `/health`, `/v1/alert` and `/v1/notify` |
| `HTTP_SERVER_PORT` | No | `3015` | Port for the above |
| `ALERT_BEARER_TOKEN` | No | — | Bearer token for `/v1/alert`, which Uptime Kuma sends. Empty refuses every alert |
| `NOTIFY_BEARER_TOKEN` | No | — | Bearer token for `/v1/notify`, which sessions send. Empty refuses every notify |
| `ALERT_COALESCE_MS` | No | `60000` | Grouping window; `0` disables grouping |
| `ALERT_STATE_PATH` | No | — | Open incidents on disk; empty means memory only |
| `ANTHROPIC_API_KEY` | No | — | The key the gateway forwards with. Empty leaves the gateway off |
| `LLM_GATEWAY_CALLERS` | With a key | — | JSON: caller name to `{token, monthlyCapUsd, models}`. See `.env.example` |
| `LLM_LEDGER_PATH` | With a key | — | The SQLite spend ledger. It must survive a restart |
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
been deleted, so a working command and a broken one scraped identically.

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `discord_bot_up` | Gauge | — | 1 connected, 0 disconnected |
| `discord_bot_websocket_latency_seconds` | Gauge | — | Websocket ping |
| `pete_bot_ask_total` | Counter | `surface`, `status` | Commands by surface (`update`, or the refused command) and outcome |
| `pete_bot_ask_duration_seconds` | Histogram | `surface` | Command to rendered result |
| `pete_bot_alert_dms_total` | Counter | `action`, `status` | Alerts delivered, sent vs edited |
| `pete_bot_alert_batches_open` | Gauge | — | Incidents currently open |

## Project structure

```
src/
├── clients/      # githubActions — starts and follows the /update run
├── gateway/      # the Anthropic API gateway: settings, pricing, ledger and route
├── lab/          # lab-agent (PET-669): settings, the agent loop and its HTTP surface
│   └── tools/    # the read-only lab tool library (PET-668)
├── commands/     # /status, /update and /lab definitions, and registration
├── events/       # interactionCreate (slash commands)
├── metrics/      # Prometheus registry and the metrics server
├── server/       # HTTP app, /v1/alert, /v1/notify, and the incident store
└── utils/        # logger
```

## What this used to be

An Ollama tool-calling bot for Mission Control, ArgoCD and Kubernetes. All three are torn
down, so the tool layer, the SSE event stream, the plan-expiry sweep and the HMAC-gated
Mission Control routes are gone with them. It then forwarded `/ask` and plain DMs to mtrace
until PET-518 handed that job to Bobbert.

## Deployment

On merge to `main`, `deploy.yml` compiles the standalone binary on a homelab x64 runner
and installs it to media-dash-237 by running `configure-pete-bot.yml` from
`petedio-iac`. Secrets come from Vault over GitHub OIDC. The play proves the process
reached Discord by grepping the journal for `logged in as`, because a bad token leaves
`/health` perfectly green.
