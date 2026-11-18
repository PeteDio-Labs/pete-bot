# deploy

Source: `.github/workflows/deploy.yml`

| | |
|---|---|
| **Trigger** | `push` to `main`, `workflow_dispatch`. |
| **Runner** | Self-hosted runner on the LAN (`[self-hosted, linux, x64, homelab]`) |
| **Touches** | Compiles the pete-bot and lab-agent binaries and runs petedio-iac `configure-pete-bot.yml` against media-dash-237 (LXC 237). |
| **Vault** | OIDC role `pete-bot-cd`. Reads `kv/services/pete-bot` (Discord, alert, notify, desk App, codex-review, Plane and report-backup keys), `kv/services/pete-bot-reports-backup`, `kv/services/lab-agent`, `lab-agent-pve`, `lab-agent-plane`, `lab-agent-search`, `lab-agent-media`, and `kv/services/claude-workspace-mirror` (GitHub App). Optional paths use `ignoreNotFound`. |
| **Secrets** | None in Actions. Secrets reach the play as staged files, never arguments. |
| **Gates** | Required Vault paths fail the deploy; optional ones may be absent but a 403 still fails. No long-lived SSH key: the job signs a 30-minute certificate as Vault SSH role `deploy-pete-bot`, valid for root on 237 only and only from the runners, then revokes its token. The play refuses a deploy that would drop an installed token. One deploy at a time (`deploy-pete-bot`). |
| **Run it** | Merge to `main`, or `gh workflow run deploy.yml --ref main`. |

Every merge to `main` deploys. Treat a red deploy as blocking further merges until it passes.
