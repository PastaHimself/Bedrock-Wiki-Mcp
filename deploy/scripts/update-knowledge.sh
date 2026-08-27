#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${BEDROCK_MCP_APP_DIR:-/opt/bedrock-wiki-mcp}"
CHECKOUT_ROOT="${BEDROCK_MCP_CHECKOUT_ROOT:-}"
INCLUDE_PREVIEW="${BEDROCK_MCP_INCLUDE_PREVIEW:-false}"
LOCK_FILE="${BEDROCK_MCP_UPDATE_LOCK:-/var/lib/bedrock-mcp/update.lock}"
NODE_BIN="${BEDROCK_MCP_NODE_BIN:-/usr/bin/node}"

if [[ ! -x "$NODE_BIN" ]]; then
  echo "Node executable not found: $NODE_BIN" >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/dist/index.js" ]]; then
  echo "Built server entrypoint not found: $APP_DIR/dist/index.js" >&2
  exit 1
fi

mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another Bedrock MCP knowledge refresh is already running." >&2
  exit 75
fi

cd "$APP_DIR"

preview_args=()
case "${INCLUDE_PREVIEW,,}" in
  1|true|yes|on)
    preview_args+=("--include-preview")
    ;;
  0|false|no|off|"")
    ;;
  *)
    echo "BEDROCK_MCP_INCLUDE_PREVIEW must be true or false." >&2
    exit 2
    ;;
esac

root_args=()
if [[ -n "$CHECKOUT_ROOT" ]]; then
  root_args+=("$CHECKOUT_ROOT")
fi

echo "Synchronizing configured Bedrock knowledge sources..."
"$NODE_BIN" dist/index.js sync-sources "${root_args[@]}" "${preview_args[@]}"

echo "Building a validated replacement index..."
"$NODE_BIN" dist/index.js rebuild-sources "${root_args[@]}" "${preview_args[@]}"

echo "Validating published index..."
"$NODE_BIN" dist/index.js validate-index

echo "Knowledge refresh completed successfully."
