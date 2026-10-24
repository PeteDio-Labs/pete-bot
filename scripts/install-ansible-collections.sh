#!/bin/sh
# Install the two collections configure-pete-bot.yml uses, inside the deploy container.
#
# Galaxy is the preferred source and is retried with a growing wait. When every attempt
# fails, the collections that ship in the PyPI `ansible` package stand in, so a Galaxy
# outage (HTTP 500 on 2026-10-24, PET-701) cannot block a deploy. The script then lists
# what is installed and fails when either collection is missing, so a fallback that
# installed nothing cannot pass.
set -eu

COLLECTIONS="community.general ansible.posix"
WAIT=5

for try in 1 2 3 4 5; do
  # shellcheck disable=SC2086
  if ansible-galaxy collection install $COLLECTIONS; then
    source=galaxy
    break
  fi
  if [ "$try" -eq 5 ]; then
    source=bundled
    break
  fi
  echo "galaxy install attempt $try failed, retrying in ${WAIT}s" >&2
  sleep "$WAIT"
  WAIT=$((WAIT * 2))
done

if [ "$source" = bundled ]; then
  echo "::warning title=deploy::Galaxy install failed 5 times. Using the collections bundled in the ansible package."
fi

listing=$(ansible-galaxy collection list 2>/dev/null)
for c in $COLLECTIONS; do
  echo "$listing" | grep -q "^$c " || {
    echo "::error title=deploy::Collection $c is not installed (source: $source)."
    exit 1
  }
done
echo "collections ready from $source:"
echo "$listing" | grep -E "^(community\.general|ansible\.posix) "
