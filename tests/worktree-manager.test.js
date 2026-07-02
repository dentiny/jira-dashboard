// tests/worktree-manager.test.js — lifecycle tests for the worktree manager.
// The manager is the db/config-aware layer over worktree-pool.js. We inject a
// mock config + in-memory db (mirroring coder.test.js) and drive acquire/
// release against a real throwaway git repo in both pooled and per-ticket
// modes.

let assert;
try { assert = require('assert'); } catch { assert = require('node:assert'); }

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const realPool = require('../worktree-pool');

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function makeRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-mgr-test-'));
  sh('git init -q -b main', tmp);
  sh('git config user.email test@test.local', tmp);
  sh('git config user.name test', tmp);
  sh('git config commit.gpgsign false', tmp);
  fs.writeFileSync(path.join(tmp, 'README.md'), 'main v1\n');
  sh('git add README.md', tmp);
  sh('git commit -q -m "v1"', tmp);
  return tmp;
}

function cleanupRepo(repoDir) {
  try { sh('git worktree prune', repoDir); } catch {}
  fs.rmSync(repoDir, { recursive: true, force: true });
}

// Load a fresh worktree-manager wired to a mock config + in-memory db.
function loadManager({ numWorktrees, projectDir }) {
  const configPath = require.resolve('../config');
  const dbPath = require.resolve('../db');
  const mgrPath = require.resolve('../worktree-manager');
  delete require.cache[mgrPath];

  const tickets = {};
  const activity = [];
  const dbMock = {
    getTicket: (id) => (tickets[id] ? { ...tickets[id] } : undefined),
    getAllTickets: () => Object.values(tickets).map((t) => ({ ...t })),
    updateTicket: (id, fields) => { tickets[id] = { ...(tickets[id] || { id }), ...fields }; },
    updateTicketField: (id, field, value) => { tickets[id] = { ...(tickets[id] || { id }), [field]: value }; },
    logActivity: (id, action, detail) => { activity.push({ id, action, detail }); },
  };
  const configMock = {
    numWorktrees,
    projectDir,
    worktreesDir: path.join(projectDir, '.worktrees'),
    branchDefault: 'main',
    coder: { timeouts: { command: 30_000 } },
  };
  require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: configMock };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };

  const manager = require('../worktree-manager');
  return { manager, tickets, activity, configMock };
}

function unloadManager() {
  delete require.cache[require.resolve('../worktree-manager')];
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../db')];
}

// ── Per-ticket mode (numWorktrees = 0): create on acquire, remove on release ──
(function testPerTicketMode() {
  const repo = makeRepo();
  try {
    const { manager, tickets } = loadManager({ numWorktrees: 0, projectDir: repo });
    tickets['abc'] = { id: 'abc', worktree_path: null, branch_name: null };

    const { worktreePath, branchName } = manager.acquire({ id: 'abc', worktree_path: null, branch_name: null });
    assert.strictEqual(branchName, 'feature/abc', 'branch name derived from ticket id');
    assert.strictEqual(worktreePath, path.join(repo, '.worktrees', 'abc'), 'per-ticket worktree path');
    assert.ok(realPool.isValidWorktree(worktreePath), 'worktree created');
    assert.strictEqual(sh('git rev-parse --abbrev-ref HEAD', worktreePath), 'feature/abc', 'on feature branch');
    assert.strictEqual(tickets['abc'].worktree_path, worktreePath, 'db records worktree path');

    manager.release('abc');
    assert.ok(!fs.existsSync(worktreePath), 'per-ticket worktree removed on release');
    assert.strictEqual(tickets['abc'].worktree_path, null, 'db worktree path cleared');
    assert.strictEqual(sh('git branch --list feature/abc', repo), '', 'feature branch deleted');

    console.log('PASS: per-ticket mode creates on acquire and removes on release');
  } finally {
    unloadManager();
    cleanupRepo(repo);
  }
})();

