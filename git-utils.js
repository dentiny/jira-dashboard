const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const config = require('./config');
const { escShell } = require('./helpers');

function runGit(args, cwd) {
  return require('child_process').execSync(`git ${args}`, {
    cwd: cwd || config.projectDir,
    encoding: 'utf-8',
    timeout: config.coder.timeouts.command,
  }).trim();
}

function execAsync(command, cwd, timeout, onSpawn) {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-lc', command], { cwd, timeout, detached: true });
    if (onSpawn) onSpawn(proc);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error((err || out).trim() || `command exited with code ${code}`));
    });
  });
}

function resolveDiffBase(worktreePath) {
  const base = config.branchDefault;
  let best = null;
  let bestCount = Infinity;
  for (const ref of [`origin/${base}`, base]) {
    let branchPoint;
    try { branchPoint = runGit(`merge-base ${ref} HEAD`, worktreePath); } catch { continue; }
    let count;
    try { count = parseInt(runGit(`rev-list --count ${branchPoint}..HEAD`, worktreePath), 10); } catch { continue; }
    if (Number.isFinite(count) && count < bestCount) {
      bestCount = count;
      best = branchPoint;
    }
  }
  return best || base;
}

function popStashAndStage(worktreePath) {
  try { runGit(`stash pop`, worktreePath); } catch {}
  runGit(`add -A`, worktreePath);
}

function isWorktreeDirty(statusOutput) {
  return !!(statusOutput && statusOutput.trim());
}

function assertWorktreeClean(ticket, { stage, allow = false } = {}) {
  const db = require('./db');
  if (!ticket || !ticket.worktree_path) return;
  if (!fs.existsSync(path.join(ticket.worktree_path, '.git'))) return;
  let status = '';
  try {
    status = runGit(`status --porcelain`, ticket.worktree_path);
  } catch {
    return;
  }
  if (!allow && isWorktreeDirty(status)) {
    db.logActivity(ticket.id, 'worktree_uncommitted',
      `After ${stage}: ${status.slice(0, 200).replace(/\n/g, ' | ')}`);
  }
}

function getBranchStaleness(worktreePath) {
  if (!worktreePath || !fs.existsSync(path.join(worktreePath, '.git'))) return null;
  try {
    const count = runGit(`rev-list --count HEAD..${config.branchDefault}`, worktreePath);
    return parseInt(count, 10) || 0;
  } catch {
    return null;
  }
}

function commitWorktreeChanges(worktreePath, ticketId, message, { partial = false } = {}) {
  const db = require('./db');
  const tag = partial ? 'commit_partial' : 'commit';
  try {
    const status = runGit(`status --porcelain`, worktreePath);
    if (!status) {
      db.logActivity(ticketId, 'commit_skipped', 'no uncommitted changes in worktree');
      return null;
    }
    runGit(`add -A`, worktreePath);
    runGit(`commit -m "${escShell(message)}"`, worktreePath);
    const sha = runGit(`rev-parse HEAD`, worktreePath);
    db.logActivity(ticketId, tag, `${sha.slice(0, 7)}: ${message.replace(/"/g, '')}`);
    return sha;
  } catch (err) {
    db.logActivity(ticketId, 'commit_failed', err.message.slice(0, 200));
    return null;
  }
}

module.exports = {
  runGit,
  execAsync,
  resolveDiffBase,
  popStashAndStage,
  isWorktreeDirty,
  assertWorktreeClean,
  getBranchStaleness,
  commitWorktreeChanges,
};
