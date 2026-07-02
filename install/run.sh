#!/usr/bin/env bash
#
# Jira Dashboard — Bootstrap
#
# Rules:
#  - Fail loud, don't be smart.
#  - Idempotent — safe to run multiple times.
#  - Never touches user project data.
#
# Usage: ./bootstrap.sh

set -euo pipefail
export LC_ALL=C

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$INSTALL_DIR")"
cd "$ROOT"

# ── Output helpers ─────────────────────────────────────────
BOLD='\033[1m'; RED='\033[0;31m'; GREEN='\033[0;32m'
YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

step()  { echo; echo -e "${CYAN}${BOLD}── ${1} ──${NC}"; }
info()  { echo -e "  ${CYAN}•${NC} $1"; }
ok()    { echo -e "  ${GREEN}✓${NC} $1"; }
fail()  { echo -e "  ${RED}✗${NC} ${BOLD}$1${NC}"; exit 1; }
prompt(){ echo -e "  ${YELLOW}?${NC} $1" >&2; read -r REPLY; echo "$REPLY"; }

# ── Step 0: Prerequisites ──────────────────────────────────
step "Prerequisites"

command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Install Node.js >= 18 first."
command -v npm  >/dev/null 2>&1 || fail "npm is not installed."
command -v git  >/dev/null 2>&1 || fail "git is not installed."
OS="$(uname -s)"

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
[ "$NODE_MAJOR" -ge 18 ] || fail "Node.js >= 18 required (found v$(node -v)). Upgrade Node.js first."

ok "Node.js $(node -v)  npm $(npm -v)  git $(git --version | awk '{print $3}')"

# ── Step 1: Configuration ──────────────────────────────────
step "Configuration"

PROJECT_DIR=$(prompt "Absolute path to your git repo")
PROJECT_DIR="${PROJECT_DIR/#\~/$HOME}"
[ "${PROJECT_DIR:0:1}" = "/" ] || fail "Must be an absolute path: ${PROJECT_DIR}"
[ -d "$PROJECT_DIR" ] || fail "Directory does not exist: ${PROJECT_DIR}"
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
[ -d "$PROJECT_DIR/.git" ] || fail "Not a git repository: ${PROJECT_DIR}"

default_name="$(basename "$PROJECT_DIR")"
PROJECT_NAME=$(prompt "Project display name [${default_name}]")
PROJECT_NAME="${PROJECT_NAME:-$default_name}"

CODER_BIN=$(prompt "Path to your AI coder CLI binary [opencode]")
CODER_BIN="${CODER_BIN:-opencode}"
command -v "$CODER_BIN" >/dev/null 2>&1 || fail "Coder binary '${CODER_BIN}' not found on PATH"

# Detect git remote for explorer config
GIT_REMOTE=$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null || true)
REMOTE_HOST=""; REMOTE_OWNER=""; REMOTE_REPO=""; EXPLORER_URL=""
if [ -n "$GIT_REMOTE" ]; then
  remote_clean=$(echo "$GIT_REMOTE" | sed 's,^git@,https://,' | sed 's,\.git$,,; s,/$,,' | sed 's,:,/,')
  REMOTE_HOST=$(echo "$remote_clean" | sed 's,https://,,; s,/.*,,')
  path_part=$(echo "$remote_clean" | sed "s,https://${REMOTE_HOST}/,,")
  REMOTE_OWNER=$(echo "$path_part" | cut -d/ -f1)
  REMOTE_REPO=$(echo "$path_part" | cut -d/ -f2-)
  EXPLORER_URL="https://${REMOTE_HOST}/{owner}/{repo}/blob/{sha}/{path}"
  ok "Detected git remote: ${REMOTE_HOST}/${REMOTE_OWNER}/${REMOTE_REPO}"
fi

# Detect default branch from remote
DEFAULT_BRANCH=""
DETECTED_BRANCH=""
LS_REMOTE_OUTPUT=$(git -C "$PROJECT_DIR" ls-remote --symref origin HEAD 2>/dev/null || true)
if [ -z "$LS_REMOTE_OUTPUT" ]; then
  fail "Could not detect default branch from remote 'origin'.
  Make sure your repo has a remote named 'origin' and you have network access."
fi
DETECTED_BRANCH=$(echo "$LS_REMOTE_OUTPUT" | awk '/^ref: refs\/heads\// {print $2; exit}' | sed 's,refs/heads/,,')
if [ -z "$DETECTED_BRANCH" ]; then
  fail "Could not parse default branch from remote 'origin'.
  Unexpected output from: git ls-remote --symref origin HEAD"
fi
info "Detected default branch: ${BOLD}${DETECTED_BRANCH}${NC}"
response=$(prompt "Press Enter to accept, or type a different branch name [${DETECTED_BRANCH}]")
DEFAULT_BRANCH="${response:-$DETECTED_BRANCH}"

