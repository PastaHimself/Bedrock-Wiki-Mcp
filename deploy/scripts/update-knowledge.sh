#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${BEDROCK_MCP_APP_DIR:-/opt/bedrock-wiki-mcp}"
CHECKOUT_ROOT="${BEDROCK_MCP_CHECKOUT_ROOT:-}"
INCLUDE_PREVIEW="${BEDROCK_MCP_INCLUDE_PREVIEW:-false}"
SEMANTIC_ENABLED="${BEDROCK_MCP_SEMANTIC_ENABLED:-false}"
DATA_DIR="${BEDROCK_MCP_DATA_DIR:-/var/lib/bedrock-mcp}"
BACKUP_RETAIN="${BEDROCK_MCP_BACKUP_RETAIN:-7}"
MIN_FREE_BYTES="${BEDROCK_MCP_MIN_FREE_BYTES:-2147483648}"
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

if [[ ! "$MIN_FREE_BYTES" =~ ^[0-9]{1,13}$ ]] || (( MIN_FREE_BYTES > 1099511627776 )); then
  echo "BEDROCK_MCP_MIN_FREE_BYTES must be an integer from 0 to 1099511627776." >&2
  exit 2
fi

mkdir -p "$DATA_DIR"
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another Bedrock MCP knowledge refresh is already running." >&2
  exit 75
fi

cd "$APP_DIR"

file_size_bytes() {
  local path="$1"
  if [[ -f "$path" ]]; then
    stat -c '%s' -- "$path"
  else
    printf '0\n'
  fi
}

available_bytes() {
  local value
  value="$(df -B1 --output=avail "$DATA_DIR" | tail -n 1 | tr -d '[:space:]')"
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "Could not determine available bytes for $DATA_DIR." >&2
    exit 1
  fi
  printf '%s\n' "$value"
}

require_free_space() {
  local stage="$1"
  local peak_extra_bytes="$2"
  local available required
  available="$(available_bytes)"
  required=$((MIN_FREE_BYTES + peak_extra_bytes))
  if (( available < required )); then
    echo "Insufficient free disk space $stage: ${available} bytes available, ${required} required (${MIN_FREE_BYTES} reserve + ${peak_extra_bytes} estimated operation headroom)." >&2
    exit 28
  fi
}

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

LEXICAL_PATH="$DATA_DIR/index/bedrock.db"
SEMANTIC_PATH="$DATA_DIR/index/semantic.db"
lexical_bytes="$(file_size_bytes "$LEXICAL_PATH")"
semantic_bytes="$(file_size_bytes "$SEMANTIC_PATH")"
backup_peak_bytes=$((lexical_bytes + semantic_bytes))
replacement_peak_bytes=$((lexical_bytes + lexical_bytes / 2))
refresh_peak_bytes="$backup_peak_bytes"
if (( replacement_peak_bytes > refresh_peak_bytes )); then
  refresh_peak_bytes="$replacement_peak_bytes"
fi
require_free_space "before refresh" "$refresh_peak_bytes"

if [[ -f "$LEXICAL_PATH" ]]; then
  echo "Backing up the currently published index..."
  "$NODE_BIN" dist/index.js backup "--retain=$BACKUP_RETAIN"
else
  echo "No existing lexical index found; skipping pre-refresh backup."
fi

require_free_space "after backup" "$replacement_peak_bytes"

echo "Synchronizing configured Bedrock knowledge sources..."
"$NODE_BIN" dist/index.js sync-sources "${root_args[@]}" "${preview_args[@]}"

lexical_bytes="$(file_size_bytes "$LEXICAL_PATH")"
replacement_peak_bytes=$((lexical_bytes + lexical_bytes / 2))
require_free_space "before lexical rebuild" "$replacement_peak_bytes"

echo "Building a validated replacement index..."
"$NODE_BIN" dist/index.js rebuild-sources "${root_args[@]}" "${preview_args[@]}"

echo "Validating published lexical index..."
"$NODE_BIN" dist/index.js validate-index

if [[ "$build_semantic" == true ]]; then
  semantic_bytes="$(file_size_bytes "$SEMANTIC_PATH")"
  semantic_peak_bytes=$((semantic_bytes + semantic_bytes / 2))
  require_free_space "before semantic rebuild" "$semantic_peak_bytes"
  echo "Building semantic index for the published lexical index..."
  "$NODE_BIN" dist/index.js build-semantic-index
fi

echo "Knowledge refresh completed successfully."
