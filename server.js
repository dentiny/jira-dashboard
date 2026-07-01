const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const config = require('./config');
const coder = require('./coder');
const prompts = require('./prompts');
const db = require('./db');

const PORT = config.port;
const DATA_DIR = config.dataDir;

// ── Run prefixes ──────────────────────────────────────────
const PREPUSH_RUN_PREFIX = 'prepush-';
const TEST_RUN_PREFIX = 'test-';

// ── Ticket-context file plumbing ───────────────────────────
// Heavy per-ticket state (Q&A, plan, review feedback, last test failure
// tail, vision doc, etc.) is written to a markdown file in the project
// repo's .opencode/ tree before each coder call. The CLI argv then
// only carries a short directive pointing at the file. Two benefits:
//
//   1. CLI argv stays small and stable → fewer tokens re-tokenized on
//      every internal coder tool call.
//   2. Coder reads the file once and it stays in the model's KV cache
//      for the rest of the session — follow-up tool calls don't refetch.
//
// Context lives under <project>/.opencode/tickets/<ticketId>/ (NOT inside
// the worktree) because the worktree doesn't exist during clarification
// and we want the context to survive worktree cleanup on success.
function writeTicketContext(ticketId, sections) {
  const dir = config.ticketContextDir(ticketId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'context.md');
  const header = `# Ticket context: ${ticketId}\n\n_Generated ${new Date().toISOString()} by jira-dashboard._\n\n`;
  const body = sections
    .filter(s => s && s.body && String(s.body).trim().length > 0)
    .map(s => `## ${s.title}\n\n${s.body}\n`)
    .join('\n');
  fs.writeFileSync(file, header + body);
  return file;
}

// ── SSE broadcast registry ────────────────────────────────
const sseClients = new Map(); // ticketId → Set<res>

function sseBroadcast(ticketId, event, data) {
  const clients = sseClients.get(ticketId);
  if (!clients) return;
  const payload = `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

// ── Stage labels ──────────────────────────────────────────
const STAGE_LABELS = {
  clarification: 'Clarification',
  implementation: 'Implementation',
  review: 'Review',
  ready: 'Ready',
  done: 'Done'
};

// ── Helpers ───────────────────────────────────────────────
function uid() {
  return crypto.randomBytes(6).toString('hex');
}

function slugFromTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/-$/, '');
}

function ticketId(title) {
  const slug = slugFromTitle(title);
  const suffix = crypto.randomBytes(3).toString('hex');
  return slug ? `${slug}-${suffix}` : suffix;
}

// ── Plan text formatter ────────────────────────────────────
// The `plan` field from the AI evaluate response may be a JSON
// object/string rather than plain text. Normalize it to readable text.
function formatPlanText(plan) {
  if (!plan) return '';
  if (typeof plan === 'object') {
    return plan.plan || plan.description || plan.summary || JSON.stringify(plan, null, 2);
  }
  if (typeof plan === 'string') {
    try {
      const parsed = JSON.parse(plan);
      if (typeof parsed === 'string') return parsed;
      return parsed.plan || parsed.description || parsed.summary || JSON.stringify(parsed, null, 2);
    } catch {
      return plan;
    }
  }
  return String(plan);
}

// ── Coder runner (thin wrapper) ───────────────────────────
async function runCoder(ticketId, prompt, opts = {}) {
  const ticket = db.getTicket(ticketId);
  return coder.run(prompt, {
    sessionId: ticket?.ocode_session,
    title: `ticket-${ticketId}`,
    timeout: opts.timeout || config.coder.timeouts.clarify,
    onProgress: opts.onProgress,
    cwd: opts.cwd,
  });
}

// ── Rebase conflict clarification ──────────────────────────
// When the LLM can't auto-resolve a rebase conflict, generate
// clarifying questions so the user can guide the resolution.
async function generateConflictClarification(ticket, conflictFiles, gitStatus, resolveOutput) {
  const conflictDetails = [
    `Default branch: ${config.branchDefault}`,
    `Conflicted files:\n${conflictFiles.join('\n') || '(unknown)'}`,
    '',
    'Git status:',
    '```',
    gitStatus || '(unavailable)',
    '```',
  ];
  if (resolveOutput) {
    conflictDetails.push('', 'Coder output from auto-resolve attempt:', '```', resolveOutput.slice(-2000), '```');
  }

  const ctxSections = [
    { title: 'Ticket title', body: ticket.title },
    { title: 'Ticket description', body: ticket.content },
    { title: 'Rebase conflict details', body: conflictDetails.join('\n') },
  ];

  const contextFile = writeTicketContext(ticket.id, ctxSections);
  const prompt = `${prompts.resolveConflict}\n\nRead full ticket context at: ${contextFile}`;

  try {
    db.clearStageActivity(ticket.id, 'clarification');
    db.logActivity(ticket.id, 'conflict_clarify_start');
    db.updateTicketField(ticket.id, 'status', 'running');
    const onProgress = (line) => {
      if (line.startsWith('[resource] ')) {
        const detail = line.slice(11);
        db.logActivity(ticket.id, 'resource', detail, 'clarification');
        sseBroadcast(ticket.id, 'resource', { detail });
      } else {
        sseBroadcast(ticket.id, 'stdout', { text: `[conflict] ${line}` });
      }
    };
    const output = await runCoder(ticket.id, prompt, { timeout: config.coder.timeouts.clarify, onProgress });
    captureSessionId(ticket.id);
    db.updateTicketField(ticket.id, 'status', 'idle');

    let parsed;
    try {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { questions: [] };
    } catch {
      parsed = { questions: [] };
    }

    const questions = parsed.questions || [];
    db.deleteQuestionsForTicket(ticket.id);
    for (const q of questions) {
      if (typeof q === 'string') {
        db.addQuestion(ticket.id, q, null, 1, 'free_text', null);
      } else {
        const opts = q.options && Array.isArray(q.options) ? JSON.stringify(q.options) : null;
        db.addQuestion(ticket.id, q.question, null, 1, q.type || 'free_text', opts);
      }
    }
    if (questions.length === 0) {
      db.addQuestion(ticket.id,
        `How should the rebase conflict be resolved? Conflicted files: ${conflictFiles.join(', ') || '(unknown)'}`,
        null, 1, 'free_text', null);
    }
    return questions;
  } catch (err) {
    db.logActivity(ticket.id, 'conflict_clarify_error', err.message);
    db.updateTicketField(ticket.id, 'status', 'idle');
    db.deleteQuestionsForTicket(ticket.id);
    db.addQuestion(ticket.id,
      `How should the rebase conflict be resolved? Conflicted files: ${conflictFiles.join(', ') || '(unknown)'}`,
      null, 1, 'free_text', null);
    return [];
  }
}

