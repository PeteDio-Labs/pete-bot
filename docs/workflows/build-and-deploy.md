# ci (build-and-deploy.yml)

Source: `.github/workflows/build-and-deploy.yml`

| | |
|---|---|
| **Trigger** | `push` and `pull_request` on `main`. |
| **Runner** | GitHub-hosted (`ubuntu-latest`) |
| **Touches** | Nothing outside the checkout. |
| **Vault** | None. |
| **Secrets** | None. |
| **Gates** | Runs lint, typecheck, `bun test`, `bun run build`, then `scripts/smoke-binary.sh`, which starts the compiled binary and checks it serves HTTP. Bun only (PET-617). It builds no image; the deploy is `deploy.yml`. Token is `contents: read`. |
| **Run it** | Open a PR. |
