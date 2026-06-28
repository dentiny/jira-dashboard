const express = require('express');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const db = require('./db');

const PORT = process.env.PORT || 3006;
const PYXEN_DIR = '/home/cutuy/.openclaw/workspace/pyxen';
const OPENCODE_BIN = '/home/cutuy/.opencode/bin/opencode';
const WORKTREES_DIR = '/home/cutuy/.openclaw/workspace/pyxen/.worktrees';
const DATA_DIR = path.join(__dirname, 'data');

// ── Ticket-context file plumbing ───────────────────────────
//
// Heavy per-ticket state (Q&A, plan, review feedback, last test failure
// tail, vision doc, etc.) is written to a markdown file in the pyxen
// repo's .opencode/ tree before each opencode call. The CLI argv then
// only carries a short directive pointing at the file. Two benefits:
//
//   1. CLI argv stays small and stable → fewer tokens re-tokenized on
//      every internal opencode tool call.
//   2. Opencode reads the file once and it stays in the model's KV cache
//      for the rest of the session — follow-up tool calls don't refetch.
//
// Context lives under pyxen/.opencode/tickets/<ticketId>/ (NOT inside
// the worktree) because the worktree doesn't exist during clarification
// and we want the context to survive worktree cleanup on success.
function ticketContextDir(ticketId) {
  const safe = String(ticketId).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(PYXEN_DIR, '.opencode', 'tickets', safe);
}

function writeTicketContext(ticketId, sections) {
  const dir = ticketContextDir(ticketId);
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

// Common prompt prefixes — role + output schema per stage. Stage-specific
// dynamic content (Q&A, plan, test tail, etc.) goes into the ticket
// context file (see writeTicketContext); the call site appends the file
// path so opencode can read it. Keep these prefixes terse and explicit —
// they're the only thing in the CLI argv.
const PROMPT_PREFIXES = {
  clarify: `You are in the CLARIFICATION stage of a ticketing system for the pyxen project at ${PYXEN_DIR}. Ask 3-5 clarifying questions so the user can fill in missing details before implementation. After the user answers, a follow-up call will decide whether to proceed or ask more.

Output ONLY valid JSON — no markdown, no explanation, no code fences:

{
  "questions": [
    { "question": "Which database should we use?", "type": "multiple_choice", "options": ["SQLite", "Postgres", "BigQuery"] },
    { "question": "Any additional constraints?", "type": "free_text" }
  ],
  "notes": "Optional: why these questions matter"
}`,

  evaluate: `You are in the ANSWER EVALUATION stage. The user has answered the clarification questions in the context file. Decide whether to proceed to implementation or ask follow-up questions.

Output ONLY valid JSON — no markdown, no explanation, no code fences:

If you NEED more info:
{
  "need_more": true,
  "questions": [
    { "question": "Follow-up?", "type": "free_text" },
    { "question": "Which approach?", "type": "multiple_choice", "options": ["A", "B"] }
  ],
  "notes": "Why more info is needed"
}

If you have ENOUGH info:
{
  "need_more": false,
  "plan": "High-level plan (1-3 sentences)",
  "files_to_modify": ["file1.py", "file2.py"],
  "estimated_complexity": "low|medium|high",
  "notes": "Any assumptions"
}`,

  implement: `You are implementing changes for a pyxen ticket. Work in the directory referenced below.

Your job:
1. Read the context file for ticket details (title, content, plan, Q&A, any prior review feedback and test failure tail)
2. Read the relevant source files to understand the current code
3. Implement the changes described in the plan
4. Write clean, well-tested, maintainable code
5. Make sure existing tests still pass
6. Update relevant documentation
7. Commit logical groups of changes with clear messages as you go — ALWAYS commit your work

Do NOT echo or repeat the ticket context back to the user — read it from the file and proceed.`,

  suggest: `You are suggesting feature tickets for the pyxen project. Read the vision document at the path in the context file. Suggest tickets that advance the vision — new primitives, new provider backends, extension ideas, integration with existing tools, or improvements that reduce environment coupling. NO bug fixes, NO cleanup tickets, NO refactors.

Output ONLY valid JSON — no markdown, no explanation:

{
  "tickets": [
    {"title": "Feature title (<10 words)", "content": "What to build and why it advances the vision (one sentence)"}
  ]
}`,
};

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

// ── OpenCode runner ───────────────────────────────────────
function loadPyxenEnv() {
  const envFile = path.join(PYXEN_DIR, '.env');
  const vars = {};
  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        vars[key] = val;
      }
    }
  }
  return vars;
}

// ── OpenCode runner ───────────────────────────────────────
function getOpencodeTokens() {
  try {
    const out = execSync(`${OPENCODE_BIN} stats --project ''`, {
      encoding: 'utf-8', timeout: 5000, stdio: 'pipe', cwd: PYXEN_DIR
    });
    const cost = (out.match(/Total Cost\s+\$?([\d.]+)/) || [])[1];
    const input = (out.match(/Input\s+([\d,.]+[KMB]?)/) || [])[1];
    const output = (out.match(/Output\s+([\d,.]+[KMB]?)/) || [])[1];
    return { cost: parseFloat(cost) || 0, input: input || '0', output: output || '0' };
  } catch { return { cost: 0, input: '0', output: '0' }; }
}