// ── Pooled mode (numWorktrees > 0): reuse slots, cap parallelism, recycle ──
(function testPooledMode() {
  const repo = makeRepo();
  try {
    const worktreesDir = path.join(repo, '.worktrees');
    realPool.provisionPool({ projectDir: repo, worktreesDir, branchDefault: 'main', count: 2 });

    const { manager, tickets } = loadManager({ numWorktrees: 2, projectDir: repo });
    tickets['t1'] = { id: 't1', worktree_path: null, branch_name: null };
    tickets['t2'] = { id: 't2', worktree_path: null, branch_name: null };
    tickets['t3'] = { id: 't3', worktree_path: null, branch_name: null };

    const a1 = manager.acquire(tickets['t1']);
    const a2 = manager.acquire(tickets['t2']);
    assert.ok(realPool.isPoolWorktree(worktreesDir, a1.worktreePath), 't1 got a pool slot');
    assert.ok(realPool.isPoolWorktree(worktreesDir, a2.worktreePath), 't2 got a pool slot');
    assert.notStrictEqual(a1.worktreePath, a2.worktreePath, 'distinct slots for distinct tickets');

    // Pool is now full → third ticket throws PoolFullError.
    let threw = null;
    try { manager.acquire(tickets['t3']); } catch (e) { threw = e; }
    assert.ok(threw && threw.code === 'POOL_FULL', 'full pool raises PoolFullError');

    // Re-acquiring t1 reuses its existing slot (no new slot consumed).
    const a1again = manager.acquire(tickets['t1']);
    assert.strictEqual(a1again.worktreePath, a1.worktreePath, 're-acquire reuses the same slot');

    // Release t1 → slot returns to the pool (dir preserved, detached, clean).
    manager.release('t1');
    assert.ok(fs.existsSync(a1.worktreePath), 'released pool slot dir is preserved');
    assert.strictEqual(sh('git rev-parse --abbrev-ref HEAD', a1.worktreePath), 'HEAD', 'slot back on detached HEAD');
    assert.strictEqual(tickets['t1'].worktree_path, null, 'db cleared for released ticket');

    // Now t3 can acquire the freed slot.
    const a3 = manager.acquire(tickets['t3']);
    assert.strictEqual(a3.worktreePath, a1.worktreePath, 't3 reuses the slot t1 freed');

    console.log('PASS: pooled mode reuses slots, caps parallelism, and recycles on release');
  } finally {
    unloadManager();
    cleanupRepo(repo);
  }
})();

// ── freshDefaultBase resolves the CURRENT origin tip, not the stale local ref.
//    This is the base the standalone "rebase" button rebases onto, so a ticket
//    rebases against latest origin/<default> rather than a drifted local ref. ──
(function testFreshDefaultBaseResolvesOriginTip() {
  const origin = makeRepo(); // acts as the remote
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-mgr-clone-'));
  try {
    sh(`git clone -q ${origin} ${clone}`, os.tmpdir());
    sh('git config user.email test@test.local', clone);
    sh('git config user.name test', clone);
    sh('git config commit.gpgsign false', clone);

    const { manager } = loadManager({ numWorktrees: 0, projectDir: clone });

    // Upstream advances after the clone — local main is now stale.
    fs.writeFileSync(path.join(origin, 'upstream.txt'), 'new upstream work\n');
    sh('git add upstream.txt', origin);
    sh('git commit -q -m "upstream advances"', origin);
    const originTip = sh('git rev-parse main', origin);
    const staleLocalTip = sh('git rev-parse main', clone);
    assert.notStrictEqual(originTip, staleLocalTip, 'precondition: local main is behind origin/main');

    const base = manager.freshDefaultBase(clone);
    assert.strictEqual(base, 'origin/main', 'resolves the remote-tracking ref after fetching');
    assert.strictEqual(sh(`git rev-parse ${base}`, clone), originTip, 'base points at the fresh origin tip');

    console.log('PASS: freshDefaultBase resolves the fresh origin tip for rebase');
  } finally {
    unloadManager();
    cleanupRepo(origin);
    cleanupRepo(clone);
  }
})();

console.log('\n✅ All worktree-manager tests passed\n');
