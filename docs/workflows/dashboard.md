# dashboard

Source: `.github/workflows/dashboard.yml`

| | |
|---|---|
| **Trigger** | `pull_request` and `push` on `main`, path filtered to `dashboard/**`. |
| **Runner** | GitHub-hosted (`ubuntu-latest`) |
| **Touches** | Nothing outside the checkout. |
| **Vault** | None. |
| **Secrets** | None. |
| **Gates** | Typecheck, tests, build and `test:a11y`. The a11y script exits non-zero when it ran too few axe checks, so a browser that never started cannot pass. |
| **Run it** | Open a PR that touches `dashboard/`. |
