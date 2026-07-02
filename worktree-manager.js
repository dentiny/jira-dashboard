// worktree-manager.js — ticket ⇄ worktree lifecycle.
//
// Bridges the pure git primitives in worktree-pool.js with the ticket DB and
// config, and hides the pool-vs-per-ticket decision behind three functions
// (acquire / release / isValidWorktree) so server.js never has to branch on
// config.numWorktrees or reach into the pool directly.
//
//   config.numWorktrees > 0  → pooled mode: tickets check out one of the
//                              pre-created pool slots and return it on close.
//   config.numWorktrees == 0 → per-ticket mode: one throwaway worktree per
//                              ticket, created on acquire, deleted on release.

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const config = require('./config');
const db = require('./db');
const pool = require('./worktree-pool');

// Thrown by acquire() in pooled mode when no slot is free. server.js maps this
// to an HTTP 409 rather than treating it as an implementation failure.
class PoolFullError extends Error {
  constructor(count) {
    super(`All ${count} worktree slots are in use. Finish or close another ticket first.`);
    this.name = 'PoolFullError';
    this.code = 'POOL_FULL';
  }
}

function isPoolMode() {
  return config.numWorktrees > 0;
}

// A worktree directory is usable (has a `.git` entry).
function isValidWorktree(wt) {
  return pool.isValidWorktree(wt);
}

// True when `wt` is one of the pre-created pool slots (<worktreesDir>/pool-N).
function isPoolWorktree(wt) {
  return pool.isPoolWorktree(config.worktreesDir, wt);
}

function safeId(ticketId) {
  return String(ticketId).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
}

function branchNameFor(ticketId) {
  return `feature/${safeId(ticketId)}`;
}

// Creating a per-ticket worktree writes a full working tree and, after the
// upstream fetch, may check out a tip far ahead of local state — as costly as
// the pool's initial `worktree add`. Give that one call the same generous
// ceiling the pool uses (worktree-pool ADD_TIMEOUT) rather than the 30s command
// default, or a big monorepo checkout hits ETIMEDOUT.
const WORKTREE_ADD_TIMEOUT = 900_000; // 15 min

