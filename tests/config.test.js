// tests/config.test.js — Config loader unit tests

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

let assert;
try { assert = require('assert'); } catch { assert = require('node:assert'); }

// ── Test helpers ───────────────────────────────────────────

function reloadConfig() {
  delete require.cache[require.resolve('../config')];
  return require('../config');
}

// .env now lives at <projectDir>/.jira-dashboard/.env.
// We use a temp directory as the project to keep tests isolated.
const tmpDir = fs.mkdtempSync(path.join(ROOT, '.test-env-'));
const envDir = path.join(tmpDir, '.jira-dashboard');
const envPath = path.join(envDir, '.env');

function removeTmp() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

// Override config.json project.path to point at our temp dir, then restore
const configJsonPath = path.join(ROOT, 'config.json');
function withProjectDir(fn) {
  const orig = JSON.parse(fs.readFileSync(configJsonPath, 'utf-8'));
  try {
    fs.writeFileSync(configJsonPath, JSON.stringify(
      { ...orig, project: { ...orig.project, path: tmpDir } }, null, 2) + '\n', 'utf-8');
    fn();
  } finally {
    fs.writeFileSync(configJsonPath, JSON.stringify(orig, null, 2) + '\n', 'utf-8');
  }
}

function withEnv(content, fn) {
  fs.mkdirSync(envDir, { recursive: true });
  let orig = null;
  if (fs.existsSync(envPath)) orig = fs.readFileSync(envPath, 'utf-8');
  try {
    fs.writeFileSync(envPath, content, 'utf-8');
    fn();
  } finally {
    if (orig !== null) fs.writeFileSync(envPath, orig, 'utf-8');
    else fs.unlinkSync(envPath);
  }
}

function withoutEnv(fn) {
  fs.mkdirSync(envDir, { recursive: true });
  let orig = null;
  if (fs.existsSync(envPath)) orig = fs.readFileSync(envPath, 'utf-8');
  try {
    if (orig !== null) fs.unlinkSync(envPath);
    fn();
  } finally {
    if (orig !== null) fs.writeFileSync(envPath, orig, 'utf-8');
  }
}

function withConfigJson(modify, fn) {
  const orig = JSON.parse(fs.readFileSync(configJsonPath, 'utf-8'));
  try {
    fs.writeFileSync(configJsonPath, JSON.stringify(modify(orig), null, 2) + '\n', 'utf-8');
    fn();
  } finally {
    fs.writeFileSync(configJsonPath, JSON.stringify(orig, null, 2) + '\n', 'utf-8');
  }
}