// Capture session ID after first run
function captureSessionId(ticketId) {
  const coderMod = require('./coder');
  const sid = coderMod.getLastSessionId();
  if (sid) {
    db.updateTicketField(ticketId, 'ocode_session', sid);
    return sid;
  }
  return null;
}

// ── Git helpers ───────────────────────────────────────────
function runGit(args, cwd) {
  return require('child_process').execSync(`git ${args}`, {
    cwd: cwd || config.projectDir,
    encoding: 'utf-8',
    timeout: config.coder.timeouts.command,
  }).trim();
}

function escShell(str) {
  return str.replace(/[\\'"$`]/g, '\\$&');
}

// Pop the worktree's stash (if any) and re-stage all changes.
// `git stash pop` (without --index) restores changes as unstaged, which
// leaves the worktree in a "dirty but unstaged" state that's easy to miss
// and impossible to commit without a follow-up `git add`. Always staging
// after pop keeps the worktree in a committable state across the rebase.
function popStashAndStage(worktreePath) {
  try { runGit(`stash pop`, worktreePath); } catch {}
  runGit(`add -A`, worktreePath);
}

// True if `git status --porcelain` output indicates a dirty worktree.
// Empty output (or whitespace-only) means clean. Untracked files, staged
// changes, and unstaged changes all count as dirty.
function isWorktreeDirty(statusOutput) {
  return !!(statusOutput && statusOutput.trim());
}

// Post-stage invariant: log a `worktree_uncommitted` activity entry if the
// worktree has any uncommitted state. Called after every "stable" stage
// transition (implement, rebase, cherry-pick) so the issue is visible in
// the activity log instead of silently sitting in the working tree.
function assertWorktreeClean(ticket, { stage, allow = false } = {}) {
  if (!ticket || !ticket.worktree_path) return;
  if (!fs.existsSync(path.join(ticket.worktree_path, '.git'))) return;
  let status = '';
  try {
    status = runGit(`status --porcelain`, ticket.worktree_path);
  } catch {
    return; // git failed; not safe to assert
  }
  if (!allow && isWorktreeDirty(status)) {
    db.logActivity(ticket.id, 'worktree_uncommitted',
      `After ${stage}: ${status.slice(0, 200).replace(/\n/g, ' | ')}`);
  }
}

function ensureWorktreesDir() {
  if (!fs.existsSync(config.worktreesDir)) {
    fs.mkdirSync(config.worktreesDir, { recursive: true });
  }
}

function commitWorktreeChanges(worktreePath, ticketId, message, { partial = false } = {}) {
  const tag = partial ? 'commit_partial' : 'commit';
  try {
    const status = runGit(`status --porcelain`, worktreePath);
    if (!status) {
      // No changes to commit. Don't lie about a phantom commit.
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

// ── Unit test runner ──────────────────────────────────────
function detectTestFramework(worktreePath) {
  if (!worktreePath || !fs.existsSync(worktreePath)) return null;

  const has = (p) => fs.existsSync(path.join(worktreePath, p));
  const read = (p) => { try { return fs.readFileSync(path.join(worktreePath, p), 'utf-8'); } catch { return ''; } };

  // Override from config/env
  if (config.test.commandOverride) {
    return { framework: 'custom', command: config.test.commandOverride };
  }

  // npm
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(read('package.json'));
      if (pkg.scripts && pkg.scripts.test && pkg.scripts.test.trim() !== 'echo "Error: no test specified" && exit 1') {
        return { framework: 'npm', command: 'npm test --silent' };
      }
    } catch {}
  }

  // go
  if (has('go.mod')) {
    return { framework: 'go', command: 'go test ./...' };
  }

  // cargo
  if (has('Cargo.toml')) {
    return { framework: 'cargo', command: 'cargo test --quiet' };
  }

  // project-specific test runner (uses project name from pyproject.toml)
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

  // generic pytest
  if (has('pyproject.toml') || has('pytest.ini') || has('setup.py') || has('tests/') || has('test/')) {
    const py = config.venvPython();
    return { framework: 'pytest', command: `${py} -m pytest -x --tb=short -q` };
  }

  // fallback: scripts/
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
  const ticket = db.getTicket(ticketId);
  if (!ticket) return null;
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

// ── Express app ───────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public-spa')));

// SPA fallback
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public-spa', 'index.html'));
});

// ── Client config ─────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    projectName: config.projectName,
    remoteHost: config.remoteHost,
    explorer: config.explorer,
    testEnabled: config.test.enabled,
  });
});

// ── List all tickets ──────────────────────────────────────
app.get('/api/tickets', (req, res) => {
  const tickets = db.getAllTickets();
  res.json({ tickets, stages: ['clarification', 'implementation', 'review', 'ready', 'done'], stageLabels: STAGE_LABELS });
});

// ── Get single ticket (with resources) ────────────────────
function getTicketResponse(id) {
  const t = db.getTicket(id);
  if (!t) return null;
  const stageResources = db.getStageResources(id);
  const latestTest = db.getLatestTestRun(id);
  return { ...t, stage_resources: stageResources, latest_test: latestTest };
}

app.get('/api/tickets/:id', (req, res) => {
  const data = getTicketResponse(req.params.id);
  if (!data) return res.status(404).json({ error: 'Ticket not found' });
  res.json(data);
});

// ── SSE stream ────────────────────────────────────────────
app.get('/api/tickets/:id/stream', (req, res) => {
  const ticketId = req.params.id;
  const t = db.getTicket(ticketId);
  if (!t) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  if (!sseClients.has(ticketId)) sseClients.set(ticketId, new Set());
  sseClients.get(ticketId).add(res);

  let lastUpd = t.updated_at || '';
  let lastTestRunId = (db.getLatestTestRun(ticketId) || {}).id || 0;
  const poll = setInterval(() => {
    try {
      const t2 = db.getTicket(ticketId);
      if (!t2) { clearInterval(poll); res.end(); return; }
      const latestTest = db.getLatestTestRun(ticketId);
      const testRunId = latestTest ? latestTest.id : 0;
      const ticketChanged = t2.updated_at !== lastUpd || t2.status === 'running';
      const testChanged = testRunId !== lastTestRunId;
      if (ticketChanged || testChanged) {
        lastUpd = t2.updated_at;
        lastTestRunId = testRunId;
        const sr = db.getStageResources(ticketId);
        res.write(`event: ticket\ndata: ${JSON.stringify({ ...t2, stage_resources: sr, latest_test: latestTest })}\n\n`);
      }
    } catch {}
  }, 2000);

  req.on('close', () => {
    clearInterval(poll);
    const clients = sseClients.get(ticketId);
    if (clients) { clients.delete(res); if (clients.size === 0) sseClients.delete(ticketId); }
  });
});