// git in the main checkout (or a given worktree). Mirrors server.js's runGit
// timeout by default, but with a large buffer so big `git worktree list` /
// status output can't overflow (ENOBUFS). Pass `timeout` to override for
// operations (like `worktree add`) that legitimately run longer.
function git(args, cwd, timeout = config.coder.timeouts.command) {
  return execSync(`git ${args}`, {
    cwd: cwd || config.projectDir,
    encoding: 'utf-8',
    timeout,
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

function ensureWorktreesDir() {
  if (!fs.existsSync(config.worktreesDir)) {
    fs.mkdirSync(config.worktreesDir, { recursive: true });
  }
}

// Claim a free pool slot for a ticket and check out its feature branch.
// Returns { worktreePath, branchName } or null when every slot is in use.
function acquirePoolSlot(ticket, branchName) {
  const claimed = new Set(
    db.getAllTickets()
      .filter((t) => t.id !== ticket.id && t.worktree_path)
      .map((t) => path.resolve(t.worktree_path))
  );
  for (const wt of pool.poolPaths(config.worktreesDir, config.numWorktrees)) {
    if (claimed.has(path.resolve(wt))) continue;   // held by another ticket
    if (!pool.isValidWorktree(wt)) continue;        // not provisioned — skip
    try {
      pool.acquireSlot({ worktreePath: wt, branchDefault: config.branchDefault, branchName });
    } catch (e) {
      db.logActivity(ticket.id, 'worktree_acquire_warn',
        `slot ${wt} failed to prep: ${e.message.slice(0, 120)}`);
      continue; // corrupt slot — try the next one
    }
    return { worktreePath: wt, branchName };
  }
  return null;
}

// Set up (or reuse) a worktree for a ticket and record it on the ticket row.
// Returns { worktreePath, branchName }. Throws PoolFullError in pooled mode
// when no slot is free.
function acquire(ticket) {
  ensureWorktreesDir();
  const branchName = branchNameFor(ticket.id);
  let worktreePath;

  if (isPoolMode()) {
    // Reuse this ticket's slot if it still holds one (e.g. a review →
    // re-implement cycle), otherwise claim a free slot. The pool size caps
    // how many tickets can be in flight at once.
    if (pool.isValidWorktree(ticket.worktree_path) && ticket.branch_name) {
      worktreePath = ticket.worktree_path;
    } else {
      const slot = acquirePoolSlot(ticket, branchName);
      if (!slot) throw new PoolFullError(config.numWorktrees);
      worktreePath = slot.worktreePath;
      db.logActivity(ticket.id, 'worktree_acquired', worktreePath);
    }
  } else {
    // Per-ticket mode: one throwaway worktree per ticket, deleted on close.
    worktreePath = path.join(config.worktreesDir, safeId(ticket.id));
    const dirHere = fs.existsSync(worktreePath);
    const tracked = (() => {
      try { return git('worktree list').includes(worktreePath); }
      catch { return false; }
    })();
    console.log(`[implement] ${ticket.id} dirHere=${dirHere} tracked=${tracked} path=${worktreePath}`);

    if (!(dirHere && tracked)) {
      // Clean up any orphan directory (left over from a crashed previous run)
      // so `git worktree add` can create a fresh linked worktree.
      if (dirHere) fs.rmSync(worktreePath, { recursive: true, force: true });

      // Drop any stale branch from a previous attempt.
      try { git(`branch -D ${branchName}`); } catch { /* no stale branch */ }

      // Create the worktree with a fresh branch off the default branch in one
      // step. This NEVER touches the main checkout's working tree — it's a
      // metadata operation that writes a new branch ref and worktree dir. Base
      // off the freshly-fetched upstream tip, not the stale local ref, so a new
      // ticket doesn't start weeks behind origin (see pool.freshDefaultBase).
      const base = pool.freshDefaultBase({ cwd: config.projectDir, branchDefault: config.branchDefault });
      git(`worktree add -b ${branchName} ${worktreePath} ${base}`, undefined, WORKTREE_ADD_TIMEOUT);
    }
  }

  db.updateTicket(ticket.id, { worktree_path: worktreePath, branch_name: branchName });
  db.logActivity(ticket.id, 'worktree_created', worktreePath);
  return { worktreePath, branchName };
}

// Resolve the freshest base ref to rebase/branch a ticket against, refreshing
// from the remote first. Thin wrapper over pool.freshDefaultBase that supplies
// the configured default branch, so server.js gets the current origin tip
// (e.g. origin/develop) without reaching into the pool or repeating the
// fetch/fallback logic. See worktree-pool.freshDefaultBase for the rationale.
function freshDefaultBase(cwd) {
  return pool.freshDefaultBase({ cwd, branchDefault: config.branchDefault });
}

// Detach a ticket from its worktree when it closes or is deleted. Pooled slots
// are reset and returned to the pool (never removed); per-ticket worktrees are
// removed along with their branch. Idempotent and best-effort.
function release(ticketId) {
  const t = db.getTicket(ticketId);
  if (!t) return;
  const wt = t.worktree_path;
  const bn = t.branch_name;

  if (isPoolMode() && isPoolWorktree(wt)) {
    pool.releaseSlot({ worktreePath: wt, branchDefault: config.branchDefault, branchName: bn });
    db.updateTicket(ticketId, { worktree_path: null, branch_name: null });
    db.logActivity(ticketId, 'worktree_released', wt || '(none)');
    return;
  }

  if (wt) {
    try { git(`worktree remove --force ${wt}`); }
    catch (e) { db.logActivity(ticketId, 'cleanup_warn', `worktree remove failed (non-fatal): ${e.message}`); }
  }
  if (bn) {
    try { git(`branch -D ${bn}`); }
    catch (e) { db.logActivity(ticketId, 'cleanup_warn', `branch delete failed (non-fatal): ${e.message}`); }
  }
  if (wt && fs.existsSync(wt)) {
    try { fs.rmSync(wt, { recursive: true, force: true }); }
    catch (e) { db.logActivity(ticketId, 'cleanup_warn', `rm worktree dir failed (non-fatal): ${e.message}`); }
  }
  db.updateTicket(ticketId, { worktree_path: null, branch_name: null });
}

module.exports = {
  PoolFullError,
  acquire,
  release,
  freshDefaultBase,
  isValidWorktree,
  isPoolWorktree,
};
