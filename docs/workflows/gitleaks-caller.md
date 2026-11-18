# gitleaks-caller

Source: `.github/workflows/gitleaks-caller.yml`

| | |
|---|---|
| **Trigger** | `pull_request`, weekly `schedule` (Monday 09:17 UTC), `workflow_dispatch`. |
| **Runner** | Hosted, via petedio-iac `gitleaks.yml`. |
| **Touches** | Scans the commits a PR adds (`pr`) or every ref (`full`). |
| **Vault** | None. |
| **Secrets** | None. |
| **Gates** | The `uses` line pins a petedio-iac commit SHA; bump it to take a newer scan. Rules live in petedio-iac `.github/gitleaks.toml`. A false positive goes in this repo's `.gitleaksignore` by fingerprint. A scan that reads zero commits is red. |
| **Run it** | `gh workflow run gitleaks-caller.yml`. |