try {

// ── config.json loading ────────────────────────────────────
(function testConfigJsonLoaded() {
  withProjectDir(() => {
    const cfg = reloadConfig();
    assert.ok(cfg.port > 0, 'port should be positive');
    assert.ok(typeof cfg.projectName === 'string', 'projectName should be a string');
    assert.strictEqual(cfg.projectDir, tmpDir, 'projectDir should come from config.json');
    assert.ok(typeof cfg.coder.type === 'string', 'coder.type should be a string');
    assert.ok(typeof cfg.coder.bin === 'string', 'coder.bin should be a string');
    console.log('PASS: config.json loaded with all required fields');
  });
})();

// ── Convenience helpers exist ──────────────────────────────
(function testHelpers() {
  withProjectDir(() => {
    const cfg = reloadConfig();
    assert.strictEqual(typeof cfg.venvBin, 'function', 'venvBin should be a function');
    assert.strictEqual(typeof cfg.venvPython, 'function', 'venvPython should be a function');
    assert.strictEqual(typeof cfg.ticketContextDir, 'function', 'ticketContextDir should be a function');
    console.log('PASS: convenience helpers exist');
  });
})();

// ── ticketContextDir sanitizes input ───────────────────────
(function testTicketContextDirSanitization() {
  withProjectDir(() => {
    const cfg = reloadConfig();
    const dir = cfg.ticketContextDir('hello/world test@#$');
    const lastPart = path.basename(dir);
    assert.ok(!lastPart.includes('/'), 'should sanitize slashes');
    assert.ok(!lastPart.includes('@'), 'should sanitize @');
    assert.ok(!lastPart.includes('#'), 'should sanitize #');
    assert.ok(!lastPart.includes('$'), 'should sanitize $');
    assert.ok(lastPart.includes('hello_world_test'), 'should keep alphanumeric + underscore');
    console.log('PASS: ticketContextDir sanitizes input');
  });
})();

// ── worktreesDir defaults to projectDir/.worktrees ─────────
(function testWorktreesDirDefault() {
  withProjectDir(() => {
    const cfg = reloadConfig();
    const expected = path.join(cfg.projectDir, '.worktrees');
    assert.strictEqual(cfg.worktreesDir, expected, 'worktreesDir should default to projectDir/.worktrees');
    console.log('PASS: worktreesDir defaults correctly');
  });
})();

// ── dataDir defaults to projectDir/.jira-dashboard ─────────
(function testDataDirDefault() {
  withProjectDir(() => {
    const cfg = reloadConfig();
    const expected = path.join(cfg.projectDir, '.jira-dashboard');
    assert.strictEqual(cfg.dataDir, expected, 'dataDir should default to projectDir/.jira-dashboard');
    console.log('PASS: dataDir defaults to projectDir/.jira-dashboard');
  });
})();

// ── New configurable fields: defaults ──────────────────────
(function testNewFieldDefaults() {
  withProjectDir(() => {
    withoutEnv(() => {
      const cfg = reloadConfig();
      assert.strictEqual(cfg.remoteHost, 'example-claw', 'remoteHost should default to example-claw');
      assert.ok(cfg.explorer && typeof cfg.explorer.url === 'string', 'explorer.url should be a string');
      assert.ok(cfg.explorer.url.includes('{sha}'), 'explorer.url should be a template with {sha}');
      assert.strictEqual(cfg.branchDefault, 'main', 'branchDefault should default to main');
      assert.strictEqual(cfg.dbBusyTimeout, 5000, 'dbBusyTimeout should default to 5000');
      assert.strictEqual(cfg.mergeStrategy, 'cherry-pick', 'mergeStrategy should default to cherry-pick');
      assert.strictEqual(cfg.test.enabled, false, 'test.enabled should default to false');
      assert.strictEqual(cfg.test.commandOverride, null, 'test.commandOverride should default to null');
      assert.strictEqual(cfg.projectName, 'My Project', 'projectName should come from config.json');
      console.log('PASS: new config fields have correct defaults');
    });
  });
})();

// ── Env var overrides via .env file ─────────────────────────
(function testEnvVarOverrides() {
  withProjectDir(() => {
    withEnv([
      'REMOTE_HOST=my-host',
      'EXPLORER_URL={protocol}//{host}:3000/explorer/{prefix}/{path}',
      'GITHUB_OWNER=my-org',
      'GITHUB_REPO=my-repo',
      'GIT_DEFAULT_BRANCH=develop',
      'MERGE_STRATEGY=pr',
      'DB_BUSY_TIMEOUT=9999',
      'JIRA_PROJECT_NAME=EnvProject',
      'JIRA_PROJECT_DIR=/env/path',
      'JIRA_TEST_ENABLED=true',
      'JIRA_TEST_CMD=npm test',
      'JIRA_TEST_TIMEOUT=123456',
    ].join('\n'), () => {
      const cfg = reloadConfig();
      assert.strictEqual(cfg.remoteHost, 'my-host', 'remoteHost should be overridden by .env');
      assert.strictEqual(cfg.explorer.url, '{protocol}//{host}:3000/explorer/{prefix}/{path}', 'explorer.url should be overridden by .env');
      assert.strictEqual(cfg.explorer.owner, 'my-org', 'explorer.owner should be overridden by .env');
      assert.strictEqual(cfg.explorer.repo, 'my-repo', 'explorer.repo should be overridden by .env');
      assert.strictEqual(cfg.branchDefault, 'develop', 'branchDefault should be overridden by .env');
      assert.strictEqual(cfg.mergeStrategy, 'pr', 'mergeStrategy should be overridden by .env');
      assert.strictEqual(cfg.dbBusyTimeout, 9999, 'dbBusyTimeout should be overridden by .env');
      assert.strictEqual(cfg.projectName, 'EnvProject', 'projectName should be overridden by .env');
      assert.strictEqual(cfg.projectDir, '/env/path', 'projectDir should be overridden by .env');
    assert.strictEqual(cfg.test.enabled, true, 'test.enabled should be overridden by .env');
    assert.strictEqual(cfg.test.commandOverride, 'npm test', 'test.commandOverride should be overridden by .env');
    assert.strictEqual(cfg.test.timeout, 123456, 'test.timeout should be overridden by .env');
    console.log('PASS: env vars override config defaults');
    });
  });
})();

// ── config.json overrides when .env is absent ──────────────
(function testConfigJsonOverrides() {
  withProjectDir(() => {
    withoutEnv(() => {
      withConfigJson(
        orig => ({ ...orig, remoteHost: 'json-host', explorer: { url: 'https://github.com/json-org/json-repo/blob/{sha}/{path}', owner: 'json-org', repo: 'json-repo' }, branchDefault: 'staging', dbBusyTimeout: 1234 }),
        () => {
          const cfg = reloadConfig();
          assert.strictEqual(cfg.remoteHost, 'json-host', 'remoteHost should be overridable via config.json');
          assert.strictEqual(cfg.explorer.url, 'https://github.com/json-org/json-repo/blob/{sha}/{path}', 'explorer.url should be overridable via config.json');
          assert.strictEqual(cfg.branchDefault, 'staging', 'branchDefault should be overridable via config.json');
          assert.strictEqual(cfg.dbBusyTimeout, 1234, 'dbBusyTimeout should be overridable via config.json');
          console.log('PASS: new fields can be set via config.json');
        }
      );
    });
  });
})();

// ── .env wins over config.json ─────────────────────────────
(function testEnvWinsOverConfigJson() {
  withProjectDir(() => {
    withConfigJson(
      orig => ({ ...orig, remoteHost: 'from-json' }),
      () => {
        withEnv('REMOTE_HOST=from-env', () => {
          const cfg = reloadConfig();
          assert.strictEqual(cfg.remoteHost, 'from-env', '.env should take precedence over config.json');
          console.log('PASS: .env overrides config.json when both define the same field');
        });
      }
    );
  });
})();

// ── Git-aware project discovery (worktree case) ────────────
(function testGitAwareFromWorktree() {
  // Build a temp git repo + worktree, chdir into the worktree, and verify
  // projectDir resolves to the main repo (not the worktree, not cwd).
  // This is the self-host / dogfood case the walk-up heuristic gets wrong.
  const { execSync } = require('child_process');
  const os = require('os');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-cfg-gt-'));
  const wtDir = path.join(tmpRoot, '.worktrees', 'feature');
  const origCwd = process.cwd();
  try {
    execSync('git init -q', { cwd: tmpRoot });
    execSync('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: tmpRoot });
    fs.mkdirSync(path.dirname(wtDir), { recursive: true });
    execSync(`git worktree add -q ${wtDir} -b feature`, { cwd: tmpRoot });

    process.chdir(wtDir);
    const cfg = reloadConfig();
    assert.strictEqual(cfg.projectDir, tmpRoot, 'projectDir should be the main repo (git-aware) when in a worktree');
    console.log('PASS: git-aware discovery resolves worktree → main repo');
  } finally {
    process.chdir(origCwd);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
})();

console.log('\n✅ All config tests passed\n');

} finally {
  removeTmp();
}
