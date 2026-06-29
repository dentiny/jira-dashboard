#!/usr/bin/env bash
# Jira Dashboard — Bootstrap
#
# Usage: ./bootstrap.sh
#
# Interactive setup that configures, installs, and starts the dashboard.
# Idempotent — safe to run multiple times. Never touches your project data.

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
warn()  { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail()  { echo -e "  ${RED}✗${NC} ${BOLD}$1${NC}"; exit 1; }
prompt(){ read -r -p "  ${BOLD}?${NC} $1 "; echo "$REPLY"; }

# ── Step 0: Prerequisites ──────────────────────────────────
step "Prerequisites"

command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Install Node.js >= 18 first."
command -v npm  >/dev/null 2>&1 || fail "npm is not installed."
command -v git  >/dev/null 2>&1 || fail "git is not installed."

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
[ "$NODE_MAJOR" -ge 18 ] || fail "Node.js >= 18 required (found v$(node -v)). Upgrade Node.js first."

ok "Node.js $(node -v)  npm $(npm -v)  git $(git --version | awk '{print $3}')"

# ── Step 1: Configuration ──────────────────────────────────
step "Configuration"

# Prompt for project directory
default_project="${HOME}/project"
PROJECT_DIR=$(prompt "Absolute path to your git repo [${default_project}]")
PROJECT_DIR="${PROJECT_DIR:-$default_project}"
PROJECT_DIR="$(cd "$PROJECT_DIR" 2>/dev/null && pwd)" || true

[ -d "$PROJECT_DIR" ] || fail "Directory does not exist: ${PROJECT_DIR}"
[ -d "$PROJECT_DIR/.git" ] || warn "${PROJECT_DIR} is not a git repository — worktree features will fail"

# Auto-detect git remote
GIT_REMOTE=""
GIT_HOST=""
GIT_OWNER=""
GIT_REPO=""
if [ -d "$PROJECT_DIR/.git" ]; then
  GIT_REMOTE=$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null || true)
  if [ -n "$GIT_REMOTE" ]; then
    # Normalize: strip protocol/auth suffix
    remote_clean=$(echo "$GIT_REMOTE" | sed 's,^git@,https://,' | sed 's,\.git$,,; s,/$,,' | sed 's,:,/,')
    GIT_HOST=$(echo "$remote_clean" | sed 's,https://,,; s,/.*,,')
    path_part=$(echo "$remote_clean" | sed "s,https://${GIT_HOST}/,,")
    GIT_OWNER=$(echo "$path_part" | cut -d/ -f1)
    GIT_REPO=$(echo "$path_part" | cut -d/ -f2-)
    [ "$GIT_HOST" = "github.com" ] && EXPLORER_URL="https://github.com/{owner}/{repo}/blob/{sha}/{path}" \
      || EXPLORER_URL="https://${GIT_HOST}/{owner}/{repo}/blob/{sha}/{path}"
    ok "Detected git remote: ${GIT_HOST}/${GIT_OWNER}/${GIT_REPO}"
  fi
fi

# Prompt for project display name
default_name="$(basename "$PROJECT_DIR")"
PROJECT_NAME=$(prompt "Project display name [${default_name}]")
PROJECT_NAME="${PROJECT_NAME:-$default_name}"

# Prompt for coder CLI path
CODER_BIN=$(prompt "Path to your AI coder CLI binary [opencode]")
CODER_BIN="${CODER_BIN:-opencode}"
if [ "$CODER_BIN" != "opencode" ] && ! command -v "$CODER_BIN" >/dev/null 2>&1; then
  warn "Coder binary '${CODER_BIN}' not found on PATH — you can install it later"
fi

# Write .env into project's .jira-dashboard/
ENV_DIR="${PROJECT_DIR}/.jira-dashboard"
ENV_FILE="${ENV_DIR}/.env"
mkdir -p "$ENV_DIR"

if [ -f "$ENV_FILE" ]; then
  ok ".env already exists at ${ENV_FILE} — keeping your settings"
else
  SED_ARGS="-e s|^JIRA_PROJECT_NAME=.*|JIRA_PROJECT_NAME=${PROJECT_NAME}|"
  SED_ARGS="${SED_ARGS} -e s|^JIRA_CODER_BIN=.*|JIRA_CODER_BIN=${CODER_BIN}|"
  if [ -n "$GIT_OWNER" ]; then
    SED_ARGS="${SED_ARGS} -e s|^# EXPLORER_URL=.*|EXPLORER_URL=${EXPLORER_URL}|"
    SED_ARGS="${SED_ARGS} -e s|^# GITHUB_OWNER=.*|GITHUB_OWNER=${GIT_OWNER}|"
    SED_ARGS="${SED_ARGS} -e s|^# GITHUB_REPO=.*|GITHUB_REPO=${GIT_REPO}|"
  fi
  sed $SED_ARGS "$INSTALL_DIR/templates/env.template" > "$ENV_FILE"
  ok "Created ${ENV_FILE}"