# Write .env (idempotent — never overwrites)
ENV_DIR="${PROJECT_DIR}/.jira-dashboard"
ENV_FILE="${ENV_DIR}/.env"
mkdir -p "$ENV_DIR"
if [ -f "$ENV_FILE" ]; then
  ok ".env already exists at ${ENV_FILE} — keeping your settings"
  NUM_WORKTREES=$(grep '^NUM_WORKTREES=' "$ENV_FILE" | sed 's/^[^=]*=//' | head -n1)
else
  NUM_WORKTREES=$(prompt "Max parallel ticket worktrees to pre-create (0 = one per ticket, created on demand) [0]")
  NUM_WORKTREES="${NUM_WORKTREES:-0}"
  case "$NUM_WORKTREES" in ''|*[!0-9]*) fail "Worktree count must be a non-negative integer: ${NUM_WORKTREES}";; esac
  PORT=$(node "${ROOT}/service/index.js" find-port 3006)
  cat > "$ENV_FILE" <<-EOF
JIRA_PROJECT_NAME=${PROJECT_NAME}
JIRA_CODER_BIN=${CODER_BIN}
PORT=${PORT}
REMOTE_HOST=${REMOTE_HOST:-example-claw}
EXPLORER_URL=${EXPLORER_URL}
GITHUB_OWNER=${REMOTE_OWNER}
GITHUB_REPO=${REMOTE_REPO}
GIT_DEFAULT_BRANCH=${DEFAULT_BRANCH}
NUM_WORKTREES=${NUM_WORKTREES}
EOF
  ok "Created ${ENV_FILE}"
fi
# Sanitize so the numeric test below is safe under `set -e`.
case "${NUM_WORKTREES:-0}" in ''|*[!0-9]*) NUM_WORKTREES=0;; esac

# Copy the JSON schemas the coder is told to read during the clarify and
# conflict-resolution stages into the project's .jira-dashboard/. Always
# refresh (cp -f) so schema updates in the dashboard repo propagate on
# re-install. Prompts reference them at ${PROJECT_DIR}/.jira-dashboard/.
cp -f "${ROOT}/clarification.schema.json" "${ROOT}/resolve-conflict.schema.json" "${ENV_DIR}/"
ok "Installed coder schemas into ${ENV_DIR}"

# ── Step 1b: Worktree pool (idempotent) ────────────────────
if [ "$NUM_WORKTREES" -gt 0 ]; then
  step "Worktree pool"
  EFFECTIVE_BRANCH=$(grep '^GIT_DEFAULT_BRANCH=' "$ENV_FILE" | sed 's/^[^=]*=//' | head -n1)
  EFFECTIVE_BRANCH="${EFFECTIVE_BRANCH:-$DEFAULT_BRANCH}"
  WT_DIR=$(grep '^JIRA_WORKTREES_DIR=' "$ENV_FILE" | sed 's/^[^=]*=//' | head -n1)
  info "Pre-creating ${NUM_WORKTREES} worktree(s) off '${EFFECTIVE_BRANCH}' — may take a while on large repos"
  node "${ROOT}/install/setup-worktrees.js" "$PROJECT_DIR" "$EFFECTIVE_BRANCH" "$NUM_WORKTREES" ${WT_DIR:+"$WT_DIR"}
  ok "Worktree pool ready (${NUM_WORKTREES} slot(s))"
fi

# ── Step 2: Dependencies ────────────────────────────────────
step "Dependencies"

npm install --no-audit --no-fund | tail -1
(cd client && npm install --no-audit --no-fund | tail -1)
ok "Dependencies installed"

# ── Step 3: Build client ───────────────────────────────────
step "Client"

(cd client && npm run build | tail -3)
ok "Client built"

# ── Step 4: Install service ────────────────────────────────
case "$OS" in
  Linux)  step "Service (systemd)" ;;
  Darwin) step "Service (launchd)" ;;
esac

PORT=$(grep "^PORT=" "$ENV_FILE" 2>/dev/null | sed 's/^[^=]*=//' || echo "3006")

node "${ROOT}/service/index.js" install \
  "$PORT" "$ROOT" "$PROJECT_DIR" "$PROJECT_NAME"

echo ""
ok "${BOLD}Dashboard running at http://localhost:${PORT}${NC}"
echo ""

MGMT=$(node -e "
  const svc = require('${ROOT}/service');
  svc.manageHelp({port:'${PORT}'}).forEach(l => console.log(l));
  console.log('Config:  edit ${ENV_FILE} then restart the service');
  console.log('Data:    ${PROJECT_DIR}/.jira-dashboard/store.db');
")
while IFS= read -r line; do info "$line"; done <<< "$MGMT"
