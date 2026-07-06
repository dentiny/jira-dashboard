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

// Resolve the base ref for a new ticket branch. Returns the remote-tracking ref
// (e.g. origin/develop) if it exists locally — no fetch is performed, since a
// long fetch can timeout on large monorepos and the remote-tracking ref from
// a previous fetch is still far more recent than the local branch. Falls back
// to the local branch when there is no remote at all (offline / local-only repo).
function freshDefaultBase({ cwd, branchDefault, remote = 'origin' }) {
  const remoteRef = `${remote}/${branchDefault}`;
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
// for a new ticket. Does NOT fetch — the remote-tracking ref from the previous
// fetch (e.g. origin/develop) is used directly, even if slightly stale, because
// a fetch on a large monorepo can timeout leaving the worktree in a bad state.
//
// Strategy:
//   1. hard-reset to the remote-tracking ref (rewrites working tree)
//   2. clean untracked files
//   3. create/reset the feature branch at HEAD (metadata-only, no checkout)
//   4. verify the worktree is clean — if reset was interrupted, fail fast
//      rather than letting the coder's `git add -A` sweep in partial state.
async function acquireSlot({ worktreePath, branchDefault, branchName, remote = 'origin' }) {
  try { git('rebase --abort 2>/dev/null', worktreePath); } catch { /* no rebase in progress */ }
  const base = freshDefaultBase({ cwd: worktreePath, branchDefault, remote });
  // Hard-reset rewrites the working tree — can be slow on large repos, so
  // run it async to keep the event loop responsive.
  await gitAsync(`reset --hard ${base}`, worktreePath);
  await gitAsync('clean -fd', worktreePath);
  // checkout -B with no start-point uses HEAD, which is already at `base`
  // after the reset — this is a metadata-only branch creation, no checkout.
  git(`checkout -B ${branchName}`, worktreePath);
  const status = git('status --porcelain', worktreePath);
  if (status) {
    throw new Error(`Worktree not clean after checkout: ${status.slice(0, 200)}`);
  }
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
