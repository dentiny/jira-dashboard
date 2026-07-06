// worktree-pool.js — git-worktree pool primitives.
//
// Pure git operations, no DB and no config coupling: every function takes its
// inputs explicitly. This lets the same code run both inside the server
// (runtime acquire/release) and from the installer (idempotent provisioning),
// and makes the logic unit-testable against a throwaway repo.
//
// Pool model:
//   - A pool worktree lives at <worktreesDir>/pool-<i> and is left on a
//     DETACHED HEAD at the default branch when idle. Detached HEAD is what
//     lets many pool worktrees coexist (git forbids two worktrees on the same
//     branch).
//   - Acquiring for a ticket resets the worktree clean and checks out a fresh
//     feature branch off the default branch.
//   - Releasing resets the worktree clean, detaches back to the default
//     branch, and deletes the feature branch — the directory is reused, never
//     removed.

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Generous limits deliberately: pool operations run against large monorepos
// where a stingy maxBuffer overflows (ENOBUFS) and a short timeout aborts a
// legitimate checkout (ETIMEDOUT). `git worktree add` in particular writes a
// full working tree and can take minutes on a big repo.
const MAX_BUFFER = 256 * 1024 * 1024; // 256 MB
const DEFAULT_TIMEOUT = 300_000; // 5 min for resets/checkouts
const ADD_TIMEOUT = 900_000; // 15 min for the initial worktree checkout
const FETCH_TIMEOUT = 600_000; // 10 min: first fetch of a big monorepo branch

function git(args, cwd, timeout = DEFAULT_TIMEOUT) {
  return execSync(`git ${args}`, {
    cwd,
    encoding: 'utf-8',
    timeout,
    maxBuffer: MAX_BUFFER,
  }).trim();
}

function execAsync(command, cwd, timeout) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, timeout, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout.trim());
    });
  });
}

function gitAsync(args, cwd, timeout) {
  return execAsync(`git ${args}`, cwd, timeout);
}

// Resolve the freshest base ref to branch/rebase a ticket off, refreshing from
// the remote first. Pool worktrees are long-lived and nothing else fetches, so
// the LOCAL default-branch ref (e.g. `develop`) drifts behind origin — observed
// ~2 weeks stale on a busy monorepo — and every ticket would start off (or
// rebase onto) an ancient base. We fetch the default branch from `remote`
// (best-effort) and prefer the updated `<remote>/<branchDefault>` remote-
// tracking ref; if there is no remote (offline / local-only repo) or the fetch
// fails, we fall back to the local ref so those setups still work. Returns a ref
// name suitable for `checkout -B` / `worktree add` / `rebase`.
// The fetch runs asynchronously so the event loop stays responsive on large repos.
async function freshDefaultBase({ cwd, branchDefault, remote = 'origin' }) {
  const remoteRef = `${remote}/${branchDefault}`;
  try {
    // A single-branch fetch updates the <remote>/<branch> tracking ref on a
    // standard clone; keep it scoped so we don't pull every branch of a monorepo.
    await gitAsync(`fetch ${remote} ${branchDefault}`, cwd, FETCH_TIMEOUT);
  } catch { /* offline or no such remote — fall back to the local ref below */ }
  try {
    git(`rev-parse --verify --quiet ${remoteRef}^{commit}`, cwd);
    return remoteRef;
  } catch {
    return branchDefault;
  }
}

// Absolute path of the i-th pool worktree.
function poolPaths(worktreesDir, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(path.join(worktreesDir, `pool-${i}`));
  }
  return out;
}

// A worktree directory is usable iff it contains a `.git` (file, for linked
// worktrees) entry.
function isValidWorktree(wt) {
  return !!wt && fs.existsSync(path.join(wt, '.git'));
}

// True when `wt` is one of the pool's own slots (<worktreesDir>/pool-<n>).
// Used to decide release-vs-remove; matches any index so shrinking the pool
// still recognizes an over-count slot a ticket may still hold.
function isPoolWorktree(worktreesDir, wt) {
  if (!wt) return false;
  const r = path.resolve(wt);
  return path.dirname(r) === path.resolve(worktreesDir) && /^pool-\d+$/.test(path.basename(r));
}

