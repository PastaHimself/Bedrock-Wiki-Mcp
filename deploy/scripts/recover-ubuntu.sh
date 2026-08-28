#!/usr/bin/env bash
set -euo pipefail

# Recover or upgrade an Ubuntu deployment even when the operator's source checkout
# contains local changes or untracked files. The normal bootstrap intentionally
# remains strict: this wrapper creates a separate clean detached Git worktree at
# an exact committed revision, then runs the unchanged bootstrap from that tree.

TARGET_REF="${1:-HEAD}"
RECOVERY_PARENT=""
RECOVERY_TREE=""
WORKTREE_ADDED=false

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
SOURCE_USER="${SUDO_USER:-$(stat -c '%U' "$REPO_ROOT")}"

log() {
  printf '[bedrock-mcp-recovery] %s\n' "$*"
}

fail() {
  printf '[bedrock-mcp-recovery] ERROR: %s\n' "$*" >&2
  exit 1
}

run_source_git() {
  if [[ "$SOURCE_USER" == "root" ]]; then
    git "$@"
  else
    id "$SOURCE_USER" >/dev/null 2>&1 || fail "source checkout owner '$SOURCE_USER' is not a local user"
    runuser -u "$SOURCE_USER" -- git "$@"
  fi
}

cleanup() {
  local status=$?
  if [[ "$WORKTREE_ADDED" == "true" && -n "$RECOVERY_TREE" ]]; then
    run_source_git -C "$REPO_ROOT" worktree remove --force "$RECOVERY_TREE" >/dev/null 2>&1 || true
  fi
  if [[ -n "$RECOVERY_PARENT" && -d "$RECOVERY_PARENT" ]]; then
    rm -rf -- "$RECOVERY_PARENT"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

[[ "${EUID}" -eq 0 ]] || fail "run this script as root (sudo)"
command -v git >/dev/null 2>&1 || fail "git is required"
command -v runuser >/dev/null 2>&1 || fail "runuser is required"

run_source_git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || \
  fail "run this script from a Git checkout"

TARGET_SHA="$(run_source_git -C "$REPO_ROOT" rev-parse --verify "${TARGET_REF}^{commit}")" || \
  fail "cannot resolve committed revision: $TARGET_REF"

# A dirty primary checkout is intentionally acceptable here. Never reset, clean,
# stash, or otherwise mutate it; deployment comes exclusively from TARGET_SHA.
log "preparing clean detached worktree for $TARGET_SHA"
RECOVERY_PARENT="$(mktemp -d /tmp/bedrock-mcp-recovery.XXXXXX)"
RECOVERY_TREE="$RECOVERY_PARENT/tree"

if [[ "$SOURCE_USER" != "root" ]]; then
  SOURCE_GROUP="$(id -gn "$SOURCE_USER")"
  chown "$SOURCE_USER:$SOURCE_GROUP" "$RECOVERY_PARENT"
fi
chmod 0700 "$RECOVERY_PARENT"

run_source_git -C "$REPO_ROOT" worktree add --detach "$RECOVERY_TREE" "$TARGET_SHA" >/dev/null
WORKTREE_ADDED=true

[[ -z "$(run_source_git -C "$RECOVERY_TREE" status --porcelain)" ]] || \
  fail "temporary recovery worktree is unexpectedly dirty"
[[ "$(run_source_git -C "$RECOVERY_TREE" rev-parse HEAD)" == "$TARGET_SHA" ]] || \
  fail "temporary recovery worktree resolved to the wrong revision"
[[ -f "$RECOVERY_TREE/deploy/scripts/bootstrap-ubuntu.sh" ]] || \
  fail "target revision does not contain the Ubuntu bootstrap"

log "running normal bootstrap from clean revision $TARGET_SHA"
/usr/bin/bash "$RECOVERY_TREE/deploy/scripts/bootstrap-ubuntu.sh"
log "recovery deployment completed successfully at $TARGET_SHA"
