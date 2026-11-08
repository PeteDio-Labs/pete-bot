# pete-bot (agent context)

The Discord surface and the merge desk for the PeteDio homelab. It also builds `lab-agent` and
the lab MCP from the same tree. `README.md` covers the endpoints, the environment variables and
each subsystem; this file holds only the rules. The repo is `pete-bot`, not `petedio-pete-bot`.

- **Bun only,** with native `fetch`. Never npm, yarn, pnpm or axios. Before you push, run
  `bun run typecheck`, `bun run lint` and `bun test`; CI runs all three.
- **Build binaries with `--target=bun-linux-x64`** (`bun run build:binary`,
  `bun run build:lab-binary`). A Mac build is arm64 and does not run on 237.
- **Discord carries alerts only.** `/v1/alert` and `/v1/notify` are the sanctioned DMs. The desk
  DMs stay off unless `DESK_DM=on` (`pete-bot#101`). Do not add a channel that pings Pedro for
  routine status.
- **The merge desk decides from facts GitHub reports.** No model decides a merge. A tier comes
  from `scripts/pr-blast-radius.py` in `petedio-iac`. The Qwen fallback follows section 5 of the
  vault's working agreement, and Codex grades of Qwen go to a separate store only. Keep `src/desk/` tests
  passing; they guard the gate.
- **Never log a token, a query's text or a DM's body.** Log lengths and ids.
- **Secrets come from Vault at deploy time** through `deploy.yml` (OIDC). Write a new secret as
  an optional step with a path by reference, and never place a value in code, tests or a PR.
- **Deploy through CI.** `deploy.yml` runs on the self-hosted `[self-hosted, linux, x64,
  homelab]` runner and deploys to 237. Do not use a Mac deploy script.
- **Tests stay offline.** Fake Discord, GitHub, Ollama and lab clients; CI has no route to the lab.
- **A green check is not proof.** A job that reports success after it examined nothing is this
  lab's recurring bug. Make a failure path exit non-zero, and print what the job examined.
- **Plane changes go through `petedio-pm`.** This repo's own Plane token serves the reports
  only. A thread queues a Plane change in `petedio-pm/queue/pending/`.
- **Merges follow the gate** in the vault's working agreement, section 5. A thread opens a PR
  and follows the workspace `full-send` skill. Write prose in Google developer documentation style.
