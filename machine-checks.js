const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { detectType } = require('./coder');

function isGhUsed(config) {
  // Detect whether the project uses GitHub (and therefore needs gh CLI)
  try {
    const remote = execSync('git remote get-url origin', { cwd: config.projectDir, timeout: 3000, encoding: 'utf-8' }).trim().toLowerCase();
    return remote.includes('github') || remote.includes('gitent');
  } catch {
    return false; // no remote → no GitHub → gh not needed
  }
}

function runMachineChecks(config) {
  const checks = [];
  const ghNeeded = isGhUsed(config);

  // ── gh CLI ──
  try {
    const ver = execSync('gh --version', { timeout: 5000, encoding: 'utf-8' }).trim();
    checks.push({ name: 'gh CLI', status: 'ok', detail: ver.split('\n')[0] });
  } catch {
    checks.push({ name: 'gh CLI', status: ghNeeded ? 'fail' : 'warn', detail: 'gh CLI not found' + (ghNeeded ? ' — required for PR operations' : ' (not needed — no GitHub remote detected)') });
  }

  // ── gh auth status ──
  try {
    execSync('gh auth status', { timeout: 5000, encoding: 'utf-8' });
    checks.push({ name: 'gh auth', status: 'ok', detail: 'Authenticated' });
  } catch {
    checks.push({ name: 'gh auth', status: ghNeeded ? 'fail' : 'warn', detail: 'gh not authenticated' + (ghNeeded ? ' — run gh auth login' : ' (not needed — no GitHub remote detected)') });
  }

  // ── gh api graphql (needed by pr-checker and coder for review comments) ──
  try {
    execSync('gh api graphql -f query=\'{__typename}\'', { timeout: 5000, encoding: 'utf-8' });
    checks.push({ name: 'gh api graphql', status: 'ok', detail: 'GraphQL API reachable' });
  } catch {
    checks.push({ name: 'gh api graphql', status: ghNeeded ? 'fail' : 'warn', detail: 'gh api graphql failed' + (ghNeeded ? ' — check authentication and host configuration' : ' (not needed — no GitHub remote detected)') });
  }

  // ── Coder permission check ──
  // Different coders have different permission models. Check for known issues.
  const coderType = detectType(config);
  if (coderType === 'claude') {
    const settingsPath = path.join(config.projectDir, '.claude', 'settings.json');
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const askList = settings.permissions?.ask || [];
      if (askList.some(p => String(p).includes('gh api'))) {
        checks.push({
          name: 'coder permissions',
          status: 'warn',
          detail: `gh api is in Claude "ask" list (${settingsPath}) — coder may not be able to run gh api graphql. Move the pattern to "allow" or remove it from "ask".`,
        });
      }
    } catch {
      // settings file missing or invalid — not a problem
    }
  }

  return checks;
}

module.exports = { runMachineChecks };
