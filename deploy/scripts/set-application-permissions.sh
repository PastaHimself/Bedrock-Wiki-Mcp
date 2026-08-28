#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '[bedrock-mcp-permissions] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "run this script as root"
[[ "$#" -eq 2 ]] || fail "usage: $0 APPLICATION_DIRECTORY SERVICE_USER"

APP_TREE="$(realpath -e -- "$1")"
SERVICE_USER="$2"

[[ -d "$APP_TREE" ]] || fail "application directory does not exist: $APP_TREE"
[[ "$APP_TREE" != "/" && "$APP_TREE" != "/opt" ]] || fail "refusing unsafe application directory: $APP_TREE"
getent passwd "$SERVICE_USER" >/dev/null || fail "service user does not exist: $SERVICE_USER"

for required_path in \
  "$APP_TREE/package.json" \
  "$APP_TREE/dist/index.js" \
  "$APP_TREE/deploy/scripts/update-knowledge.sh" \
  "$APP_TREE/deploy/scripts/verify-production.sh"; do
  [[ -f "$required_path" ]] || fail "required application file is missing: $required_path"
done

# mktemp creates the staging root as 0700. Normalize the complete installed tree
# so the unprivileged service account can traverse/read it without gaining write
# access. find does not follow symlinks, and chown's default traversal is physical.
chown -hR root:root "$APP_TREE"
find "$APP_TREE" -type d -exec chmod u+rwx,go+rx,go-w {} +
find "$APP_TREE" -type f -exec chmod u+rw,go+r,go-w {} +
find "$APP_TREE/deploy/scripts" -maxdepth 1 -type f -name '*.sh' -exec chmod 0755 {} +

if find "$APP_TREE" \( -type d -o -type f \) -perm /022 -print -quit | grep -q .; then
  fail "application tree still contains group- or other-writable paths"
fi

runuser -u "$SERVICE_USER" -- /usr/bin/test -x "$APP_TREE" || \
  fail "$SERVICE_USER cannot traverse the application directory"
runuser -u "$SERVICE_USER" -- /usr/bin/test -r "$APP_TREE/dist/index.js" || \
  fail "$SERVICE_USER cannot read the application entry point"
runuser -u "$SERVICE_USER" -- /usr/bin/test -r "$APP_TREE/deploy/scripts/update-knowledge.sh" || \
  fail "$SERVICE_USER cannot read the updater script"
runuser -u "$SERVICE_USER" -- /usr/bin/test -x "$APP_TREE/deploy/scripts/update-knowledge.sh" || \
  fail "$SERVICE_USER cannot execute the updater script"
if runuser -u "$SERVICE_USER" -- /usr/bin/test -w "$APP_TREE"; then
  fail "$SERVICE_USER can modify the application directory"
fi