// ── Create ticket ─────────────────────────────────────────
app.post('/api/tickets', (req, res) => {
  const { title, content } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title required' });
  const id = ticketId(title);
  const now = new Date().toISOString();
  const ticket = db.createTicket({ id, title: title.trim(), content: (content || '').trim(), created_at: now, updated_at: now });
  res.status(201).json(ticket);
});

// ── Stage 1: Clarification ────────────────────────────────
app.post('/api/tickets/:id/clarify', async (req, res) => {
  const ticket = db.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.stage !== 'clarification') return res.status(400).json({ error: `Ticket is in ${ticket.stage} stage` });
  if (ticket.status === 'running') return res.status(409).json({ error: 'Already processing, wait for completion' });

  const contextFile = writeTicketContext(ticket.id, [
    { title: 'Ticket title', body: ticket.title },
    { title: 'Ticket description', body: ticket.content },
    ticket.review_feedback && { title: 'Review feedback from previous implementation', body: ticket.review_feedback },
  ].filter(Boolean));

  const prompt = `${prompts.clarify}\n\nRead full ticket context at: ${contextFile}`;

  try {
    db.clearStageActivity(ticket.id, 'clarification');
    db.logActivity(ticket.id, 'clarify_start');
    db.updateTicketField(ticket.id, 'status', 'running');
    const onProgress = (line) => {
      if (line.startsWith('[resource] ')) {
        const detail = line.slice(11);
        db.logActivity(ticket.id, 'resource', detail, 'clarification');
        sseBroadcast(ticket.id, 'resource', { detail });
      } else {
        sseBroadcast(ticket.id, 'stdout', { text: line });
      }
    };
    const output = await runCoder(ticket.id, prompt, { timeout: config.coder.timeouts.clarify, onProgress });
    captureSessionId(ticket.id);
    db.updateTicketField(ticket.id, 'status', 'idle');

    let parsed;
    try {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { questions: [output] };
    } catch {
      parsed = { questions: [output], notes: 'Could not parse structured output' };
    }

    const questions = parsed.questions || [];
    const notes = parsed.notes || '';

    // If the LLM determined the ticket is straightforward, skip questions
    // and proceed directly to implementation with the provided plan.
    if (parsed.ready && (!questions || questions.length === 0)) {
      const planText = formatPlanText(parsed.plan);
      db.deleteQuestionsForTicket(ticket.id);
      db.updateTicket(ticket.id, {
        plan: planText,
        estimated_complexity: parsed.estimated_complexity || null,
        plan_notes: notes || null,
        review_feedback: null,
        stage: 'implementation',
      });
      db.logActivity(ticket.id, 'clarified_skip', planText.slice(0, 200));
      if (parsed.files_to_modify) {
        db.logActivity(ticket.id, 'files_affected', parsed.files_to_modify.join(', '));
      }
      return res.json({ clarified: true, plan: planText, notes, ticket: db.getTicket(ticket.id) });
    }

    db.deleteQuestionsForTicket(ticket.id);
    for (const q of questions) {
      if (typeof q === 'string') {
        db.addQuestion(ticket.id, q, null, 1, 'free_text', null);
      } else {
        const opts = q.options && Array.isArray(q.options) ? JSON.stringify(q.options) : null;
        db.addQuestion(ticket.id, q.question, null, 1, q.type || 'free_text', opts);
      }
    }
    if (notes) db.logActivity(ticket.id, 'clarify_notes', notes);

    res.json(db.getTicket(ticket.id));
  } catch (err) {
    db.logActivity(ticket.id, 'clarify_error', err.message);
    db.updateTicketField(ticket.id, 'status', 'idle');
    res.status(500).json({ error: err.message });
  }
});

// ── Submit answers ────────────────────────────────────────
app.post('/api/tickets/:id/answer', async (req, res) => {
  const ticket = db.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.stage !== 'clarification') return res.status(400).json({ error: `Ticket is in ${ticket.stage} stage` });
  if (ticket.status === 'running') return res.status(409).json({ error: 'Already processing, wait for completion' });

  const { answers } = req.body;
  if (!answers || Object.keys(answers).length === 0) return res.status(400).json({ error: 'No answers provided' });

  for (const [qId, answer] of Object.entries(answers)) {
    const q = ticket.questions.find(q => q.id === parseInt(qId));
    if (q) db.updateQuestionAnswer(q.id, ticket.id, answer);
  }

  db.logActivity(ticket.id, 'answers_submitted', JSON.stringify(answers).slice(0, 200));

  const updatedTicket = db.getTicket(ticket.id);
  const qaText = updatedTicket.questions.map((q, i) =>
    `Q${i + 1}: ${q.question}\nA${i + 1}: ${q.answer || '(no answer yet)'}`
  ).join('\n\n');

  const contextFile = writeTicketContext(updatedTicket.id, [
    { title: 'Ticket title', body: updatedTicket.title },
    { title: 'Ticket description', body: updatedTicket.content },
    { title: 'Clarification Q&A', body: qaText },
    updatedTicket.review_feedback && { title: 'Previous review feedback', body: updatedTicket.review_feedback },
  ].filter(Boolean));

  const prompt = `${prompts.evaluate}\n\nRead full ticket context at: ${contextFile}`;

  try {
    db.clearStageActivity(ticket.id, 'clarification');
    db.logActivity(ticket.id, 'answer_process');
    db.updateTicketField(ticket.id, 'status', 'running');
    const onProgress = (line) => {
      if (line.startsWith('[resource] ')) {
        const detail = line.slice(11);
        db.logActivity(ticket.id, 'resource', detail, 'clarification');
        sseBroadcast(ticket.id, 'resource', { detail });
      } else {
        sseBroadcast(ticket.id, 'stdout', { text: line });
      }
    };
    const output = await runCoder(ticket.id, prompt, { timeout: config.coder.timeouts.clarify, onProgress, cwd: config.projectDir });
    db.updateTicketField(ticket.id, 'status', 'idle');

    let parsed;
    try {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { need_more: false, plan: output };
    } catch {
      parsed = { need_more: false, plan: output };
    }

    if (parsed.need_more) {
      const maxRound = Math.max(...updatedTicket.questions.map(q => q.round || 1), 1);
      for (const q of (parsed.questions || [])) {
        if (typeof q === 'string') {
          db.addQuestion(ticket.id, q, null, maxRound + 1, 'free_text', null);
        } else {
          const opts = q.options && Array.isArray(q.options) ? JSON.stringify(q.options) : null;
          db.addQuestion(ticket.id, q.question, null, maxRound + 1, q.type || 'free_text', opts);
        }
      }
      if (parsed.notes) db.logActivity(ticket.id, 'followup_notes', parsed.notes);
      return res.json({ clarified: false, ...db.getTicket(ticket.id) });
    }

    const planText = formatPlanText(parsed.plan);
    db.updateTicket(ticket.id, {
      plan: planText,
      estimated_complexity: parsed.estimated_complexity || null,
      plan_notes: parsed.notes || null,
      review_feedback: null,
      stage: 'implementation',
    });
    db.logActivity(ticket.id, 'clarified_plan', parsed.notes || '');
    if (parsed.files_to_modify) {
      db.logActivity(ticket.id, 'files_affected', parsed.files_to_modify.join(', '));
    }

    const finalTicket = db.getTicket(ticket.id);
    res.json({ clarified: true, plan: planText, notes: parsed.notes, ticket: finalTicket });
  } catch (err) {
    db.logActivity(ticket.id, 'answer_error', err.message);
    db.updateTicketField(ticket.id, 'status', 'idle');
    res.status(500).json({ error: err.message });
  }
});

