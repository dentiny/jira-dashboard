// config.js — unified config loader
// Discovers <projectDir>/.jira-dashboard/.env by walking up from cwd,
// then loads config.json on top as override. All code imports from this
// module; no other file reads env/paths directly.

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// ── Project root discovery ────────────────────────────────
// Three strategies, in priority order:
//   1. cfg.project.path from config.json, if it exists on disk (explicit override)
//   2. Git-aware: parent of `git rev-parse --git-common-dir` (worktree-safe)
//   3. Walk up looking for .jira-dashboard/.env (legacy install shape)
//   4. process.cwd() as last resort

// Resolve the main repo root when cwd is inside a git repo or worktree.
// Works correctly in self-host / dogfood cases where the worktree is a clean
// checkout of the jira-dashboard source itself.
function gitCommonDirAncestor() {
  try {
    const common = execSync('git rev-parse --git-common-dir', { encoding: 'utf-8' }).trim();
    if (!common) return null;
    return path.resolve(path.dirname(common));
  } catch {
    return null;
  }
}

function findProjectDir() {
  let dir = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(dir, '.jira-dashboard', '.env'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

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

// ── Resolve project directory ─────────────────────────────
const explicitProjectPath = (cfg.project?.path && fs.existsSync(cfg.project?.path))
  ? cfg.project.path
  : null;
const PROJECT_DIR = explicitProjectPath || gitCommonDirAncestor() || findProjectDir() || process.cwd();

// ── .env loader ────────────────────────────────────────────
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

// Dashboard config from <project>/.jira-dashboard/.env
const dashEnvPath = path.join(PROJECT_DIR, '.jira-dashboard', '.env');
const envVars = loadEnv(dashEnvPath);

if (!fs.existsSync(dashEnvPath)) {
  console.warn(`No dashboard .env at ${dashEnvPath} — using defaults. Run install/run.sh.`);
}

// Project environment from <project>/.env — injected into process.env
// so child processes (coder CLI, test runner) inherit API keys, venv, PATH, etc.
const projectEnvPath = path.join(PROJECT_DIR, '.env');
if (fs.existsSync(projectEnvPath)) {
  Object.assign(process.env, loadEnv(projectEnvPath));
}

// ── Helpers ───────────────────────────────────────────────
function env(key, fallback) {
  return envVars[key] !== undefined ? envVars[key] : fallback;
}

// ── Resolved config ───────────────────────────────────────
const config = {
  // Server
  port: parseInt(env('PORT')) || cfg.port || 3006,
  get dataDir() {
    return path.resolve(env('JIRA_DATA_DIR') || path.join(this.projectDir, '.jira-dashboard'));
  },

  // Project
  projectName: env('JIRA_PROJECT_NAME') || cfg.project?.name || 'project',
  remoteHost: env('REMOTE_HOST') || cfg.remoteHost || 'example-claw',
  explorer: {
    url: env('EXPLORER_URL') || cfg.explorer?.url || 'https://github.com/{owner}/{repo}/blob/{sha}/{path}',
    owner: env('GITHUB_OWNER') || cfg.explorer?.owner || '',
    repo: env('GITHUB_REPO') || cfg.explorer?.repo || '',
  },
  branchDefault: env('GIT_DEFAULT_BRANCH') || cfg.branchDefault || 'main',
  dbBusyTimeout: parseInt(env('DB_BUSY_TIMEOUT')) || cfg.dbBusyTimeout || 5000,
  projectDir: env('JIRA_PROJECT_DIR') || PROJECT_DIR,

  // Worktrees (defaults to <projectDir>/.worktrees if not set)
  get worktreesDir() {
    const explicit = env('JIRA_WORKTREES_DIR') || cfg.worktrees?.dir;
    if (explicit) return explicit;
    return path.join(this.projectDir, '.worktrees');
  },

  // Max concurrent ticket worktrees. >0 enables a pre-created worktree pool
  // (provisioned at install time) that tickets check out and return, capping
  // parallelism at this count. 0 keeps the one-worktree-per-ticket behavior:
  // created on implement, deleted on close.
  get numWorktrees() {
    const raw = env('NUM_WORKTREES') ?? cfg.worktrees?.count;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
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
      push: 600_000,
    },
  },

  // Python venv
  venv: {
    dir: env('JIRA_VENV_DIR') || cfg.venv?.path || '.venv',
    pythonpath: env('JIRA_PYTHONPATH') || cfg.venv?.pythonpath || 'src',
  },

  // Close / merge strategy
  mergeStrategy: env('MERGE_STRATEGY') || cfg.mergeStrategy || 'cherry-pick',

  // PR checker: CI checks to fully ignore (comma-separated, case-insensitive).
  // Never shown to any coder prompt. Typically process gates like automerge.
  prCheckIgnore: (() => {
    const raw = env('JIRA_PR_IGNORE_CHECKS') || cfg.pr_check?.ignore_checks || '';
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  })(),
  // PR checker: CI checks whose FAILURE triggers an auto-move to clarification
  // for code rework (comma-separated, case-insensitive).
  prReworkChecks: (() => {
    const raw = env('JIRA_PR_REWORK_CHECKS') || cfg.pr_check?.rework_checks || '';
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  })(),


  // Test runner (opt-in, default off)
  test: {
    enabled: env('JIRA_TEST_ENABLED') === 'true' || cfg.test?.enabled || false,
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
    return path.join(this.projectDir, '.jira-dashboard', 'tickets', safe);
  },
};

// Validate required paths
if (!fs.existsSync(config.projectDir)) {
  console.warn(`WARNING: project dir not found: ${config.projectDir}`);
}

module.exports = config;