function runOpenCode(ticketId, prompt, onProgress, stage = null, timeout = 180_000) {
  return new Promise((resolve, reject) => {
    const ticket = db.getTicket(ticketId);
    const existingSession = ticket && ticket.ocode_session;

    const venvBin = path.join(PYXEN_DIR, '.venv', 'bin');
    const pyxenEnv = loadPyxenEnv();
    const env = {
      ...process.env,
      ...pyxenEnv,
      HOME: process.env.HOME,
      PATH: `${venvBin}:${process.env.PATH}`,
      VIRTUAL_ENV: path.join(PYXEN_DIR, '.venv'),
    };
    const args = ['run'];
    if (existingSession) {
      args.push('-s', existingSession);
    } else {
      args.push('--title', `ticket-${ticketId}`);
    }
    args.push(prompt);
    const proc = spawn(OPENCODE_BIN, args, {
      cwd: PYXEN_DIR,
      env,
      timeout,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    // Resource monitor — logs cpu/mem/tokens/tokens/cost every 3s,
    // tagged with 'stage' so per-stage breakdown is always available.
    const startTime = Date.now();
    const clkTck = 100;
    const ncores = parseInt(fs.readFileSync('/proc/cpuinfo', 'utf-8').match(/processor/g)?.length) || 4;
    let baseCpu = 0, baseElapsed = 0;
    let peakMem = 0;
    try {
      const t = db.getTicket(ticketId);
      if (t) {
        baseCpu = parseFloat(t.total_cpu || '0');
        baseElapsed = parseInt(t.total_elapsed || '0');
      }
    } catch {}

    const resMonitor = setInterval(() => {
      try {
        const raw = fs.readFileSync(`/proc/${proc.pid}/stat`, 'utf-8');
        const afterParen = raw.slice(raw.lastIndexOf(')') + 2);
        const fields = afterParen.split(' ');
        const utime = parseInt(fields[11]) || 0;
        const stime = parseInt(fields[12]) || 0;
        const rss = parseInt(fields[21]) || 0;
        const threads = parseInt(fields[17]) || 1;
        const cpuSec = (baseCpu + (utime + stime) / clkTck).toFixed(1);
        const memMB = rss * 4096 / (1024 * 1024);
        const memStr = memMB.toFixed(1);
        if (memMB > peakMem) peakMem = memMB;
        const elapsed = baseElapsed + Math.round((Date.now() - startTime) / 1000);

        let tokensIn = '', tokensOut = '', runCost = '';
        try {
          const statsOut = execSync(`${OPENCODE_BIN} stats --project ''`, { encoding: 'utf-8', timeout: 3000, stdio: 'pipe', cwd: PYXEN_DIR });
          tokensIn = (statsOut.match(/Input\s+([\d,.]+[KMB]?)/) || [])[1] || '';
          tokensOut = (statsOut.match(/Output\s+([\d,.]+[KMB]?)/) || [])[1] || '';
          runCost = (statsOut.match(/Total Cost\s+\$?([\d.]+)/) || [])[1] || '';
        } catch {}
        let tokensStr = '';
        if (tokensIn) tokensStr = ` tokens_in=${tokensIn} tokens_out=${tokensOut} cost=$${runCost}`;

        const resStr = `cpu=${cpuSec}s mem=${memStr}MB threads=${threads} elapsed=${elapsed}s ncores=${ncores}${tokensStr}`;
        // Tag resource entries with stage for per-stage breakdown
        db.logActivity(ticketId, 'resource', resStr, stage);
        if (onProgress) onProgress(`[resource] ${resStr}`);
      } catch { /* proc gone */ }
    }, 3000);

    proc.stdout.on('data', d => {
      const chunk = d.toString();
      stdout += chunk;
      if (onProgress) {
        chunk.split('\n').filter(l => l.trim()).forEach(l => onProgress(l));
      }
    });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    // Snapshot token/cost before this call (for stage_summary delta)
    const tokensBefore = getOpencodeTokens();

    proc.on('close', code => {
      clearInterval(resMonitor);

      // Compute per-stage delta summary (best-effort, must not crash the server)
      try {
        const tokensAfter = getOpencodeTokens();
        let deltaCpu = '0', deltaElapsed = '0', deltaPeakMem = Number(peakMem).toFixed(0);
        let deltaCost = Math.max(0, tokensAfter.cost - tokensBefore.cost).toFixed(3);
        try {
          const t = db.getTicket(ticketId);
          if (t) {
            const resEntries = (t.activity || []).filter(a => a.action === 'resource' && a.stage === stage);
            if (resEntries.length > 0) {
              const latest = Object.fromEntries(resEntries[0].detail.split(' ').map(k => k.split('=')));
              deltaCpu = Math.max(0, (parseFloat(latest.cpu) || 0) - baseCpu).toFixed(1);
              deltaElapsed = String(Math.max(0, (parseInt(latest.elapsed) || 0) - baseElapsed));
            }
          }
        } catch {}
        const summaryStr = `cpu=${deltaCpu}s elapsed=${deltaElapsed}s peak_mem=${deltaPeakMem}MB tokens_in=${tokensAfter.input} tokens_out=${tokensAfter.output} cost=$${deltaCost}`;
        db.logActivity(ticketId, 'stage_summary', summaryStr, stage);
      } catch {} // resource summary is optional — never crash the server

      // After first run, capture session ID by title (deterministic, no log parsing)
      if (!existingSession) {
        try {
          const list = execSync(`${OPENCODE_BIN} session list`, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
          const title = `ticket-${ticketId}`;
          for (const line of list.split('\n')) {
            if (line.includes(title)) {
              const sid = line.trim().split(/\s+/)[0];
              if (sid.startsWith('ses_')) {
                db.updateTicketField(ticketId, 'ocode_session', sid);
                break;
              }
            }
          }
        } catch {}
      }

      if (!killed) {
        if (code === 0) {
          if (!stdout.trim() && stderr.trim()) {
            reject(new Error(`OpenCode produced no output: ${stderr.slice(-500)}`));
          } else {
            resolve(stdout.trim());
          }
        } else if (stdout.trim()) {
          // Non-zero exit but we have output — resolve what we got
          resolve(stdout.trim());
        } else {
          const reason = code === null ? 'killed (signal/timeout)' : `exited ${code}`;
          reject(new Error(`OpenCode ${reason}: ${stderr.slice(-500)}`));
        }
      }
    });

    proc.on('error', err => {
      clearInterval(resMonitor);
      reject(err);
    });
  });
}

// ── Git helpers ───────────────────────────────────────────
function runGit(args, cwd = PYXEN_DIR) {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8', timeout: 30_000 }).trim();
}

// Commit gate — ensures every implement run leaves a real commit on the
// feature branch (not a dirty working tree). This is what makes the diff
// endpoint (`git log main..HEAD --stat`) and the commit_sha column on
// tickets meaningful. Without it, opencode can finish implementation,
// report success, and never `git commit`, leaving the worktree dirty and
// review showing an empty diff.
//
// Behavior:
//   - If working tree is dirty (staged + unstaged + untracked), `git add -A`
//     and commit with the provided message.
//   - If already clean (opencode committed mid-run), just return current HEAD.
//   - On any failure, log to activity and return null — never throw. The
//     implement pipeline continues so the user can still see the dirty
//     worktree in the review diff fallback.
function commitWorktreeChanges(worktreePath, ticketId, message, { partial = false } = {}) {
  const tag = partial ? 'commit_partial' : 'commit';
  try {
    const status = runGit(`status --porcelain`, worktreePath);
    let sha;
    if (status) {
      runGit(`add -A`, worktreePath);
      runGit(`commit -m "${message.replace(/"/g, '')}"`, worktreePath);
      sha = runGit(`rev-parse HEAD`, worktreePath);
    } else {
      sha = runGit(`rev-parse HEAD`, worktreePath);
    }
    db.logActivity(ticketId, tag, `${sha.slice(0, 7)}: ${message.replace(/"/g, '')}`);
    return sha;
  } catch (err) {
    db.logActivity(ticketId, 'commit_failed', err.message.slice(0, 200));
    return null;
  }
}

function ensureWorktreesDir() {
  if (!fs.existsSync(WORKTREES_DIR)) fs.mkdirSync(WORKTREES_DIR, { recursive: true });
}

// ── Unit test runner ──────────────────────────────────────
// Auto-detect the test framework in a worktree and run the unit
// test suite.  Results stream to the ticket's test_runs table
// and broadcast over SSE so the UI can show a pass/fail pill
// without polling.  The runner is fire-and-forget: the HTTP
// request that triggers it returns immediately with a runId,
// and the SSE channel delivers the final status.
//
// Detection order (most specific first):
//   1. package.json with a "test" script  → npm test
//   2. go.mod                            → go test ./...
//   3. Cargo.toml                        → cargo test
//   4. pyproject.toml / setup.py / pytest.ini / tests dir
//                                      → pytest (or pyxen.test for the pyxen repo)
//   5. fallthrough                       → shell: bash scripts/test.sh or similar
//
// We keep this intentionally simple — NO dependency resolution,
// NO test discovery tricks.  Whatever the project ships with
// is what gets run, so failures are real and reproducible.

function detectTestFramework(worktreePath) {
  if (!worktreePath || !fs.existsSync(worktreePath)) return null;

  const has = (p) => fs.existsSync(path.join(worktreePath, p));
  const read = (p) => { try { return fs.readFileSync(path.join(worktreePath, p), 'utf-8'); } catch { return ''; } };

  // npm — package.json with scripts.test
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

  // pyxen-specific shortcut: use the meta-runner that aggregates
  // every module's `_main()` test function.  This is the primary
  // path for the pyxen project this dashboard was built for.
  // Use the project's .venv python when available — worktrees don't
  // ship their own venv, and `python` (vs python3) is rarely on PATH
  // on modern Linux.
  const isPyxen = has('pyproject.toml') && /name\s*=\s*["']pyxen["']/.test(read('pyproject.toml'));
  if (isPyxen) {
    const venvPy = path.join(PYXEN_DIR, '.venv', 'bin', 'python');
    const py = fs.existsSync(venvPy) ? venvPy : 'python3';
    const envOverride = `PYTHONPATH=${path.join(PYXEN_DIR, 'src')}`;
    const cmd = process.env.PYXEN_TEST_CMD || `${envOverride} ${py} -m pyxen.test`;
    return { framework: 'pytest', command: cmd };
  }

  // generic pytest
  if (has('pyproject.toml') || has('pytest.ini') || has('setup.py') || has('tests/') || has('test/')) {
    const venvPy = path.join(PYXEN_DIR, '.venv', 'bin', 'python');
    const py = fs.existsSync(venvPy) ? venvPy : 'python3';
    return { framework: 'pytest', command: `${py} -m pytest -x --tb=short -q` };
  }

  // fallback: scripts/test.sh or scripts/run-tests.sh
  if (has('scripts/test.sh')) return { framework: 'shell', command: 'bash scripts/test.sh' };
  if (has('scripts/run-tests.sh')) return { framework: 'shell', command: 'bash scripts/run-tests.sh' };

  return null;
}

// Run a test command, capturing stdout+stderr into one stream.
// Resolves with { exit_code, output, summary, duration_ms }.
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
        env: { ...process.env, PYTHONPATH: path.join(PYXEN_DIR, 'src') },
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return finish('error', { exit_code: -1, output: 'spawn error: ' + err.message });
    }
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      const status = code === 0 ? 'pass' : 'fail';
      finish(status, { exit_code: code });
    });
    proc.on('error', err => finish('error', { exit_code: -1, output: 'proc error: ' + err.message }));
  });
}