// ── Stage 2: Implementation ───────────────────────────────
app.post('/api/tickets/:id/implement', async (req, res) => {
  let ticket = db.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.stage !== 'implementation' && ticket.stage !== 'review') {
    return res.status(400).json({ error: `Ticket is in ${ticket.stage} stage` });
  }
  if (ticket.status === 'running') return res.status(409).json({ error: 'Already processing, wait for completion' });

  const wasReview = ticket.stage === 'review';
  if (wasReview) {
    db.updateTicket(ticket.id, { stage: 'implementation' });
    db.logActivity(ticket.id, 'continued', 'Resuming implementation from review');
    ticket = db.getTicket(ticket.id);
  }

  ensureWorktreesDir();
  const safeId = ticket.id.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const branchName = `feature/${safeId}`;
  const worktreePath = path.join(config.worktreesDir, safeId);

  try {
    const dirHere = fs.existsSync(worktreePath);
    const { execSync } = require('child_process');
    const tracked = (() => {
      try { return execSync(`git worktree list`, { cwd: config.projectDir, encoding: 'utf-8' }).includes(worktreePath); }
      catch { return false; }
    })();
    console.log(`[implement] ${ticket.id} dirHere=${dirHere} tracked=${tracked} path=${worktreePath}`);

    if (dirHere && tracked) {
      // Worktree already set up
    } else if (dirHere && !tracked) {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      try { runGit(`branch -D ${branchName}`); } catch {}
      runGit(`checkout -b ${branchName}`);
      runGit(`checkout ${config.branchDefault}`);
      runGit(`worktree add ${worktreePath} ${branchName}`);
    } else {
      try { runGit(`branch -D ${branchName}`); } catch {}
      runGit(`checkout -b ${branchName}`);
      runGit(`checkout ${config.branchDefault}`);
      runGit(`worktree add ${worktreePath} ${branchName}`);
    }

    db.updateTicket(ticket.id, { worktree_path: worktreePath, branch_name: branchName });
    db.logActivity(ticket.id, 'worktree_created', worktreePath);

    const qaText = ticket.questions.map((q, i) =>
      `Q: ${q.question}\nA: ${q.answer || 'N/A'}`
    ).join('\n');

    const testContext = wasReview ? buildTestContextForPrompt(ticket.id) : '';

    const contextFile = writeTicketContext(ticket.id, [
      { title: 'Worktree', body: `Work in this directory:\n\n\`\`\`\n${worktreePath}\n\`\`\`` },
      { title: 'Ticket title', body: ticket.title },
      { title: 'Ticket description', body: ticket.content },
      { title: 'Clarification Q&A', body: qaText },
      { title: 'Implementation plan', body: ticket.plan || '(no plan yet)' },
      ticket.review_feedback && { title: 'Review feedback from previous implementation', body: ticket.review_feedback },
      testContext && { title: 'Most recent test run', body: testContext },
    ].filter(Boolean));

    const prompt = `${prompts.implement}\n\nRead full ticket context at: ${contextFile}\nWork in: ${worktreePath}`;

    db.clearStageActivity(ticket.id, 'implementation');
    db.logActivity(ticket.id, 'implement_start');
    db.updateTicketField(ticket.id, 'status', 'running');

    const tokensBefore = coder.getStats();

    // File-change monitor
    const seenFiles = new Set();
    const fileMonitor = setInterval(() => {
      try {
        const changed = execSync(`git diff --name-only`, { cwd: worktreePath, encoding: 'utf-8', timeout: 5000 }).trim();
        if (changed) {
          changed.split('\n').forEach(f => {
            if (!seenFiles.has(f)) {
              seenFiles.add(f);
              db.logActivity(ticket.id, 'file_changed', f);
              db.updateTicketField(ticket.id, 'updated_at', new Date().toISOString());
            }
          });
        }
      } catch { /* best-effort */ }
    }, 2000);

    let _todo = { items: [], fresh: true };
    const onProgress = (line) => {
      if (line.startsWith('[resource] ')) {
        const detail = line.slice(11);
        db.logActivity(ticket.id, 'resource', detail, 'implementation');
        sseBroadcast(ticket.id, 'resource', { detail });
      } else {
        const m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)/);
        if (m) {
          if (_todo.fresh) { _todo = { items: [], fresh: false }; }
          _todo.items.push({ done: m[1] !== ' ', text: m[2].trim() });
          sseBroadcast(ticket.id, 'todo', { items: _todo.items.map(i => ({ done: i.done, text: i.text })) });
        } else if (line.trim()) {
          _todo.fresh = true;
          sseBroadcast(ticket.id, 'stdout', { text: line });
        }
      }
    };

    const output = await runCoder(ticket.id, prompt, {
      timeout: config.coder.timeouts.implement,
      onProgress,
    });

    const tokensAfter = coder.getStats();
    const tokenDelta = {
      cost: (tokensAfter.cost - tokensBefore.cost).toFixed(3),
      input: tokensAfter.input,
      output: tokensAfter.output,
    };
    db.updateTicket(ticket.id, {
      token_cost: parseFloat(tokenDelta.cost),
      token_input: tokenDelta.input,
      token_output: tokenDelta.output,
    });
    db.logActivity(ticket.id, 'token_usage', JSON.stringify(tokenDelta));

    clearInterval(fileMonitor);

    // Check if the coder actually committed; if not, re-run with a commit-only prompt
    let hasUncommitted = false;
    try {
      runGit(`diff --quiet`, worktreePath);
    } catch { hasUncommitted = true; }
    try {
      runGit(`diff --cached --quiet`, worktreePath);
    } catch { hasUncommitted = true; }
    if (hasUncommitted) {
      db.logActivity(ticket.id, 'commit_retry', 'Coder did not commit — asking again');
      const commitPrompt = `You implemented changes for this ticket but did not commit them. Review the working directory and commit ALL changes with clear, descriptive messages. Use 'git add' and 'git commit' to create well-structured commits. Do NOT make any new changes — only commit what exists.`;
      await runCoder(ticket.id, commitPrompt, {
        timeout: config.coder.timeouts.command,
        onProgress,
      });
    }

    const commitSha = commitWorktreeChanges(worktreePath, ticket.id, `${ticket.id}: implement`);

    let diffSummary = '';
    try {
      diffSummary = runGit(`log ${config.branchDefault}..HEAD --stat`, worktreePath);
    } catch {}
    if (!diffSummary) {
      try { diffSummary = runGit(`diff --stat HEAD`, worktreePath); } catch { diffSummary = '(no diff)'; }
    }

    const t2 = db.getTicket(ticket.id);
    if (!t2) return res.status(500).json({ error: 'Ticket data lost' });
    const lastRes = (t2.activity || []).find(a => a.action === 'resource');
    if (lastRes) {
      const p = Object.fromEntries(lastRes.detail.split(' ').map(s => s.split('=')));
      db.updateTicket(ticket.id, {
        total_cpu: p.cpu || '0', total_elapsed: p.elapsed || '0',
        commit_sha: commitSha || null, stage: 'review', status: 'idle',
      });
    } else {
      db.updateTicket(ticket.id, { commit_sha: commitSha || null, stage: 'review', status: 'idle' });
    }
    db.logActivity(ticket.id, 'implement_done', diffSummary.slice(0, 500));
    assertWorktreeClean(ticket, { stage: 'implement' });

    const testRunId = runTicketTests(ticket.id, 'auto');

    res.json({
      success: true, worktree_path: worktreePath, branch_name: branchName,
      diff_summary: diffSummary, output_summary: output.slice(-1000),
      test_run_id: testRunId, ticket: db.getTicket(ticket.id),
    });
  } catch (err) {
    const t2 = db.getTicket(ticket.id);
    if (t2) {
      const lastRes = (t2.activity || []).find(a => a.action === 'resource');
      if (lastRes) {
        const p = Object.fromEntries(lastRes.detail.split(' ').map(s => s.split('=')));
        db.updateTicket(ticket.id, { total_cpu: p.cpu || '0', total_elapsed: p.elapsed || '0' });
      }
      const partialSha = commitWorktreeChanges(worktreePath, ticket.id,
        `${ticket.id}: partial (error: ${err.message.slice(0, 80).replace(/"/g, '')})`, { partial: true });
      db.logActivity(ticket.id, 'implement_error', err.message);
      db.updateTicket(ticket.id, { commit_sha: partialSha || null, stage: 'review', status: 'idle' });
      const testRunId = runTicketTests(ticket.id, 'auto');
      res.json({ error: err.message, test_run_id: testRunId, note: 'Changes auto-committed. Choose: continue (restart implementation) or review and cherry-pick.' });
    } else {
      db.logActivity(ticket.id, 'implement_error', err.message);
      res.status(500).json({ error: err.message });
    }
  }
});

