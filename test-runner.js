const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const config = require('./config');

function detectTestFramework(worktreePath) {
  if (!worktreePath || !fs.existsSync(worktreePath)) return null;

  const has = (p) => fs.existsSync(path.join(worktreePath, p));
  const read = (p) => { try { return fs.readFileSync(path.join(worktreePath, p), 'utf-8'); } catch { return ''; } };

  if (config.test.commandOverride) {
    return { framework: 'custom', command: config.test.commandOverride };
  }

  if (has('package.json')) {
    try {
      const pkg = JSON.parse(read('package.json'));
      if (pkg.scripts && pkg.scripts.test && pkg.scripts.test.trim() !== 'echo "Error: no test specified" && exit 1') {
        return { framework: 'npm', command: 'npm test --silent' };
      }
    } catch {}
  }

  if (has('go.mod')) {
    return { framework: 'go', command: 'go test ./...' };
  }

  if (has('Cargo.toml')) {
    return { framework: 'cargo', command: 'cargo test --quiet' };
  }

  if (has('pyproject.toml')) {
    const pyproject = read('pyproject.toml');
    const nameMatch = pyproject.match(/name\s*=\s*["']([^"']+)["']/);
    const pkgName = nameMatch ? nameMatch[1] : null;
    const isKnownProject = pkgName === config.projectName;

    if (isKnownProject) {
      const py = config.venvPython();
      const envOverride = `PYTHONPATH=${path.join(config.projectDir, 'src')}`;
      const cmd = config.test.commandOverride || `${envOverride} ${py} -m ${config.projectName}.test`;
      return { framework: 'pytest', command: cmd };
    }
  }

  if (has('pyproject.toml') || has('pytest.ini') || has('setup.py') || has('tests/') || has('test/')) {
    const py = config.venvPython();
    return { framework: 'pytest', command: `${py} -m pytest -x --tb=short -q` };
  }

  if (has('scripts/test.sh')) return { framework: 'shell', command: 'bash scripts/test.sh' };
  if (has('scripts/run-tests.sh')) return { framework: 'shell', command: 'bash scripts/run-tests.sh' };

  return null;
}

function execTestCommand(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const finish = (status, extra = {}) => {
      if (resolved) return;
      resolved = true;
      resolve({
        status,
        exit_code: extra.exit_code ?? null,
        output: (stdout + (stderr ? '\n--- stderr ---\n' + stderr : '')).slice(-64 * 1024),
        duration_ms: Date.now() - start,
      });
    };

    let proc;
    try {
      proc = spawn('bash', ['-lc', command], {
        cwd,
        env: { ...process.env, PYTHONPATH: path.join(config.projectDir, config.venv.pythonpath) },
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return finish('error', { exit_code: -1, output: 'spawn error: ' + err.message });
    }
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      finish(code === 0 ? 'pass' : 'fail', { exit_code: code });
    });
    proc.on('error', err => finish('error', { exit_code: -1, output: 'proc error: ' + err.message }));
  });
}

function parseTestSummary(output) {
  if (!output) return null;
  const m = output.match(/(\d+)\s+passed(?:.*?(\d+)\s+failed)?(?:.*?(\d+)\s+error(?:ed|s)?)?(?:.*?(\d+)\s+skipped)?/i);
  if (m && (m[1] || m[2])) {
    return {
      passed: parseInt(m[1] || '0', 10),
      failed: parseInt(m[2] || '0', 10),
      errored: parseInt(m[3] || '0', 10),
      skipped: parseInt(m[4] || '0', 10),
    };
  }
  const goOk = (output.match(/^ok\s/gm) || []).length;
  const goFail = (output.match(/^FAIL\s/gm) || []).length;
  if (goOk + goFail > 0) return { passed: goOk, failed: goFail, errored: 0, skipped: 0 };
  const cargoPass = (output.match(/test result: ok\.\s+(\d+)\s+passed/) || [])[1];
  if (cargoPass) return { passed: parseInt(cargoPass, 10), failed: 0, errored: 0, skipped: 0 };
  return null;
}