// Parse common test summary lines out of pytest/pytest-style output.
// Returns { passed, failed, errored, skipped } or null if nothing matched.
function parseTestSummary(output) {
  if (!output) return null;
  // pytest: "= 12 passed, 1 failed, 2 skipped in 0.42s ="
  const m = output.match(/(\d+)\s+passed(?:.*?(\d+)\s+failed)?(?:.*?(\d+)\s+error(?:ed|s)?)?(?:.*?(\d+)\s+skipped)?/i);
  if (m && (m[1] || m[2])) {
    return {
      passed: parseInt(m[1] || '0', 10),
      failed: parseInt(m[2] || '0', 10),
      errored: parseInt(m[3] || '0', 10),
      skipped: parseInt(m[4] || '0', 10),
    };
  }
  // go test: "ok  \tfoo\t0.123s" / "FAIL\tfoo\t..."
  const goOk = (output.match(/^ok\s/gm) || []).length;
  const goFail = (output.match(/^FAIL\s/gm) || []).length;
  if (goOk + goFail > 0) return { passed: goOk, failed: goFail, errored: 0, skipped: 0 };
  // cargo test
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

// Public: kick off the test suite for a ticket's worktree.
// Fire-and-forget: returns the runId immediately; SSE delivers status.
function runTicketTests(ticketId, triggeredBy = 'auto') {
  const ticket = db.getTicket(ticketId);
  if (!ticket) return null;
  const wt = ticket.worktree_path;
  if (!wt || !fs.existsSync(wt)) {
    const runId = db.createTestRun(ticketId, null, null, triggeredBy);
    db.finalizeTestRun(runId, {
      status: 'skip',
      output: 'No worktree available — tests skipped.',
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

  // Detached promise — caller doesn't await.
  (async () => {
    const result = await execTestCommand(det.command, wt, 300_000);
    const parsed = parseTestSummary(result.output);
    const summary = formatSummary(parsed, result.status);
    const row = db.finalizeTestRun(runId, { ...result, summary });
    db.logActivity(ticketId, 'test_' + result.status, `${det.framework}: ${summary} (${Math.round((result.duration_ms || 0) / 100) / 10}s)`);
    sseBroadcast(ticketId, 'test_status', {
      run_id: runId,
      status: row.status,
      framework: det.framework,
      summary: row.summary,
      exit_code: row.exit_code,
      duration_ms: row.duration_ms,
    });
  })().catch(err => {
    db.finalizeTestRun(runId, { status: 'error', output: 'runner crash: ' + err.message });
    sseBroadcast(ticketId, 'test_status', { run_id: runId, status: 'error' });
  });

  return runId;
}

// Build a concise textual summary of the latest test run for a ticket,
// suitable for embedding into the implementation prompt as context
// when the user clicks "Continue" on a ticket in review.
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
    // Show the last 60 lines so opencode sees the actual failure shape.
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

// ── List all tickets ──────────────────────────────────────
app.get('/api/tickets', (req, res) => {
  const tickets = db.getAllTickets();
  res.json({
    tickets,
    stages: ['clarification', 'implementation', 'review', 'ready', 'done'],
    stageLabels: STAGE_LABELS
  });
});

// ── Get single ticket ─────────────────────────────────────
app.get('/api/tickets/:id', (req, res) => {
  const t = db.getTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'Ticket not found' });
  const stageResources = db.getStageResources(req.params.id);
  const latestTest = db.getLatestTestRun(req.params.id);
  res.json({ ...t, stage_resources: stageResources, latest_test: latestTest });
});

// ── SSE stream ────────────────────────────────────────────
app.get('/api/tickets/:id/stream', (req, res) => {
  const ticketId = req.params.id;
  const t = db.getTicket(ticketId);
  if (!t) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx
  res.flushHeaders();

  // Register for direct resource pushes from opencode
  if (!sseClients.has(ticketId)) sseClients.set(ticketId, new Set());
  sseClients.get(ticketId).add(res);

  // Lightweight poll for non-resource changes (activity, status, stage)
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
        const payload = { ...t2, stage_resources: sr, latest_test: latestTest };
        res.write(`event: ticket\ndata: ${JSON.stringify(payload)}\n\n`);
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
  const ticket = db.createTicket({
    id, title: title.trim(), content: (content || '').trim(),
    created_at: now, updated_at: now
  });
  res.status(201).json(ticket);
});

// ── Stage 1: Clarification ────────────────────────────────
app.post('/api/tickets/:id/clarify', async (req, res) => {
  const ticket = db.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.stage !== 'clarification') return res.status(400).json({ error: `Ticket is in ${ticket.stage} stage` });
  if (ticket.status === 'running') return res.status(409).json({ error: 'Already processing, wait for completion' });

  let extraContext = '';
  if (ticket.review_feedback) {
    extraContext = `\n\nReview feedback from previous implementation:\n${ticket.review_feedback}`;
  }

  // Heavy ticket state goes to file; the CLI argv only carries the
  // directive + path. See PROMPT_PREFIXES and writeTicketContext above.
  const contextFile = writeTicketContext(ticket.id, [
    { title: 'Ticket title', body: ticket.title },
    { title: 'Ticket description', body: ticket.content },
    ticket.review_feedback && {
      title: 'Review feedback from previous implementation',
      body: ticket.review_feedback,
    },
  ].filter(Boolean));

  const prompt = `${PROMPT_PREFIXES.clarify}\n\nRead full ticket context at: ${contextFile}`;

  try {
    db.clearStageActivity(ticket.id, 'clarification');
    db.logActivity(ticket.id, 'clarify_start');
    db.updateTicketField(ticket.id, 'status', 'running');
    const onProgress = (line) => {
      if (line.startsWith('[resource] ')) {
        sseBroadcast(ticket.id, 'resource', { detail: line.slice(11) });
      } else {
        sseBroadcast(ticket.id, 'stdout', { text: line });
      }
    };
    const output = await runOpenCode(ticket.id, prompt, onProgress, 'clarification');
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

    // Delete old questions for this ticket (fresh start)
    db.deleteQuestionsForTicket(ticket.id);

    for (const q of questions) {
      if (typeof q === 'string') {
        // Backward compat: plain string question
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
  if (!answers || Object.keys(answers).length === 0) {
    return res.status(400).json({ error: 'No answers provided' });
  }

  // Save answers
  for (const [qId, answer] of Object.entries(answers)) {
    const q = ticket.questions.find(q => q.id === parseInt(qId));
    if (q) db.updateQuestionAnswer(q.id, ticket.id, answer);
  }

  db.logActivity(ticket.id, 'answers_submitted', JSON.stringify(answers).slice(0, 200));

  // Build Q&A context
  const updatedTicket = db.getTicket(ticket.id);
  const qaText = updatedTicket.questions.map((q, i) =>
    `Q${i + 1}: ${q.question}\nA${i + 1}: ${q.answer || '(no answer yet)'}`
  ).join('\n\n');

  // Heavy ticket state goes to file; the CLI argv only carries the
  // directive + path. See PROMPT_PREFIXES and writeTicketContext above.
  const contextFile = writeTicketContext(updatedTicket.id, [
    { title: 'Ticket title', body: updatedTicket.title },
    { title: 'Ticket description', body: updatedTicket.content },
    { title: 'Clarification Q&A', body: qaText },
    updatedTicket.review_feedback && {
      title: 'Previous review feedback',
      body: updatedTicket.review_feedback,
    },
  ].filter(Boolean));

  const prompt = `${PROMPT_PREFIXES.evaluate}\n\nRead full ticket context at: ${contextFile}`;

  try {
    db.clearStageActivity(ticket.id, 'clarification');
    db.logActivity(ticket.id, 'answer_process');
    db.updateTicketField(ticket.id, 'status', 'running');
    const onProgress = (line) => {
      if (line.startsWith('[resource] ')) {
        sseBroadcast(ticket.id, 'resource', { detail: line.slice(11) });
      } else {
        sseBroadcast(ticket.id, 'stdout', { text: line });
      }
    };
    const output = await runOpenCode(ticket.id, prompt, onProgress, 'clarification');
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

    // All clarified - store plan and move to implementation
    db.updateTicket(ticket.id, {
      plan: parsed.plan || '',
      review_feedback: null,
      stage: 'implementation'
    });
    db.logActivity(ticket.id, 'clarified_plan', parsed.notes || '');
    if (parsed.files_to_modify) {
      db.logActivity(ticket.id, 'files_affected', parsed.files_to_modify.join(', '));
    }

    const finalTicket = db.getTicket(ticket.id);
    res.json({ clarified: true, plan: finalTicket.plan, notes: parsed.notes, ticket: finalTicket });
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
  if (ticket.stage !== 'implementation' && ticket.stage !== 'review') return res.status(400).json({ error: `Ticket is in ${ticket.stage} stage` });
  if (ticket.status === 'running') return res.status(409).json({ error: 'Already processing, wait for completion' });

  // If coming from review (continue), move back to implementation
  const wasReview = ticket.stage === 'review';
  if (wasReview) {
    db.updateTicket(ticket.id, { stage: 'implementation' });
    db.logActivity(ticket.id, 'continued', 'Resuming implementation from review');
    ticket = db.getTicket(ticket.id);
  }

  ensureWorktreesDir();
  const safeId = ticket.id.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const branchName = `feature/${safeId}`;
  const worktreePath = path.join(WORKTREES_DIR, safeId);

  try {
    // Ensure worktree exists
    const dirHere = fs.existsSync(worktreePath);
    const tracked = (() => { try { return execSync(`git worktree list`, { cwd: PYXEN_DIR, encoding: 'utf-8' }).includes(worktreePath); } catch { return false; } })();
    console.log(`[implement] ${ticket.id} dirHere=${dirHere} tracked=${tracked} path=${worktreePath}`);

    if (dirHere && tracked) {
      // Worktree already set up
    } else if (dirHere && !tracked) {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      try { runGit(`branch -D ${branchName}`); } catch {}
      runGit(`checkout -b ${branchName}`);
      runGit(`checkout main`);
      runGit(`worktree add ${worktreePath} ${branchName}`);
    } else {
      try { runGit(`branch -D ${branchName}`); } catch {}
      runGit(`checkout -b ${branchName}`);
      runGit(`checkout main`);
      runGit(`worktree add ${worktreePath} ${branchName}`);
    }

    db.updateTicket(ticket.id, { worktree_path: worktreePath, branch_name: branchName });
    db.logActivity(ticket.id, 'worktree_created', worktreePath);

    const qaText = ticket.questions.map((q, i) =>
      `Q: ${q.question}\nA: ${q.answer || 'N/A'}`
    ).join('\n');

    // If resuming from review (Continue), inject the latest unit-test
    // report as ticket context so opencode can either fix what's broken
    // or ask clarifying questions about the failures.
    const testContext = wasReview ? buildTestContextForPrompt(ticket.id) : '';

    // Heavy ticket state goes to file; the CLI argv only carries the
    // directive + paths. See PROMPT_PREFIXES and writeTicketContext above.
    // The worktree path is repeated in the context file's header so an
    // opencode agent that lands on a stale prompt can still find it.
    const contextFile = writeTicketContext(ticket.id, [
      { title: 'Worktree', body: `Work in this directory:\n\n\`\`\`\n${worktreePath}\n\`\`\`` },
      { title: 'Ticket title', body: ticket.title },
      { title: 'Ticket description', body: ticket.content },
      { title: 'Clarification Q&A', body: qaText },
      { title: 'Implementation plan', body: ticket.plan || '(no plan yet)' },
      ticket.review_feedback && {
        title: 'Review feedback from previous implementation',
        body: ticket.review_feedback,
      },
      testContext && { title: 'Most recent test run', body: testContext },
    ].filter(Boolean));

    const prompt = `${PROMPT_PREFIXES.implement}\n\nRead full ticket context at: ${contextFile}\nWork in: ${worktreePath}`;

    db.clearStageActivity(ticket.id, 'implementation');
    db.logActivity(ticket.id, 'implement_start');
    db.updateTicketField(ticket.id, 'status', 'running');

    const tokensBefore = getOpencodeTokens();

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
        sseBroadcast(ticket.id, 'resource', { detail: line.slice(11) });
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
    const output = await runOpenCode(ticket.id, prompt, onProgress, 'implementation', 600_000);

    // Store token usage delta
    const tokensAfter = getOpencodeTokens();
    const tokenDelta = {
      cost: (tokensAfter.cost - tokensBefore.cost).toFixed(3),
      input: tokensAfter.input, output: tokensAfter.output
    };
    db.updateTicket(ticket.id, {
      token_cost: parseFloat(tokenDelta.cost),
      token_input: tokenDelta.input,
      token_output: tokenDelta.output
    });
    db.logActivity(ticket.id, 'token_usage', JSON.stringify(tokenDelta));

    clearInterval(fileMonitor);

    // Commit gate: ensure every implement run leaves a real commit on the
    // feature branch. Without this, opencode can finish, pass tests, and
    // transition to review while the worktree is still dirty — leaving the
    // diff endpoint (git log main..HEAD --stat) empty and commit_sha null.
    const commitSha = commitWorktreeChanges(
      worktreePath,
      ticket.id,
      `${ticket.id}: implement`,
    );

    // Capture diff from committed history (matches /api/tickets/:id/diff on
    // line 1142). Falls back to a dirty-tree diff only if the commit gate
    // itself failed, so reviewers still see what the agent produced.
    let diffSummary = '';
    try {
      diffSummary = runGit(`log main..HEAD --stat`, worktreePath);
    } catch { /* fall through */ }
    if (!diffSummary) {
      try { diffSummary = runGit(`diff --stat HEAD`, worktreePath); } catch { diffSummary = '(no diff)'; }
    }

    // Save cumulative CPU/elapsed from last resource entry
    const t2 = db.getTicket(ticket.id);
    if (!t2) return res.status(500).json({ error: 'Ticket data lost' });
    const lastRes = (t2.activity || []).find(a => a.action === 'resource');
    if (lastRes) {
      const p = Object.fromEntries(lastRes.detail.split(' ').map(s => s.split('=')));
      db.updateTicket(ticket.id, {
        total_cpu: p.cpu || '0',
        total_elapsed: p.elapsed || '0',
        commit_sha: commitSha || null,
        stage: 'review',
        status: 'idle'
      });
    } else {
      db.updateTicket(ticket.id, {
        commit_sha: commitSha || null,
        stage: 'review',
        status: 'idle'
      });
    }
    db.logActivity(ticket.id, 'implement_done', diffSummary.slice(0, 500));

    // Kick off the unit-test suite on the worktree.  Fire-and-forget:
    // we don't block the implement response on test results — the
    // SSE channel delivers test_status when the run finishes, and the
    // UI renders the pass/fail pill without polling.
    const testRunId = runTicketTests(ticket.id, 'auto');

    res.json({
      success: true, worktree_path: worktreePath, branch_name: branchName,
      diff_summary: diffSummary, output_summary: output.slice(-1000),
      test_run_id: testRunId,
      ticket: db.getTicket(ticket.id)
    });
  } catch (err) {
    const t2 = db.getTicket(ticket.id);
    if (t2) {
      const lastRes = (t2.activity || []).find(a => a.action === 'resource');
      if (lastRes) {
        const p = Object.fromEntries(lastRes.detail.split(' ').map(s => s.split('=')));
        db.updateTicket(ticket.id, {
          total_cpu: p.cpu || '0',
          total_elapsed: p.elapsed || '0'
        });
      }
      const partialSha = commitWorktreeChanges(
        worktreePath,
        ticket.id,
        `${ticket.id}: partial (error: ${err.message.slice(0, 80).replace(/"/g, '')})`,
        { partial: true },
      );
      db.logActivity(ticket.id, 'implement_error', err.message);
      db.updateTicket(ticket.id, {
        commit_sha: partialSha || null,
        stage: 'review',
        status: 'idle',
      });
      // Still run tests on the partial work — the user needs to know
      // whether the partial state passes / fails before continuing.
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

  db.updateTicket(ticket.id, {
    stage: 'clarification',
    review_feedback: feedback.trim(),
    plan: null
  });
  db.logActivity(ticket.id, 'review_feedback', feedback.trim().slice(0, 300));

  res.json({ success: true, message: 'Ticket moved back to clarification', ticket: db.getTicket(ticket.id) });
});

// ── Stage 4: Ready → cherry-pick + close ──────────────────
// Contract: the squash + cherry-pick into the main checkout MUST
// succeed before the worktree (and its branch) are deleted.
// If anything fails — broken worktree, no changes, squash error,
// rebase conflict, cherry-pick conflict — the ticket stays in
// 'review' with an activity entry explaining the failure.  The
// worktree is left intact so the user can investigate, retry, or
// commit manually.
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

  // Pre-flight integrity check: refuse to silently close a ticket
  // whose worktree is broken (the MQWSMW10 bug).  If the .git
  // pointer is missing or the branch doesn't resolve, bail loudly.
  if (!ticket.worktree_path || !fs.existsSync(path.join(ticket.worktree_path, '.git'))) {
    const msg = `Worktree integrity check failed: ${ticket.worktree_path || '(unset)'}/.git is missing or invalid. Cherry-pick aborted — investigate manually before retrying.`;
    db.logActivity(ticket.id, 'ready_error', msg);
    return res.status(500).json({ error: msg, ticket: db.getTicket(ticket.id) });
  }
  try {
    runGit(`rev-parse --verify ${ticket.branch_name}`, ticket.worktree_path);
  } catch (err) {
    const msg = `Worktree integrity check failed: branch '${ticket.branch_name}' does not resolve in the worktree (${err.message}). Cherry-pick aborted — investigate manually.`;
    db.logActivity(ticket.id, 'ready_error', msg);
    return res.status(500).json({ error: msg, ticket: db.getTicket(ticket.id) });
  }

  let commitSha = null;
  try {
    // Detect any work to merge: uncommitted changes OR unmerged commits
    // on the branch.  Previously we only checked the working-tree diff,
    // which silently missed the case where opencode committed everything
    // to the branch (no working-tree diff, but real commits to ship).
    let hasChanges = false;
    try { runGit(`diff --quiet`, ticket.worktree_path); } catch { hasChanges = true; }
    try { runGit(`diff --cached --quiet`, ticket.worktree_path); } catch { hasChanges = true; }
    if (!hasChanges) {
      try {
        const ahead = parseInt(runGit(`rev-list --count main..${ticket.branch_name}`, ticket.worktree_path), 10) || 0;
        if (ahead > 0) hasChanges = true;
      } catch {}
    }

    if (!hasChanges) {
      // No work to merge.  Don't auto-close — a no-op "Ready" might
      // mean opencode produced nothing (e.g., it errored mid-run)
      // and the user should re-implement, not silently mark done.
      const msg = 'No uncommitted changes and no commits ahead of main on this branch. Opencode may have produced nothing — ticket stays in review so you can Continue (re-implement) or investigate.';
      db.logActivity(ticket.id, 'no_changes', msg);
      return res.status(409).json({ error: msg, ticket: db.getTicket(ticket.id) });
    }

    const commitMsg = `${ticket.id}: ${ticket.title}`;
    runGit(`add -A`, ticket.worktree_path);

    // Squash everything into one clean commit
    try {
      const mergeBase = runGit(`merge-base main ${ticket.branch_name}`);
      runGit(`reset --soft ${mergeBase}`, ticket.worktree_path);
      db.logActivity(ticket.id, 'squashed', `All commits squashed to merge-base ${mergeBase.slice(0, 7)}`);
    } catch {
      db.logActivity(ticket.id, 'squash_skipped', 'Could not find merge-base, committing as-is');
    }

    runGit(`commit -m "${commitMsg}"`, ticket.worktree_path);
    commitSha = runGit(`rev-parse HEAD`, ticket.worktree_path);
    db.logActivity(ticket.id, 'committed', commitSha);

    // Rebase onto main before cherry-pick to reduce conflict surface
    // Run in the worktree (branch is locked there — can't checkout from main repo)
    try {
      runGit(`rebase main`, ticket.worktree_path);
      commitSha = runGit(`rev-parse HEAD`, ticket.worktree_path); // rebase rewrites SHA
      runGit(`checkout main`);
    } catch (err) {
      db.logActivity(ticket.id, 'rebase_failed', err.message);
      try { runGit(`rebase --abort`, ticket.worktree_path); } catch {}
      try { runGit(`checkout main`); } catch {}
      // Rebase failed — still try the cherry-pick with original commitSha
    }

    runGit(`cherry-pick ${commitSha}`);
    db.logActivity(ticket.id, 'cherry_picked', commitSha);

    db.updateTicket(ticket.id, { stage: 'done', commit_sha: commitSha });

    // SUCCESS — only now is it safe to clean up the worktree.
    cleanupWorktreeAfterSuccess(ticket.id);

    res.json({ success: true, commit_sha: commitSha, ticket: db.getTicket(ticket.id) });
  } catch (err) {
    // FAILURE — keep the worktree intact so the user can investigate.
    // The squashed commit (if we got that far) is still on the branch.
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
// Returns the raw `git log --stat` text + a flat list of changed
// file paths (post-image for renames) so the UI can link them to
// the file explorer (port 18802).
app.get('/api/tickets/:id/diff', (req, res) => {
  const ticket = db.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (!ticket.worktree_path || !fs.existsSync(ticket.worktree_path)) {
    return res.json({ diff: '(no worktree available)', files: [], explorer_prefix: null });
  }
  try {
    const diff = runGit(`log main..HEAD --oneline --stat`, ticket.worktree_path);
    let files = [];
    try {
      // --name-only gives post-image paths even for renames; --diff-filter=ACMRT
      // keeps added/copied/renamed/modified but drops pure deletions (Explorer
      // can't link to a file that no longer exists on disk).
      const nameOnly = runGit(
        `diff --name-only --diff-filter=ACMRT main..HEAD`,
        ticket.worktree_path
      );
      files = nameOnly.split('\n').map(s => s.trim()).filter(Boolean);
    } catch {}
    // Explorer (port 18802) serves from os.homedir(); strip that prefix so
    // the frontend can build /explorer/<encoded> URLs without knowing layout.
    const homeDir = os.homedir();
    const explorerPrefix = ticket.worktree_path.startsWith(homeDir + '/')
      ? ticket.worktree_path.slice(homeDir.length + 1)
      : ticket.worktree_path;
    res.json({
      diff: diff || '(no changes)',
      files,
      explorer_prefix: explorerPrefix,
    });
  } catch (err) {
    res.json({ diff: `Error: ${err.message}`, files: [], explorer_prefix: null });
  }
});

// ── Unit-test results per ticket ───────────────────────────
// Returns the latest run (for popup pill + report) plus a small
// history so the user can see whether a re-run fixed things.
// Output is truncated server-side already (db.finalizeTestRun).
app.get('/api/tickets/:id/tests', (req, res) => {
  const ticket = db.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const latest = db.getLatestTestRun(req.params.id);
  const history = db.getTestRuns(req.params.id, 10);
  res.json({ latest, history });
});

// Manually re-run the unit-test suite for a ticket's worktree.
// Used by the "Re-run tests" button on the popup.  Returns a
// runId immediately; the final status arrives via the SSE
// `test_status` event.
app.post('/api/tickets/:id/tests/run', (req, res) => {
  const ticket = db.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const runId = runTicketTests(req.params.id, 'manual');
  res.json({ run_id: runId, status: 'running' });
});

// Run unit tests on main checkout (top-level) — streaming
const runResults = {};

app.post('/api/test', (req, res) => {
  const runId = 'test-' + Date.now();
  const outFile = path.join(DATA_DIR, runId + '.log');
  runResults[runId] = { status: 'running', file: outFile };
  res.json({ runId });

  const venvBin = path.join(PYXEN_DIR, '.venv', 'bin');
  const python = fs.existsSync(path.join(venvBin, 'python')) ? path.join(venvBin, 'python') : 'python3';
  const out = fs.createWriteStream(outFile);
  const proc = spawn(python, ['-m', 'pyxen.test'], {
    cwd: PYXEN_DIR,
    env: { ...process.env, PYTHONPATH: path.join(PYXEN_DIR, 'src') },
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe']
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

// Dry-run pre-push hook
app.post('/api/prepush', (req, res) => {
  const hookPath = path.join(PYXEN_DIR, '.githooks', 'pre-push');
  if (!fs.existsSync(hookPath)) return res.status(400).json({ error: 'Pre-push hook not found' });

  const runId = 'prepush-' + Date.now();
  const outFile = path.join(DATA_DIR, runId + '.log');
  runResults[runId] = { status: 'running', file: outFile };
  res.json({ runId });

  const out = fs.createWriteStream(outFile);
  const proc = spawn('bash', [hookPath], {
    cwd: PYXEN_DIR,
    env: { ...process.env, PYTHONPATH: path.join(PYXEN_DIR, 'src') },
    timeout: 300_000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.pipe(out);
  proc.stderr.pipe(out);
  proc.on('close', code => { runResults[runId].status = code === 0 ? 'pass' : 'fail'; });
  proc.on('error', err => { fs.appendFileSync(outFile, '\nError: ' + err.message); runResults[runId].status = 'fail'; });
});

// ── Suggested tickets ──────────────────────────────────────
let suggestions = [];
const SUGGESTIONS_MAX = 5;

async function generateSuggestions() {
  try {
    const visionPath = path.join(PYXEN_DIR, 'docs', 'vision.md');
    const vision = fs.existsSync(visionPath) ? fs.readFileSync(visionPath, 'utf-8') : '';

    // Vision doc goes to file; the CLI argv only carries the directive
    // + path. Suggestions are pseudo-tickets (id '_suggestions') so we
    // write to a stable slot rather than a per-ticket dir.
    const sugDir = path.join(PYXEN_DIR, '.opencode', 'tickets', '_suggestions');
    fs.mkdirSync(sugDir, { recursive: true });
    const contextFile = path.join(sugDir, 'context.md');
    fs.writeFileSync(contextFile,
      `# Suggestion generation context\n\n_Generated ${new Date().toISOString()}._\n\n` +
      `## Project root\n\n\`\`\`\n${PYXEN_DIR}\n\`\`\`\n\n` +
      `## Project vision (${visionPath})\n\n${vision}\n`
    );

    const prompt = `${PROMPT_PREFIXES.suggest}\n\nSuggest ${SUGGESTIONS_MAX} tickets.\n\nRead vision + project root at: ${contextFile}`;
    const output = await runOpenCode('_suggestions', prompt, undefined, null, 120_000);
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (parsed && Array.isArray(parsed.tickets)) {
      suggestions = parsed.tickets.map(t => ({
        id: 'sug-' + crypto.randomBytes(4).toString('hex'),
        title: t.title,
        content: t.content
      }));
      console.log(`Generated ${suggestions.length} ticket suggestions`);
    }
  } catch (e) {
    console.log('Suggestion generation failed:', e.message);
  }
}

app.get('/api/suggestions', (req, res) => {
  res.json(suggestions);
});

app.post('/api/suggestions/:id/accept', (req, res) => {
  const sug = suggestions.find(s => s.id === req.params.id);
  if (!sug) return res.status(404).json({ error: 'Not found' });
  const id = ticketId(sug.title);
  const now = new Date().toISOString();
  const ticket = db.createTicket({
    id, title: sug.title.trim(), content: (sug.content || '').trim(),
    created_at: now, updated_at: now
  });
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
// Crash recovery: reset any tickets stuck in "running"
(function recoverStuckTickets() {
  const ids = db.getTicketIds();
  let changed = false;
  for (const tid of ids) {
    const t = db.getTicket(tid);
    if (t && t.status === 'running') {
      let alive = false;
      if (t.ocode_session) {
        try {
          const sessions = execSync(`${OPENCODE_BIN} session list`, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
          alive = sessions.includes(t.ocode_session);
        } catch {}
      }
      if (!alive) {
        db.updateTicketField(tid, 'status', 'idle');
        db.logActivity(tid, 'recovered', 'Server restarted — previous opencode session gone, reset to idle');
        changed = true;
        console.log(`Recovered: ${tid} reset to idle (session not alive)`);
      }
    }
  }
  if (changed) console.log('Crash recovery complete');
})();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Pyxen Jira Dashboard running on http://0.0.0.0:${PORT}`);
  console.log(`   Pyxen: ${PYXEN_DIR}`);
  console.log(`   OpenCode: ${OPENCODE_BIN}`);
  console.log(`   Data: SQLite at data/store.db`);
  if (suggestions.length < SUGGESTIONS_MAX) generateSuggestions();
});