// ── Stage 3: Review feedback ──────────────────────────────
app.post('/api/tickets/:id/feedback', async (req, res) => {
  const ticket = db.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.stage !== 'review') return res.status(400).json({ error: `Ticket is in ${ticket.stage} stage` });

  const { feedback } = req.body;
  if (!feedback || !feedback.trim()) return res.status(400).json({ error: 'Feedback required' });

  db.updateTicket(ticket.id, { stage: 'clarification', review_feedback: feedback.trim(), plan: null });
  db.logActivity(ticket.id, 'review_feedback', feedback.trim().slice(0, 300));

  res.json({ success: true, message: 'Ticket moved back to clarification', ticket: db.getTicket(ticket.id) });
});

// ── Rebase (standalone button in review stage) ────────────
app.post('/api/tickets/:id/rebase', async (req, res) => {
  const ticket = db.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.stage !== 'review') return res.status(400).json({ error: `Ticket is in ${ticket.stage} stage` });
  if (ticket.status === 'running') return res.status(409).json({ error: 'Already processing, wait for completion' });
  if (!ticket.worktree_path || !fs.existsSync(path.join(ticket.worktree_path, '.git'))) {
    return res.status(400).json({ error: 'No worktree available for rebase' });
  }

  db.logActivity(ticket.id, 'rebase_start', `Rebasing onto ${config.branchDefault}`);
  db.updateTicketField(ticket.id, 'status', 'running');
  sseBroadcast(ticket.id, 'stdout', { text: `Rebasing onto ${config.branchDefault}…` });

  try {
    // Abort any stale in-progress rebase
    try { runGit(`rebase --abort`, ticket.worktree_path); } catch {}

    // Stash uncommitted changes before rebase
    let hadStash = false;
    try {
      const status = runGit(`status --porcelain`, ticket.worktree_path);
      if (status) {
        runGit(`stash --include-untracked`, ticket.worktree_path);
        hadStash = true;
      }
    } catch {}

    // Attempt the rebase
    try {
      runGit(`rebase ${config.branchDefault}`, ticket.worktree_path);
      if (hadStash) popStashAndStage(ticket.worktree_path);

      const newSha = runGit(`rev-parse HEAD`, ticket.worktree_path);
      db.logActivity(ticket.id, 'rebase_done', `Rebased onto ${config.branchDefault}: ${newSha.slice(0, 7)}`);
      db.updateTicketField(ticket.id, 'status', 'idle');
      db.updateTicketField(ticket.id, 'commit_sha', newSha);
      assertWorktreeClean(ticket, { stage: 'rebase' });
      sseBroadcast(ticket.id, 'stdout', { text: `Rebase complete: ${newSha.slice(0, 7)}` });
      return res.json({ success: true, commit_sha: newSha, ticket: db.getTicket(ticket.id) });
    } catch (rebaseErr) {
      // Rebase hit conflicts — collect details
      let conflictFiles = [];
      let gitStatus = '';
      try {
        gitStatus = runGit(`status`, ticket.worktree_path);
        conflictFiles = runGit(`diff --name-only --diff-filter=U`, ticket.worktree_path)
          .split('\n').map(s => s.trim()).filter(Boolean);
      } catch {}

      db.logActivity(ticket.id, 'rebase_conflict', `Conflicts in ${conflictFiles.length} files`);
      db.updateTicketField(ticket.id, 'status', 'idle');

      // Build prompt for the coder to resolve conflicts
      const worktreePath = ticket.worktree_path;
      const resolvePrompt = `You are resolving git rebase conflicts for a ticket in the ${config.projectName} project.

The worktree at ${worktreePath} has conflicts after \`git rebase ${config.branchDefault}\`.

Git status:
${gitStatus}

Conflicted files:
${conflictFiles.join('\n')}

Your job:
1. Read the conflicted files
2. Resolve the merge conflicts by editing the files
3. Run \`git add\` on the resolved files to mark them as resolved
4. Run \`git rebase --continue\` to complete the rebase
5. Commit any remaining changes

If you CANNOT resolve the conflicts, output the word UNRESOLVABLE on its own line and explain what is blocking you.`;

      try {
        const resolveOutput = await runCoder(ticket.id, resolvePrompt, {
          timeout: config.coder.timeouts.implement,
          onProgress: (line) => {
            db.logActivity(ticket.id, 'rebase_coder_progress', line.slice(0, 200));
            sseBroadcast(ticket.id, 'stdout', { text: `[resolve] ${line}` });
          },
          cwd: ticket.worktree_path,
        });

        // Check if conflicts remain
        let remainingConflicts = [];
        try {
          remainingConflicts = runGit(`diff --name-only --diff-filter=U`, ticket.worktree_path)
            .split('\n').map(s => s.trim()).filter(Boolean);
        } catch {}

        if (remainingConflicts.length === 0 && !resolveOutput.includes('UNRESOLVABLE')) {
          // Coder resolved — try to continue rebase
          db.updateTicketField(ticket.id, 'status', 'running');
          try {
            runGit(`rebase --continue`, ticket.worktree_path);
            if (hadStash) popStashAndStage(ticket.worktree_path);
            const newSha = runGit(`rev-parse HEAD`, ticket.worktree_path);
            db.logActivity(ticket.id, 'rebase_done', `Coder resolved conflicts. Rebased onto ${config.branchDefault}: ${newSha.slice(0, 7)}`);
            db.updateTicketField(ticket.id, 'status', 'idle');
            db.updateTicketField(ticket.id, 'commit_sha', newSha);
            assertWorktreeClean(ticket, { stage: 'rebase-resolved' });
            sseBroadcast(ticket.id, 'stdout', { text: `Rebase complete after conflict resolution: ${newSha.slice(0, 7)}` });
            return res.json({ success: true, commit_sha: newSha, note: 'Coder resolved conflicts', ticket: db.getTicket(ticket.id) });
          } catch (continueErr) {
            db.logActivity(ticket.id, 'rebase_continue_failed', continueErr.message.slice(0, 200));
            db.updateTicketField(ticket.id, 'status', 'idle');
          }
        }

        // Coder couldn't resolve — abort rebase, generate conflict clarification questions
        try { runGit(`rebase --abort`, ticket.worktree_path); } catch {}
        if (hadStash) popStashAndStage(ticket.worktree_path);

        db.logActivity(ticket.id, 'rebase_coder_unresolved', `Coder could not resolve conflicts in ${conflictFiles.length} files`);
        await generateConflictClarification(ticket, conflictFiles, gitStatus, resolveOutput);

        const feedbackText = `The rebase onto ${config.branchDefault} failed with conflicts in:\n${
          conflictFiles.join('\n') || '(unknown files)'
        }\n\nThe rebase conflict resolver could not resolve these automatically. Please answer the clarification questions to guide resolution.`;
        db.updateTicket(ticket.id, { stage: 'clarification', review_feedback: feedbackText, plan: null });
        sseBroadcast(ticket.id, 'stdout', { text: 'Rebase conflicts could not be resolved — ticket moved to clarification with conflict questions' });

        return res.json({
          success: false,
          error: 'Rebase conflicts could not be resolved automatically',
          ticket: db.getTicket(ticket.id),
        });
      } catch (coderErr) {
        // Coder itself crashed/errored — generate conflict clarification questions
        try { runGit(`rebase --abort`, ticket.worktree_path); } catch {}
        if (hadStash) popStashAndStage(ticket.worktree_path);

        db.logActivity(ticket.id, 'rebase_coder_error', coderErr.message.slice(0, 200));
        await generateConflictClarification(ticket, conflictFiles, gitStatus, null);

        const feedbackText = `The rebase onto ${config.branchDefault} failed with conflicts. The conflict resolver encountered an error:\n${coderErr.message}\n\nPlease answer the clarification questions to guide resolution.`;
        db.updateTicket(ticket.id, { stage: 'clarification', review_feedback: feedbackText, plan: null });

        return res.json({
          success: false,
          error: 'Conflict resolver failed: ' + coderErr.message,
          ticket: db.getTicket(ticket.id),
        });
      }
    }
  } catch (err) {
    db.logActivity(ticket.id, 'rebase_error', err.message.slice(0, 200));
    db.updateTicketField(ticket.id, 'status', 'idle');
    return res.status(500).json({ error: err.message, ticket: db.getTicket(ticket.id) });
  }
});

