// config.js — unified config loader
// Loads config.json first, then .env overrides (flat key=value format).
// All code imports from this module; no other file reads env/paths directly.

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname);

// ── Load config.json ──────────────────────────────────────
let cfg;
const configPath = path.join(ROOT, 'config.json');
if (fs.existsSync(configPath)) {
  cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} else {
  console.warn('config.json not found — using defaults');
  cfg = {};
}

// ── Load .env (flat key=value, no sections) ───────────────
function loadEnv(filePath) {
  const vars = {};
  if (!fs.existsSync(filePath)) return vars;
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }
  return vars;
}

const envVars = loadEnv(path.join(ROOT, '.env'));

// ── Helpers ───────────────────────────────────────────────
function env(key, fallback) {
  return envVars[key] !== undefined ? envVars[key] : fallback;
}

// ── Resolved config ───────────────────────────────────────
const config = {
  // Server
  port: parseInt(env('PORT')) || cfg.port || 3006,
  dataDir: path.resolve(env('JIRA_DATA_DIR') || path.join(ROOT, cfg.data_dir || 'data')),

  // Project
  projectName: env('JIRA_PROJECT_NAME') || cfg.project?.name || 'project',
  remoteHost: env('REMOTE_HOST') || cfg.remoteHost || 'example-claw',
  explorerPort: parseInt(env('EXPLORER_PORT')) || cfg.explorerPort || 18802,
  branchDefault: env('GIT_DEFAULT_BRANCH') || cfg.branchDefault || 'main',
  dbBusyTimeout: parseInt(env('DB_BUSY_TIMEOUT')) || cfg.dbBusyTimeout || 5000,
  projectDir: env('JIRA_PROJECT_DIR') || cfg.project?.path || process.cwd(),

  // Worktrees (defaults to <projectDir>/.worktrees if not set)
  get worktreesDir() {
    const explicit = env('JIRA_WORKTREES_DIR') || cfg.worktrees?.dir;
    if (explicit) return explicit;
    return path.join(this.projectDir, '.worktrees');
  },

  // Coder CLI tool
  coder: {
    type: env('JIRA_CODER_TYPE') || cfg.coder?.type || 'opencode',
    bin: env('JIRA_CODER_BIN') || cfg.coder?.bin || 'opencode',
    timeouts: cfg.coder?.timeouts || {
      clarify: 180_000,
      implement: 600_000,
      suggest: 120_000,
      test: 300_000,
      command: 30_000,
    },
  },

  // Python venv
  venv: {
    dir: env('JIRA_VENV_DIR') || cfg.venv?.path || '.venv',
    pythonpath: env('JIRA_PYTHONPATH') || cfg.venv?.pythonpath || 'src',
  },

  // Test runner
  test: {
    commandOverride: env('JIRA_TEST_CMD') || cfg.test?.command_override || null,
    timeout: parseInt(env('JIRA_TEST_TIMEOUT')) || cfg.test?.timeout || 300_000,
  },

  // ── Convenience helpers ──────────────────────────────────
  venvBin() {
    return path.join(this.projectDir, this.venv.dir, 'bin');
  },
  venvPython() {
    const bin = this.venvBin();
    const candidates = ['python', 'python3'];
    for (const p of candidates) {
      const pypath = path.join(bin, p);
      if (fs.existsSync(pypath)) return pypath;
    }
    return 'python3';
  },
  ticketContextDir(ticketId) {
    const safe = String(ticketId).replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.projectDir, '.opencode', 'tickets', safe);
  },
};

// Validate required paths
if (!fs.existsSync(config.projectDir)) {
  console.warn(`WARNING: project dir not found: ${config.projectDir}`);
}

module.exports = config;
