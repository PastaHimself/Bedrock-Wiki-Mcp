#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/bedrock-wiki-mcp"
CONFIG_FILE="/etc/bedrock-mcp/bedrock-mcp.env"
SERVICE_USER="bedrock-mcp"
PUBLIC_URL="${BEDROCK_MCP_PUBLIC_URL:-}"
REQUIRE_CLOUDFLARED="${BEDROCK_MCP_REQUIRE_CLOUDFLARED:-false}"

log() {
  printf '[bedrock-mcp-verify] %s\n' "$*"
}

fail() {
  printf '[bedrock-mcp-verify] ERROR: %s\n' "$*" >&2
  exit 1
}

pass() {
  printf '[bedrock-mcp-verify] PASS: %s\n' "$*"
}

read_env_value() {
  local key="$1"
  local line
  line="$(grep -E "^${key}=" "$CONFIG_FILE" | tail -n 1 || true)"
  if [[ -z "$line" ]]; then
    return 0
  fi
  local value="${line#*=}"
  if [[ "$value" == \"* || "$value" == \'* ]]; then
    fail "$CONFIG_FILE must use the repository's unquoted KEY=value format for $key"
  fi
  printf '%s' "$value"
}

[[ "${EUID}" -eq 0 ]] || fail "run this script as root (sudo)"
[[ -r "$CONFIG_FILE" ]] || fail "cannot read $CONFIG_FILE"
[[ -x /usr/bin/node ]] || fail "/usr/bin/node is missing"

NODE_MAJOR="$(/usr/bin/node --version | sed -E 's/^v([0-9]+).*/\1/')"
[[ "$NODE_MAJOR" == "24" ]] || fail "Node.js 24 is required; found $(/usr/bin/node --version)"
pass "Node.js major version is 24"

HOST="$(read_env_value BEDROCK_MCP_HOST)"
PORT="$(read_env_value BEDROCK_MCP_PORT)"
PORT="${PORT:-8080}"
DATA_DIR="$(read_env_value BEDROCK_MCP_DATA_DIR)"
ALLOWED_HOSTS="$(read_env_value BEDROCK_MCP_ALLOWED_HOSTS)"
TRUSTED_PROXIES="$(read_env_value BEDROCK_MCP_TRUSTED_PROXY_IPS)"
SEMANTIC_ENABLED="$(read_env_value BEDROCK_MCP_SEMANTIC_ENABLED)"
SEMANTIC_ENABLED="${SEMANTIC_ENABLED:-false}"
MIN_FREE_BYTES="$(read_env_value BEDROCK_MCP_MIN_FREE_BYTES)"
MIN_FREE_BYTES="${MIN_FREE_BYTES:-2147483648}"
BEARER_TOKEN="$(read_env_value BEDROCK_MCP_BEARER_TOKEN)"
PRIMARY_HOST="${ALLOWED_HOSTS%%,*}"
PRIMARY_HOST="${PRIMARY_HOST#"${PRIMARY_HOST%%[![:space:]]*}"}"
PRIMARY_HOST="${PRIMARY_HOST%"${PRIMARY_HOST##*[![:space:]]}"}"

[[ "$DATA_DIR" == "/var/lib/bedrock-mcp" ]] || fail "systemd profile requires BEDROCK_MCP_DATA_DIR=/var/lib/bedrock-mcp"
[[ "$HOST" == "127.0.0.1" ]] || fail "small-VPS profile must bind to 127.0.0.1; found '$HOST'"
[[ "$PORT" =~ ^[0-9]+$ && "$PORT" -ge 1 && "$PORT" -le 65535 ]] || fail "invalid port '$PORT'"
[[ -n "$PRIMARY_HOST" ]] || fail "BEDROCK_MCP_ALLOWED_HOSTS must contain the public MCP hostname"
[[ "$TRUSTED_PROXIES" == "127.0.0.1" ]] || fail "direct Cloudflare Tunnel profile requires BEDROCK_MCP_TRUSTED_PROXY_IPS=127.0.0.1"
[[ "$SEMANTIC_ENABLED" == "false" ]] || fail "small-VPS verification requires semantic retrieval to remain disabled"
[[ "$MIN_FREE_BYTES" =~ ^[0-9]+$ ]] || fail "BEDROCK_MCP_MIN_FREE_BYTES must be an integer"
pass "deployment environment matches the lexical-only loopback profile"

systemctl is-active --quiet bedrock-mcp.service || fail "bedrock-mcp.service is not active"
systemctl is-enabled --quiet bedrock-mcp.service || fail "bedrock-mcp.service is not enabled"
systemctl is-active --quiet bedrock-mcp-update.timer || fail "bedrock-mcp-update.timer is not active"
systemctl is-enabled --quiet bedrock-mcp-update.timer || fail "bedrock-mcp-update.timer is not enabled"
pass "server service and update timer are active and enabled"

SOCKETS="$(ss -H -ltn "sport = :$PORT" | awk '{print $4}')"
[[ -n "$SOCKETS" ]] || fail "nothing is listening on TCP port $PORT"
while IFS= read -r socket; do
  [[ "$socket" == "127.0.0.1:$PORT" ]] || fail "unexpected listener '$socket'; expected only 127.0.0.1:$PORT"
done <<<"$SOCKETS"
pass "TCP listener is loopback-only on 127.0.0.1:$PORT"

HEALTH_BODY="$(curl --fail --silent --show-error "http://127.0.0.1:$PORT/health")" || fail "localhost /health request failed"
[[ "$HEALTH_BODY" == *'"status":"ok"'* ]] || fail "localhost /health did not report status=ok"
pass "localhost /health is healthy"

STATUS_JSON="$(runuser -u "$SERVICE_USER" -- env \
  BEDROCK_MCP_DATA_DIR="$DATA_DIR" \
  BEDROCK_MCP_SEMANTIC_ENABLED=false \
  /usr/bin/node "$APP_DIR/dist/index.js" status --json)" || fail "index status command failed"
STATUS_COMPACT="$(printf '%s' "$STATUS_JSON" | tr -d '[:space:]')"
[[ "$STATUS_COMPACT" == *'"ok":true'* ]] || fail "published lexical index did not validate successfully"
[[ "$STATUS_COMPACT" == *'"indexBytes":'* ]] || fail "published lexical index size was not reported"
pass "published lexical index validates successfully"

MCP_BODY='{"jsonrpc":"2.0","method":"initialize","params":{"clientInfo":{"name":"production-verifier","version":"1.0.0"},"protocolVersion":"2025-06-18","capabilities":{}},"id":"verify-1"}'

check_mcp() {
  local base_url="$1"
  local label="$2"
  local host_header="${3:-}"
  local output
  output="$(mktemp)"
  local headers=(
    -H 'accept: application/json, text/event-stream'
    -H 'content-type: application/json'
  )
  if [[ -n "$host_header" ]]; then
    headers+=( -H "Host: $host_header" )
  fi
  if [[ -n "$BEARER_TOKEN" ]]; then
    headers+=( -H "Authorization: Bearer $BEARER_TOKEN" )
  fi

  local code
  if ! code="$(curl --silent --show-error \
    --output "$output" \
    --write-out '%{http_code}' \
    "${headers[@]}" \
    --data "$MCP_BODY" \
    "${base_url%/}/mcp")"; then
    rm -f -- "$output"
    fail "$label /mcp initialize request failed"
  fi
  [[ "$code" == "200" ]] || {
    rm -f -- "$output"
    fail "$label /mcp initialize returned HTTP $code"
  }
  grep -q 'bedrock-wiki-mcp' "$output" || {
    rm -f -- "$output"
    fail "$label /mcp initialize response did not identify the server"
  }
  rm -f -- "$output"
  pass "$label /mcp initialize succeeds"
}

check_mcp "http://127.0.0.1:$PORT" "localhost" "$PRIMARY_HOST"

AVAILABLE_BYTES="$(df -B1 --output=avail "$DATA_DIR" | tail -n 1 | tr -d '[:space:]')"
[[ "$AVAILABLE_BYTES" =~ ^[0-9]+$ ]] || fail "could not determine free disk space"
(( AVAILABLE_BYTES >= MIN_FREE_BYTES )) || fail "free disk space $AVAILABLE_BYTES is below configured reserve $MIN_FREE_BYTES"
pass "free disk space is above the configured reserve"

if [[ "$REQUIRE_CLOUDFLARED" == "true" ]]; then
  systemctl is-active --quiet cloudflared.service || fail "cloudflared.service is not active"
  systemctl is-enabled --quiet cloudflared.service || fail "cloudflared.service is not enabled"
  pass "cloudflared service is active and enabled"
elif [[ "$REQUIRE_CLOUDFLARED" != "false" ]]; then
  fail "BEDROCK_MCP_REQUIRE_CLOUDFLARED must be true or false"
fi

if [[ -n "$PUBLIC_URL" ]]; then
  PUBLIC_URL="${PUBLIC_URL%/}"
  [[ "$PUBLIC_URL" == "https://$PRIMARY_HOST" ]] || \
    fail "BEDROCK_MCP_PUBLIC_URL must be exactly https://$PRIMARY_HOST for this profile"
  PUBLIC_HEALTH="$PUBLIC_URL/health"
  curl --fail --silent --show-error "$PUBLIC_HEALTH" >/dev/null || fail "public health check failed: $PUBLIC_HEALTH"
  pass "public HTTPS /health succeeds"
  check_mcp "$PUBLIC_URL" "public HTTPS"
fi

log "all requested production checks passed"
