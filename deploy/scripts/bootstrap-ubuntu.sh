#!/usr/bin/env bash
set -euo pipefail

# These paths intentionally match the supplied hardened systemd units. Supporting
# arbitrary locations would require regenerating ReadOnlyPaths/ReadWritePaths too.
APP_DIR="/opt/bedrock-wiki-mcp"
DATA_DIR="/var/lib/bedrock-mcp"
CONFIG_DIR="/etc/bedrock-mcp"
SERVICE_USER="bedrock-mcp"
PUBLIC_HOSTNAME="${BEDROCK_MCP_PUBLIC_HOSTNAME:-}"
BEARER_TOKEN="${BEDROCK_MCP_BEARER_TOKEN:-}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
STAGE_DIR=""
SOURCE_USER="${SUDO_USER:-$(stat -c '%U' "$REPO_ROOT")}"

log() {
  printf '[bedrock-mcp-bootstrap] %s\n' "$*"
}

fail() {
  printf '[bedrock-mcp-bootstrap] ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$STAGE_DIR" && -d "$STAGE_DIR" ]]; then
    rm -rf -- "$STAGE_DIR"
  fi
}
trap cleanup EXIT

[[ "${EUID}" -eq 0 ]] || fail "run this script as root (sudo)"
[[ -r /etc/os-release ]] || fail "cannot identify the operating system"
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || fail "this bootstrap supports Ubuntu only"

export DEBIAN_FRONTEND=noninteractive
log "installing base packages"
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git gnupg iproute2 util-linux