// Idempotent: ensure exactly `count` detached pool worktrees exist under
// `worktreesDir`. Existing valid slots are kept, missing ones are created,
// and any pool-<n> with n >= count is removed. Safe to run repeatedly.
function provisionPool({ projectDir, worktreesDir, branchDefault, count }) {
  fs.mkdirSync(worktreesDir, { recursive: true });
  try { git('worktree prune', projectDir); } catch { /* best-effort */ }

  const created = [];
  const kept = [];
  const removed = [];

  for (const wt of poolPaths(worktreesDir, count)) {
    if (isValidWorktree(wt)) { kept.push(wt); continue; }
    // Clear a stale orphan directory (crashed prior run) so `worktree add`
    // gets a clean target.
    if (fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true });
    git(`worktree add --detach ${wt} ${branchDefault}`, projectDir, ADD_TIMEOUT);
    created.push(wt);
  }

  // Shrink: drop pool slots beyond the requested count.
  if (fs.existsSync(worktreesDir)) {
    for (const name of fs.readdirSync(worktreesDir)) {
      const m = /^pool-(\d+)$/.exec(name);
      if (!m || parseInt(m[1], 10) < count) continue;
      const wt = path.join(worktreesDir, name);
      try { git(`worktree remove --force ${wt}`, projectDir); } catch { /* best-effort */ }
      if (fs.existsSync(wt)) {
        try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
      removed.push(wt);
    }
  }

  try { git('worktree prune', projectDir); } catch { /* best-effort */ }
  return { created, kept, removed };
}

// Reset a pool worktree to a clean checkout of a fresh feature branch, ready
// for a ticket. Assumes the slot is a valid (idle, detached) pool worktree.
// Async so the event loop stays responsive during fetch + checkout on large repos.
async function acquireSlot({ worktreePath, branchDefault, branchName, remote = 'origin' }) {
  try { git('rebase --abort 2>/dev/null', worktreePath); } catch { /* no rebase in progress */ }
  git('reset --hard', worktreePath);
  git('clean -fd', worktreePath);
  // Refresh from the remote and branch off the CURRENT upstream tip rather than
  // the stale local ref (see freshDefaultBase). -B creates or resets the feature
  // branch at that tip and checks it out. Unlike the old base (the local ref the
  // idle slot already sat on, a metadata-only move), the fresh upstream tip can
  // be far ahead — the checkout then rewrites the whole working tree, which on a
  // large monorepo is as costly as the initial `worktree add`, so it gets the
  // longer ADD_TIMEOUT rather than the 5-min default.
  const base = await freshDefaultBase({ cwd: worktreePath, branchDefault, remote });
  await gitAsync(`checkout -B ${branchName} ${base}`, worktreePath, ADD_TIMEOUT);
}

// Return a pool worktree to its idle state: clean, detached at the default
// branch, feature branch deleted. The directory itself is preserved for reuse.
// Async so the event loop stays responsive during checkout on large repos.
async function releaseSlot({ worktreePath, branchDefault, branchName }) {
  if (!isValidWorktree(worktreePath)) return;
  try { git('rebase --abort 2>/dev/null', worktreePath); } catch { /* no rebase in progress */ }
  try { git('reset --hard', worktreePath); } catch { /* best-effort */ }
  try { git('clean -fd', worktreePath); } catch { /* best-effort */ }
  // Detach first so the feature branch is no longer checked out and can be
  // deleted from within this same worktree.
  try { await gitAsync(`checkout --detach ${branchDefault}`, worktreePath); } catch { /* best-effort */ }
  if (branchName) {
    try { git(`branch -D ${branchName}`, worktreePath); } catch { /* branch already gone */ }
  }
}

module.exports = {
  poolPaths,
  isValidWorktree,
  isPoolWorktree,
  freshDefaultBase,
  provisionPool,
  acquireSlot,
  releaseSlot,
};