// ── Stage 4: Ready → cherry-pick + close ──────────────────
function cleanupWorktreeAfterSuccess(ticketId) {
  const t = db.getTicket(ticketId);
  if (!t) return;
  const wt = t.worktree_path;
  const bn = t.branch_name;
  if (wt) {
    try { runGit(`worktree remove --force ${wt}`); }
    catch (e) { db.logActivity(ticketId, 'cleanup_warn', `worktree remove failed (non-fatal): ${e.message}`); }
  }
  if (bn) {
    try { runGit(`branch -D ${bn}`); }
    catch (e) { db.logActivity(ticketId, 'cleanup_warn', `branch delete failed (non-fatal): ${e.message}`); }
  }
  if (wt && fs.existsSync(wt)) {
    try { fs.rmSync(wt, { recursive: true, force: true }); }
    catch (e) { db.logActivity(ticketId, 'cleanup_warn', `rm worktree dir failed (non-fatal): ${e.message}`); }
  }
  db.updateTicket(ticketId, { worktree_path: null, branch_name: null });
}

app.post('/api/tickets/:id/ready', async (req, res) => {
  let ticket = db.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.stage !== 'review') return res.status(400).json({ error: `Ticket is in ${ticket.stage} stage` });

  if (!ticket.worktree_path || !fs.existsSync(path.join(ticket.worktree_path, '.git'))) {
    const msg = `Worktree integrity check failed: ${ticket.worktree_path || '(unset)'}/.git is missing or invalid. Cherry-pick aborted.`;
    db.logActivity(ticket.id, 'ready_error', msg);
    return res.status(500).json({ error: msg, ticket: db.getTicket(ticket.id) });
  }
  try {
    runGit(`rev-parse --verify ${ticket.branch_name}`, ticket.worktree_path);
  } catch (err) {
    const msg = `Worktree integrity check failed: branch '${ticket.branch_name}' does not resolve (${err.message}).`;
    db.logActivity(ticket.id, 'ready_error', msg);
    return res.status(500).json({ error: msg, ticket: db.getTicket(ticket.id) });
  }

  let commitSha = null;
  try {
    let hasChanges = false;
    try { runGit(`diff --quiet`, ticket.worktree_path); } catch { hasChanges = true; }
    try { runGit(`diff --cached --quiet`, ticket.worktree_path); } catch { hasChanges = true; }
    if (!hasChanges) {
      try {
        const ahead = parseInt(runGit(`rev-list --count ${config.branchDefault}..${ticket.branch_name}`, ticket.worktree_path), 10) || 0;
        if (ahead > 0) hasChanges = true;
      } catch {}
    }

    if (!hasChanges) {
      const msg = `No uncommitted changes and no commits ahead of ${config.branchDefault} on this branch.`;
      db.logActivity(ticket.id, 'no_changes', msg);
      return res.status(409).json({ error: msg, ticket: db.getTicket(ticket.id) });
    }

    const commitMsg = `${ticket.id}: ${ticket.title}`;
    runGit(`add -A`, ticket.worktree_path);

    try {
      const mergeBase = runGit(`merge-base ${config.branchDefault} ${ticket.branch_name}`);
      runGit(`reset --soft ${mergeBase}`, ticket.worktree_path);
      db.logActivity(ticket.id, 'squashed', `All commits squashed to merge-base ${mergeBase.slice(0, 7)}`);
    } catch {
      db.logActivity(ticket.id, 'squash_skipped', 'Could not find merge-base, committing as-is');
    }

    runGit(`commit -m "${escShell(commitMsg)}"`, ticket.worktree_path);
    commitSha = runGit(`rev-parse HEAD`, ticket.worktree_path);
    db.logActivity(ticket.id, 'committed', commitSha);
    assertWorktreeClean(ticket, { stage: 'cherry-pick' });

    let prUrl = null;
    if (config.mergeStrategy === 'pr') {
      runGit(`push origin ${ticket.branch_name}`, ticket.worktree_path);
      db.logActivity(ticket.id, 'branch_pushed', `Pushed ${ticket.branch_name} to origin`);

      try {
        const prOutput = require('child_process').execSync(
          `gh pr create --title "${ticket.id}: ${ticket.title}" --body ""`,
          { cwd: ticket.worktree_path, encoding: 'utf-8', timeout: config.coder.timeouts.command }
        ).trim();
        prUrl = prOutput;
        db.logActivity(ticket.id, 'pr_created', prUrl);
      } catch {
        const remoteUrl = runGit(`config --get remote.origin.url`, ticket.worktree_path);
        const repoPath = remoteUrl.replace(/\.git$/, '').replace(/^.*[:/]/, '');
        const prLink = `https://github.com/${repoPath}/pull/new/${ticket.branch_name}`;
        prUrl = prLink;
        db.logActivity(ticket.id, 'pr_link', prLink);
      }
    } else {
      try {
        runGit(`rebase ${config.branchDefault}`, ticket.worktree_path);
        commitSha = runGit(`rev-parse HEAD`, ticket.worktree_path);
        runGit(`checkout ${config.branchDefault}`);
      } catch (err) {
        db.logActivity(ticket.id, 'rebase_failed', err.message);
        try { runGit(`rebase --abort`, ticket.worktree_path); } catch {}
        try { runGit(`checkout ${config.branchDefault}`); } catch {}
      }

      runGit(`cherry-pick ${commitSha}`);
      db.logActivity(ticket.id, 'cherry_picked', commitSha);
    }

    db.updateTicket(ticket.id, { stage: 'done', commit_sha: commitSha });
    if (config.mergeStrategy !== 'pr') cleanupWorktreeAfterSuccess(ticket.id);

    res.json({ success: true, commit_sha: commitSha, pr_url: prUrl, ticket: db.getTicket(ticket.id) });
  } catch (err) {
    const tail = commitSha
      ? ` Squashed commit ${commitSha.slice(0, 7)} is still on branch ${ticket.branch_name} in the worktree.`
      : '';
    db.logActivity(ticket.id, 'ready_error', `${err.message}${tail} Worktree preserved — ticket stays in review.`);
    res.status(500).json({ error: err.message, ticket: db.getTicket(ticket.id) });
  }
});

