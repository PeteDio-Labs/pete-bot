#!/usr/bin/env bash
# Start the compiled binary and prove it loaded every module.
#
# WHY. CI's tests run the source under `bun test`; the deploy ships a compiled binary.
# PET-617's first draft built a binary that crashed at startup, before any log line, on a
# module the CI Bun lacked, and every check stayed green because none ran the binary.
#
# HOW. There is no Discord in CI, so the login fails and the process exits. What it does
# before that is the proof: the HTTP server listens, and the failure it exits on is the
# login, not a missing module.
set -euo pipefail

bin=$(realpath "${1:-dist/pete-bot}")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
log="$work/log"

# Every token here is a placeholder: nothing in CI can reach Discord.
# Run from $work, so neither the binary nor dotenv picks up a .env from the checkout.
(
  cd "$work"
  env -i PATH="$PATH" HOME="$work" \
    DISCORD_TOKEN=smoke-discord-token \
    DISCORD_CLIENT_ID=000000000000000000 \
    OWNER_USER_ID=111111111111111111 \
    HTTP_SERVER_ENABLED=true \
    HTTP_SERVER_PORT=13015 \
    ALERT_BEARER_TOKEN=smoke-alert-token \
    NOTIFY_BEARER_TOKEN=smoke-notify-token \
    METRICS_ENABLED=false \
    LOG_LEVEL=info \
    timeout 30 "$bin"
) >"$log" 2>&1 || true

fail() {
  echo "smoke: $1" >&2
  echo "--- binary output ---" >&2
  cat "$log" >&2
  exit 1
}

grep -q '\[HTTP\] Listening' "$log" || fail 'the HTTP server did not start'
grep -q 'Failed to start bot' "$log" || fail 'the binary did not reach the Discord login'
grep -qi 'no such built-in module\|cannot find module\|cannot find package' "$log" && fail 'a module failed to load'
echo 'smoke: the binary loaded, served HTTP, and stopped at the Discord login'