function formatSummary(parsed, status) {
  if (!parsed) return status === 'pass' ? 'All tests passed' : (status === 'fail' ? 'Tests failed' : status);
  const parts = [];
  if (parsed.passed)  parts.push(`${parsed.passed} passed`);
  if (parsed.failed)  parts.push(`${parsed.failed} failed`);
  if (parsed.errored) parts.push(`${parsed.errored} errored`);
  if (parsed.skipped) parts.push(`${parsed.skipped} skipped`);
  return parts.length ? parts.join(', ') : status;
}

function runTicketTests(ticketId, triggeredBy = 'auto') {
  const db = require('./db');
  const { sseBroadcast } = require('./sse');

  const ticket = db.getTicket(ticketId);
  if (!ticket) return null;

  if (triggeredBy === 'auto' && !config.test.enabled) return null;

  const wt = ticket.worktree_path;
  if (!wt || !fs.existsSync(wt)) {
    const runId = db.createTestRun(ticketId, null, null, triggeredBy);
    db.finalizeTestRun(runId, {
      status: 'skip', output: 'No worktree available — tests skipped.',
      summary: 'skipped (no worktree)',
    });
    sseBroadcast(ticketId, 'test_status', { run_id: runId, status: 'skip' });
    return runId;
  }

  const det = detectTestFramework(wt);
  if (!det) {
    const runId = db.createTestRun(ticketId, null, null, triggeredBy);
    db.finalizeTestRun(runId, {
      status: 'skip',
      output: 'No recognized test framework in worktree (looked for npm/go/cargo/pytest).',
      summary: 'skipped (no framework detected)',
    });
    sseBroadcast(ticketId, 'test_status', { run_id: runId, status: 'skip' });
    return runId;
  }

  const runId = db.createTestRun(ticketId, det.framework, det.command, triggeredBy);
  sseBroadcast(ticketId, 'test_status', { run_id: runId, status: 'running', framework: det.framework });

  (async () => {
    const result = await execTestCommand(det.command, wt, config.test.timeout);
    const parsed = parseTestSummary(result.output);
    const summary = formatSummary(parsed, result.status);
    const row = db.finalizeTestRun(runId, { ...result, summary });
    db.logActivity(ticketId, 'test_' + result.status,
      `${det.framework}: ${summary} (${Math.round((result.duration_ms || 0) / 100) / 10}s)`);
    sseBroadcast(ticketId, 'test_status', {
      run_id: runId, status: row.status, framework: det.framework,
      summary: row.summary, exit_code: row.exit_code, duration_ms: row.duration_ms,
    });
  })().catch(err => {
    db.finalizeTestRun(runId, { status: 'error', output: 'runner crash: ' + err.message });
    sseBroadcast(ticketId, 'test_status', { run_id: runId, status: 'error' });
  });

  return runId;
}

function buildTestContextForPrompt(ticketId) {
  const db = require('./db');
  const latest = db.getLatestTestRun(ticketId);
  if (!latest) return '';
  if (latest.status === 'running') return '';
  const lines = [];
  lines.push(`Last unit-test run (${latest.triggered_by || 'auto'}, ${new Date(latest.started_at).toISOString()}):`);
  lines.push(`  framework: ${latest.framework || '(unknown)'}`);
  lines.push(`  command:   ${latest.command || '(unknown)'}`);
  lines.push(`  status:    ${latest.status}`);
  if (latest.summary) lines.push(`  summary:   ${latest.summary}`);
  if (latest.exit_code != null) lines.push(`  exit_code: ${latest.exit_code}`);
  if (latest.output && latest.status !== 'pass') {
    const tail = latest.output.split('\n').slice(-60).join('\n');
    lines.push('  output (last 60 lines):');
    lines.push(tail.split('\n').map(l => '    ' + l).join('\n'));
  }
  if (latest.status === 'fail' || latest.status === 'error') {
    lines.push('');
    lines.push('The previous implementation FAILED these tests. You may either:');
    lines.push('  (a) ask clarifying questions about the failures, OR');
    lines.push('  (b) propose a fix and proceed to implementation directly.');
  }
  return lines.join('\n');
}

module.exports = {
  detectTestFramework,
  execTestCommand,
  parseTestSummary,
  formatSummary,
  runTicketTests,
  buildTestContextForPrompt,
};