install_node_24() {
  local current_major=""
  if [[ -x /usr/bin/node ]]; then
    current_major="$(/usr/bin/node --version | sed -E 's/^v([0-9]+).*/\1/')"
  fi
  if [[ "$current_major" == "24" ]]; then
    return
  fi

  local arch
  arch="$(dpkg --print-architecture)"
  [[ "$arch" == "amd64" || "$arch" == "arm64" ]] || \
    fail "NodeSource Node.js 24 packages support amd64/arm64 here; found $arch"

  log "installing Node.js 24 from the NodeSource signed APT repository"
  install -d -m 0755 /etc/apt/keyrings
  local key_tmp
  key_tmp="$(mktemp)"
  curl --fail --silent --show-error --location \
    https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    --output "$key_tmp"
  gpg --batch --yes --dearmor --output /etc/apt/keyrings/nodesource.gpg "$key_tmp"
  rm -f -- "$key_tmp"
  chmod 0644 /etc/apt/keyrings/nodesource.gpg

  cat >/etc/apt/sources.list.d/nodesource.list <<EOF
deb [arch=$arch signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main
EOF
  apt-get update
  apt-get install -y --no-install-recommends nodejs
}

run_source_git() {
  if [[ "$SOURCE_USER" == "root" ]]; then
    git "$@"
  else
    id "$SOURCE_USER" >/dev/null 2>&1 || fail "source checkout owner '$SOURCE_USER' is not a local user"
    runuser -u "$SOURCE_USER" -- git "$@"
  fi
}

install_node_24
NODE_MAJOR="$(/usr/bin/node --version | sed -E 's/^v([0-9]+).*/\1/')"
[[ "$NODE_MAJOR" == "24" ]] || fail "Node.js 24 is required; found $(/usr/bin/node --version)"
[[ -x /usr/bin/npm ]] || fail "/usr/bin/npm was not installed with Node.js"
command -v git >/dev/null 2>&1 || fail "git is required"

# The bootstrap itself runs as root, but the source checkout is normally owned by
# the sudo caller. Run Git as that user rather than weakening Git safe.directory.
run_source_git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || \
  fail "run this script from a Git checkout"
[[ -z "$(run_source_git -C "$REPO_ROOT" status --porcelain)" ]] || \
  fail "source checkout is not clean; commit/stash changes before deploying"
DEPLOY_SHA="$(run_source_git -C "$REPO_ROOT" rev-parse HEAD)"
log "deploying repository revision $DEPLOY_SHA"

if ! getent passwd "$SERVICE_USER" >/dev/null; then
  useradd --system \
    --home-dir "$DATA_DIR" \
    --create-home \
    --shell /usr/sbin/nologin \
    "$SERVICE_USER"
fi

install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$DATA_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$DATA_DIR/models/huggingface"
[[ ! -L "$CONFIG_DIR" ]] || fail "refusing symlinked configuration directory: $CONFIG_DIR"
install -d -o root -g "$SERVICE_USER" -m 0750 "$CONFIG_DIR"
install -d -o root -g root -m 0755 "$(dirname -- "$APP_DIR")"

STAGE_DIR="$(mktemp -d "$(dirname -- "$APP_DIR")/.bedrock-wiki-mcp.stage.XXXXXX")"
run_source_git -C "$REPO_ROOT" archive HEAD | tar -x -C "$STAGE_DIR"

log "installing reproducible build dependencies"
(
  cd "$STAGE_DIR"
  # Semantic search is disabled on this low-RAM VPS, so never download its
  # optional native runtimes or model tooling during the staged build.
  /usr/bin/npm ci --omit=optional
  /usr/bin/npm run build
  # Remove build tooling after dist/ has been produced.
  /usr/bin/npm prune --omit=dev --omit=optional
  test ! -e node_modules/sqlite-vec
  test ! -e node_modules/@huggingface/transformers
  /usr/bin/node dist/index.js version >/dev/null
  /usr/bin/node dist/index.js help >/dev/null
)

# mktemp creates the staging root as 0700. Apply the final root-owned,
# service-readable permission model before any compatibility check runs as the
# unprivileged service account.
/usr/bin/bash "$STAGE_DIR/deploy/scripts/set-application-permissions.sh" \
  "$STAGE_DIR" "$SERVICE_USER"

[[ ! -L "$CONFIG_DIR/bedrock-mcp.env" ]] || \
  fail "refusing symlinked environment file: $CONFIG_DIR/bedrock-mcp.env"
if [[ ! -f "$CONFIG_DIR/bedrock-mcp.env" ]]; then
  [[ -n "$PUBLIC_HOSTNAME" ]] || \
    fail "set BEDROCK_MCP_PUBLIC_HOSTNAME for the initial deployment"
  [[ "$PUBLIC_HOSTNAME" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]] || \
    fail "BEDROCK_MCP_PUBLIC_HOSTNAME is not a valid DNS hostname"
  if [[ -n "$BEARER_TOKEN" ]]; then
    (( ${#BEARER_TOKEN} >= 16 )) || fail "BEDROCK_MCP_BEARER_TOKEN must contain at least 16 characters"
    [[ "$BEARER_TOKEN" =~ ^[-A-Za-z0-9._~+/=]+$ ]] || \
      fail "BEDROCK_MCP_BEARER_TOKEN must use token-safe characters: letters, digits, - . _ ~ + / ="
  fi

  ENV_TMP="$(mktemp)"
  cp "$STAGE_DIR/deploy/systemd/bedrock-mcp.env.example" "$ENV_TMP"
  sed -i \
    -e "s|^BEDROCK_MCP_ALLOWED_HOSTS=.*|BEDROCK_MCP_ALLOWED_HOSTS=$PUBLIC_HOSTNAME|" \
    -e 's|^BEDROCK_MCP_TRUSTED_PROXY_IPS=.*|BEDROCK_MCP_TRUSTED_PROXY_IPS=127.0.0.1|' \
    "$ENV_TMP"
  if [[ -n "$BEARER_TOKEN" ]]; then
    printf '\nBEDROCK_MCP_BEARER_TOKEN=%s\n' "$BEARER_TOKEN" >>"$ENV_TMP"
  fi
  install -o root -g "$SERVICE_USER" -m 0640 "$ENV_TMP" "$CONFIG_DIR/bedrock-mcp.env"
  rm -f -- "$ENV_TMP"
else
  [[ -f "$CONFIG_DIR/bedrock-mcp.env" ]] || \
    fail "existing environment path is not a regular file: $CONFIG_DIR/bedrock-mcp.env"
  chown root:"$SERVICE_USER" "$CONFIG_DIR/bedrock-mcp.env"
  chmod 0640 "$CONFIG_DIR/bedrock-mcp.env"
  log "preserving existing $CONFIG_DIR/bedrock-mcp.env"
fi

NEEDS_INDEX_REBUILD=false
if [[ ! -f "$DATA_DIR/index/bedrock.db" ]]; then
  NEEDS_INDEX_REBUILD=true
  log "no published lexical index exists; an initial rebuild is required"
elif ! runuser -u "$SERVICE_USER" -- env \
  BEDROCK_MCP_DATA_DIR="$DATA_DIR" \
  BEDROCK_MCP_SEMANTIC_ENABLED=false \
  /usr/bin/node "$STAGE_DIR/dist/index.js" status --json >/dev/null 2>&1; then
  # `status` opens the database read-only, requires the exact serving schema, and
  # exits nonzero if integrity/FTS validation fails. It must not migrate live data.
  NEEDS_INDEX_REBUILD=true
  log "existing lexical index is not read-only compatible with the new application revision; scheduling rebuild"
else
  log "existing lexical index is read-only compatible with the new application revision"
fi

# Stop only during the final application swap. The knowledge updater is also
# stopped so it cannot execute files while the application tree is replaced.
systemctl stop bedrock-mcp-update.timer >/dev/null 2>&1 || true
systemctl stop bedrock-mcp-update.service >/dev/null 2>&1 || true
systemctl stop bedrock-mcp.service >/dev/null 2>&1 || true

PREVIOUS_DIR="${APP_DIR}.previous"
rm -rf -- "$PREVIOUS_DIR"
if [[ -d "$APP_DIR" ]]; then
  mv -- "$APP_DIR" "$PREVIOUS_DIR"
fi
mv -- "$STAGE_DIR" "$APP_DIR"
STAGE_DIR=""
# Reapply after the swap so upgrades also repair trees installed by bootstrap
# versions that preserved mktemp's non-traversable 0700 root mode.
/usr/bin/bash "$APP_DIR/deploy/scripts/set-application-permissions.sh" \
  "$APP_DIR" "$SERVICE_USER"

install -m 0644 "$APP_DIR/deploy/systemd/bedrock-mcp.service" /etc/systemd/system/bedrock-mcp.service
install -m 0644 "$APP_DIR/deploy/systemd/bedrock-mcp-update.service" /etc/systemd/system/bedrock-mcp-update.service
install -m 0644 "$APP_DIR/deploy/systemd/bedrock-mcp-update.timer" /etc/systemd/system/bedrock-mcp-update.timer
systemctl daemon-reload

if [[ "$NEEDS_INDEX_REBUILD" == "true" ]]; then
  log "building the lexical index; this can download several upstream repositories"
  systemctl start bedrock-mcp-update.service
fi

systemctl enable --now bedrock-mcp.service
systemctl enable --now bedrock-mcp-update.timer

log "running local production verification"
"$APP_DIR/deploy/scripts/verify-production.sh"

rm -rf -- "$PREVIOUS_DIR"
log "deployment complete; configure Cloudflare Tunnel using deploy/VPS.md"
