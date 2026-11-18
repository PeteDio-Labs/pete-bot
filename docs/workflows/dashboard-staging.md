# dashboard-staging

Source: `.github/workflows/dashboard-staging.yml`

| | |
|---|---|
| **Trigger** | `push` to `dashboard-staging` or `main`, path filtered to `dashboard/**`. |
| **Runner** | GitHub-hosted (`ubuntu-latest`) |
| **Touches** | Replaces two assets on the `dashboard-staging` release: `dashboard-dist.tar.gz` and its `.sha256`. The archive holds `build.json`, which names the commit, and the release notes name it too. The release tag does not move. |
| **Vault** | None. |
| **Secrets** | Repo variable `STAGING_DASHBOARD_FEED`; `github.token` with `contents: write`. |
| **Gates** | Builds with install scripts off and fixtures included, so staging reads no lab data. Fails on an empty build and prints file count and checksum. The staging host (CT 249) downloads the asset and checks the checksum; it runs no branch code. Group `dashboard-staging`. |
| **Run it** | Push to `dashboard-staging`. |