// ── Delete ticket ─────────────────────────────────────────
app.delete('/api/tickets/:id', (req, res) => {
  const ticket = db.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  if (ticket.worktree_path && fs.existsSync(ticket.worktree_path)) {
    try { runGit(`worktree remove --force ${ticket.worktree_path}`); } catch {}
  }
  if (ticket.branch_name) {
    try { runGit(`branch -D ${ticket.branch_name}`); } catch {}
  }

  db.deleteTicket(req.params.id);
  res.json({ success: true });
});

// ── Get diff ──────────────────────────────────────────────
app.get('/api/tickets/:id/diff', (req, res) => {
  const ticket = db.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (!ticket.worktree_path || !fs.existsSync(ticket.worktree_path)) {
    return res.json({ diff: '(no worktree available)', files: [], explorer_prefix: null });
  }
  try {
    let diff = runGit(`log ${config.branchDefault}..HEAD --oneline --stat`, ticket.worktree_path);
    let files = [];
    if (!diff) {
      // No commits ahead of default branch — changes may have been
      // incorporated via cherry-pick/merge. Show diff from merge-base.
      diff = runGit(`diff ${config.branchDefault}...HEAD --stat`, ticket.worktree_path);
      if (diff) {
        try {
          const nameOnly = runGit(`log ${config.branchDefault}...HEAD --name-only --format=""`, ticket.worktree_path);
          files = [...new Set(nameOnly.split('\n').map(s => s.trim()).filter(Boolean))];
        } catch {}
        diff = `(commits already in ${config.branchDefault} — showing diff from merge-base)\n${diff}`;
      } else {
        return res.status(400).json({ error: `No diff available — worktree has no changes ahead of ${config.branchDefault}`, files: [], explorer_prefix: null });
      }
    } else {
      try {
        const nameOnly = runGit(`log ${config.branchDefault}..HEAD --name-only --format=""`, ticket.worktree_path);
        files = [...new Set(nameOnly.split('\n').map(s => s.trim()).filter(Boolean))];
      } catch {}
    }
    const homeDir = os.homedir();
    const explorerPrefix = ticket.worktree_path.startsWith(homeDir + '/')
      ? ticket.worktree_path.slice(homeDir.length + 1)
      : ticket.worktree_path;
    res.json({ diff, files, explorer_prefix: explorerPrefix, commitSha: ticket.commit_sha });
  } catch (err) {
    res.json({ diff: `Error: ${err.message}`, files: [], explorer_prefix: null });
  }
});

// ── Unit-test results per ticket ───────────────────────────
app.get('/api/tickets/:id/tests', (req, res) => {
  const ticket = db.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const latest = db.getLatestTestRun(req.params.id);
  const history = db.getTestRuns(req.params.id, 10);
  res.json({ latest, history });
});

