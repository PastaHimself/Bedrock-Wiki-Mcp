#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${BEDROCK_MCP_APP_DIR:-/opt/bedrock-wiki-mcp}"
CHECKOUT_ROOT="${BEDROCK_MCP_CHECKOUT_ROOT:-}"
INCLUDE_PREVIEW="${BEDROCK_MCP_INCLUDE_PREVIEW:-false}"
SEMANTIC_ENABLED="${BEDROCK_MCP_SEMANTIC_ENABLED:-false}"
DATA_DIR="${BEDROCK_MCP_DATA_DIR:-/var/lib/bedrock-mcp}"
BACKUP_RETAIN="${BEDROCK_MCP_BACKUP_RETAIN:-7}"
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

if [[ ! "$BACKUP_RETAIN" =~ ^[0-9]+$ ]] || (( BACKUP_RETAIN < 1 || BACKUP_RETAIN > 365 )); then
  echo "BEDROCK_MCP_BACKUP_RETAIN must be an integer from 1 to 365." >&2
  exit 2
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

build_semantic=false
case "${SEMANTIC_ENABLED,,}" in
  1|true|yes|on)
    build_semantic=true
    ;;
  0|false|no|off|"")
    ;;
  *)
    echo "BEDROCK_MCP_SEMANTIC_ENABLED must be true or false." >&2
    exit 2
    ;;
esac

root_args=()
if [[ -n "$CHECKOUT_ROOT" ]]; then
  root_args+=("$CHECKOUT_ROOT")
fi

if [[ -f "$DATA_DIR/index/bedrock.db" ]]; then
  echo "Backing up the currently published index..."
  "$NODE_BIN" dist/index.js backup "--retain=$BACKUP_RETAIN"
else
  echo "No existing lexical index found; skipping pre-refresh backup."
fi

echo "Synchronizing configured Bedrock knowledge sources..."
"$NODE_BIN" dist/index.js sync-sources "${root_args[@]}" "${preview_args[@]}"

echo "Building a validated replacement index..."
"$NODE_BIN" dist/index.js rebuild-sources "${root_args[@]}" "${preview_args[@]}"

echo "Validating published lexical index..."
"$NODE_BIN" dist/index.js validate-index

if [[ "$build_semantic" == true ]]; then
  echo "Building semantic index for the published lexical index..."
  "$NODE_BIN" dist/index.js build-semantic-index
fi

echo "Knowledge refresh completed successfully."
