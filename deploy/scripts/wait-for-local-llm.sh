#!/usr/bin/env bash
set -euo pipefail

HEALTH_URL="${1:-http://127.0.0.1:8081/health}"
TIMEOUT_SECONDS="${2:-900}"

if ! [[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "The local model readiness timeout must be a positive number of seconds." >&2
  exit 2
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to check local model readiness." >&2
  exit 2
fi

for ((elapsed = 0; elapsed < TIMEOUT_SECONDS; elapsed += 1)); do
  if curl --fail --silent --connect-timeout 1 --max-time 2 "$HEALTH_URL" >/dev/null; then
    exit 0
  fi
  sleep 1
done

echo "Timed out after ${TIMEOUT_SECONDS}s waiting for local model readiness at ${HEALTH_URL}." >&2
exit 1