fi
info "Edit ${ENV_FILE} to fine-tune settings, then re-run install"

# ── Step 2: Dependencies ────────────────────────────────────
step "Dependencies"

info "Installing server dependencies..."
npm install --no-audit --no-fund 2>&1 | tail -1
ok "Server dependencies installed"

info "Installing client dependencies..."
(cd client && npm install --no-audit --no-fund 2>&1 | tail -1)
ok "Client dependencies installed"

# ── Step 3: Build client ───────────────────────────────────
step "Client"

info "Building client..."
(cd client && npm run build 2>&1 | tail -3)
ok "Client built"

# ── Step 4: Run mode ────────────────────────────────────────
step "Run mode"

echo "  Choose how to run the dashboard:"
echo "    1) Background — systemd user service (starts on boot, survives terminal)"
echo "    2) Foreground — runs in this terminal (logs visible here)"
MODE=$(prompt "Enter 1 or 2 [1]")
MODE="${MODE:-1}"

case "$MODE" in
  1)  # Background — systemd
    # Derive port from .env or config default
    BASE_PORT=$(grep "^PORT=" "$ENV_FILE" 2>/dev/null | sed 's/^[^=]*=//')
    if [ -z "$BASE_PORT" ]; then
      BASE_PORT=$(node -e "console.log(require('./config.json').port || 3006)" 2>/dev/null || echo "3006")
    fi

    UNIT_NAME="jira-dashboard-${BASE_PORT}"
    UNIT_PATH="$HOME/.config/systemd/user/${UNIT_NAME}.service"
    SVC_TEMPLATE="$INSTALL_DIR/templates/template.service"

    if [ -f "$UNIT_PATH" ]; then
      ok "Systemd service ${UNIT_NAME} already exists — keeping it"
      PORT="$BASE_PORT"
    else
      # Pick a free port if the configured one is already taken
      PORT="$BASE_PORT"
      while ss -tlnp 2>/dev/null | grep -q ":${PORT}\b"; do
        PORT=$((PORT + 1))
      done
      if [ "$PORT" != "$BASE_PORT" ]; then
        info "Port ${BASE_PORT} is already in use — using port ${PORT} instead"
        if grep -q "^PORT=" "$ENV_FILE" 2>/dev/null; then
          sed -i "s|^PORT=.*|PORT=${PORT}|" "$ENV_FILE"
        else
          echo "PORT=${PORT}" >> "$ENV_FILE"
        fi
      fi

      UNIT_NAME="jira-dashboard-${PORT}"
      UNIT_PATH="$HOME/.config/systemd/user/${UNIT_NAME}.service"

      info "Creating systemd service..."
      mkdir -p "$HOME/.config/systemd/user"
      NODE=$(command -v node) \
      ROOT="$ROOT" \
      PORT="$PORT" \
      PROJECT_DIR="$PROJECT_DIR" \
      NAME="$PROJECT_NAME" \
      envsubst '${NODE} ${ROOT} ${PORT} ${PROJECT_DIR} ${NAME}' < "$SVC_TEMPLATE" > "$UNIT_PATH"

      ok "Created ${UNIT_PATH}"
    fi

    systemctl --user daemon-reload 2>/dev/null || warn "systemd daemon-reload failed (non-fatal)"
    systemctl --user enable "${UNIT_NAME}.service" 2>/dev/null || warn "systemd enable failed — run manually: systemctl --user enable ${UNIT_NAME}.service"
    systemctl --user restart "${UNIT_NAME}.service" 2>/dev/null || warn "systemd restart failed — check: journalctl --user -u ${UNIT_NAME}.service -e"

    echo ""
    ok "${BOLD}Dashboard running at http://localhost:${PORT}${NC}"
    echo ""
    info "Manage:  systemctl --user ${UNIT_NAME}.service {start|stop|restart|status}"
    info "Logs:    journalctl --user -u ${UNIT_NAME}.service -f"
    info "Config:  edit ${ENV_FILE} then restart the service"
    info "Data:    ${PROJECT_DIR}/.jira-dashboard/store.db"
    ;;

  2)  # Foreground
    echo ""
    info "Starting in foreground..."
    echo ""
    cd "$PROJECT_DIR"
    exec node "$ROOT/server.js"
    ;;

  *)
    fail "Invalid choice '${MODE}'. Run again and enter 1 or 2."
    ;;
esac