app.post('/api/tickets/:id/tests/run', (req, res) => {
  const ticket = db.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const runId = runTicketTests(req.params.id, 'manual');
  res.json({ run_id: runId, status: 'running' });
});

// ── Top-level test runner (project root) ──────────────────
const runResults = {};

app.post('/api/test', (req, res) => {
  const runId = `${TEST_RUN_PREFIX}${Date.now()}`;
  const outFile = path.join(DATA_DIR, runId + '.log');
  runResults[runId] = { status: 'running', file: outFile };
  res.json({ runId });

  const py = config.venvPython();
  const testModule = `${config.projectName}.test`;
  const out = fs.createWriteStream(outFile);
  const proc = spawn(py, ['-m', testModule], {
    cwd: config.projectDir,
    env: { ...process.env, PYTHONPATH: path.join(config.projectDir, config.venv.pythonpath) },
    timeout: config.test.timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.pipe(out);
  proc.stderr.pipe(out);
  proc.on('close', code => { runResults[runId].status = code === 0 ? 'pass' : 'fail'; });
  proc.on('error', err => { fs.appendFileSync(outFile, '\nError: ' + err.message); runResults[runId].status = 'fail'; });
});

app.get('/api/run/:id', (req, res) => {
  const r = runResults[req.params.id];
  if (!r) return res.status(404).json({ error: 'Run not found' });
  let output = '';
  try { output = fs.readFileSync(r.file, 'utf-8').slice(-8000); } catch {}
  res.json({ status: r.status, output });
});

// ── Dry-run pre-push hook ─────────────────────────────────
app.post('/api/prepush', (req, res) => {
  const hookPath = path.join(config.projectDir, '.githooks', 'pre-push');
  if (!fs.existsSync(hookPath)) return res.status(400).json({ error: 'Pre-push hook not found' });

  const runId = `${PREPUSH_RUN_PREFIX}${Date.now()}`;
  const outFile = path.join(DATA_DIR, runId + '.log');
  runResults[runId] = { status: 'running', file: outFile };
  res.json({ runId });

  const out = fs.createWriteStream(outFile);
  const proc = spawn('bash', [hookPath], {
    cwd: config.projectDir,
    env: { ...process.env, PYTHONPATH: path.join(config.projectDir, config.venv.pythonpath) },
    timeout: config.test.timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.pipe(out);
  proc.stderr.pipe(out);
  proc.on('close', code => { runResults[runId].status = code === 0 ? 'pass' : 'fail'; });
  proc.on('error', err => { fs.appendFileSync(outFile, '\nError: ' + err.message); runResults[runId].status = 'fail'; });
});

// ── Suggested tickets ──────────────────────────────────────
let suggestions = [];
const SUGGESTIONS_MAX = 5;
const SUGGESTIONS_TICKET_ID = '_suggestions';
const SUGGESTION_ID_PREFIX = 'sug-';

async function generateSuggestions(retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const visionPath = path.join(config.projectDir, 'docs', 'vision.md');
      const vision = fs.existsSync(visionPath) ? fs.readFileSync(visionPath, 'utf-8') : '';

      const sugDir = path.join(config.ticketContextDir(SUGGESTIONS_TICKET_ID));
      fs.mkdirSync(sugDir, { recursive: true });
      const contextFile = path.join(sugDir, 'context.md');
      fs.writeFileSync(contextFile,
        `# Suggestion generation context\n\n_Generated ${new Date().toISOString()}._\n\n` +
        `## Project root\n\n\`\`\`\n${config.projectDir}\n\`\`\`\n\n` +
        `## Project vision (${visionPath})\n\n${vision}\n`
      );

      const fullPrompt = `${prompts.suggest}\n\nSuggest ${SUGGESTIONS_MAX} tickets.\n\nRead vision + project root at: ${contextFile}`;
      const output = await runCoder(SUGGESTIONS_TICKET_ID, fullPrompt, { timeout: config.coder.timeouts.suggest, cwd: config.projectDir });
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      if (parsed && Array.isArray(parsed.tickets)) {
        suggestions = parsed.tickets.map(t => ({
          id: SUGGESTION_ID_PREFIX + crypto.randomBytes(4).toString('hex'),
          title: t.title,
          content: t.content,
        }));
        console.log(`Generated ${suggestions.length} ticket suggestions`);
        return;
      }
    } catch (e) {
      console.log(`Suggestion generation failed (attempt ${attempt}/${retries}):`, e.message);
      if (attempt < retries) {
        const delay = 5000 * Math.pow(2, attempt - 1);
        console.log(`Retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  console.log(`Suggestion generation exhausted all ${retries} retries`);
}

app.get('/api/suggestions', (req, res) => res.json(suggestions));

app.post('/api/suggestions/:id/accept', (req, res) => {
  const sug = suggestions.find(s => s.id === req.params.id);
  if (!sug) return res.status(404).json({ error: 'Not found' });
  const id = ticketId(sug.title);
  const now = new Date().toISOString();
  const ticket = db.createTicket({ id, title: sug.title.trim(), content: (sug.content || '').trim(), created_at: now, updated_at: now });
  suggestions = suggestions.filter(s => s.id !== req.params.id);
  if (suggestions.length < 2) generateSuggestions();
  res.status(201).json(ticket);
});

app.post('/api/suggestions/:id/dismiss', (req, res) => {
  suggestions = suggestions.filter(s => s.id !== req.params.id);
  if (suggestions.length < 2) generateSuggestions();
  res.json({ ok: true });
});

// ── Start ──────────────────────────────────────────────────
(function recoverStuckTickets() {
  const ids = db.getTicketIds();
  let changed = false;
  for (const tid of ids) {
    const t = db.getTicket(tid);
    if (t && t.status === 'running') {
      let alive = false;
      if (t.ocode_session) {
        try {
          const sessions = require('child_process').execSync(
            `${config.coder.bin} session list`,
            { encoding: 'utf-8', timeout: config.coder.timeouts.command, stdio: 'pipe' }
          );
          alive = sessions.includes(t.ocode_session);
        } catch {}
      }
      if (!alive) {
        db.updateTicketField(tid, 'status', 'idle');
        db.logActivity(tid, 'recovered', 'Server restarted — previous coder session gone, reset to idle');
        changed = true;
        console.log(`Recovered: ${tid} reset to idle (session not alive)`);
      }
    }
  }
  if (changed) console.log('Crash recovery complete');
})();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Jira Dashboard running on http://0.0.0.0:${PORT}`);
  console.log(`   Project: ${config.projectDir} (${config.projectName})`);
  console.log(`   Coder: ${config.coder.type} (${config.coder.bin})`);
  console.log(`   Data: SQLite at ${path.join(DATA_DIR, 'store.db')}`);
  if (suggestions.length < SUGGESTIONS_MAX) generateSuggestions();
});
