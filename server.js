const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Ajv = require('ajv');

const config = require('./config');
const prompts = require('./prompts');
const db = require('./db');
const worktrees = require('./worktree-manager');
const helpers = require('./helpers');
const { sseClients, sseBroadcast } = require('./sse');
const { writeTicketContext } = require('./context');
const { runCoder, killTicketProcess, isClosed, ticketGone, captureSessionId, runningProcs } = require('./coder-runner');
const { runGit, execAsync, resolveDiffBase, popStashAndStage, assertWorktreeClean, getBranchStaleness, commitWorktreeChanges } = require('./git-utils');
const { runTicketTests, buildTestContextForPrompt } = require('./test-runner');
const { startPrChecker } = require('./pr-checker');
const { runMachineChecks } = require('./machine-checks');
let _recheckTicket = null;
let _startWatchingPr = null;
let _runClarify = null;
let _systemChecks = [];

const { PREPUSH_RUN_PREFIX, TEST_RUN_PREFIX, STAGE_LABELS, uid, slugFromTitle, ticketId, formatPlanText, escShell } = helpers;

const PORT = config.port;
const DATA_DIR = config.dataDir;

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
  const cwd = ticket.worktree_path || config.projectDir;
  const result = await runCoder(ticket.id, prompt, { timeout: config.coder.timeouts.clarify, onProgress, cwd });
    captureSessionId(ticket.id, result.sessionId);
    db.updateTicketField(ticket.id, 'status', 'idle');
    const output = result.text;

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

// Push the ticket branch and open a PR in the background. The `git push` can be
// slow when the repo has a heavy local pre-push hook, so this runs AFTER the
// HTTP response is sent (via execAsync, which does not block the event loop).
// While it runs the ticket stays in `review` with status `running`; on success
// it advances to `done`, on failure it drops back to idle with the squashed
// commit preserved on the branch so the user can retry `ready`.
//
// Because this runs after the response, the ticket can be closed or deleted
// mid-push. The child is registered in runningProcs so /close and /delete can
// kill it (and the git/hook/ssh subtree) before releasing the worktree, and
// every terminal state write is guarded by ticketGone() so a completed push
// never resurrects a ticket the user already closed or removed.
async function pushAndOpenPr(ticketId, branchName, title, worktreePath) {
  const pushTimeout = config.coder.timeouts.push || 600_000;
  const cmdTimeout = config.coder.timeouts.command;
  const register = (proc) => runningProcs.set(ticketId, proc);
  try {
    await execAsync(`git push --force origin ${branchName}`, worktreePath, pushTimeout, register);
    if (ticketGone(ticketId)) return;
    db.logActivity(ticketId, 'branch_pushed', `Pushed ${branchName} to origin`);

    const t = db.getTicket(ticketId);
    let prUrl = t?.pr_url || null;
    if (!prUrl) {
      try {
        prUrl = await execAsync(`gh pr create --title "${escShell(title)}" --body ""`, worktreePath, cmdTimeout, register);
        db.logActivity(ticketId, 'pr_created', prUrl);
      } catch {
        const remoteUrl = await execAsync(`git config --get remote.origin.url`, worktreePath, cmdTimeout, register);
        const repoPath = remoteUrl.replace(/\.git$/, '').replace(/^.*[:/]/, '');
        prUrl = `https://github.com/${repoPath}/pull/new/${branchName}`;
        db.logActivity(ticketId, 'pr_link', prUrl);
      }
    }

    if (ticketGone(ticketId)) return;
    db.updateTicket(ticketId, { stage: 'pr_opened', status: 'idle', pr_url: prUrl });
    await worktrees.release(ticketId);
    // Kick off periodic PR watching for this ticket.  Idempotent — safe even
    // if scheduleAll already picked it up (e.g. after a server restart).
    if (typeof _startWatchingPr === 'function') _startWatchingPr(ticketId);
  } catch (err) {
    if (ticketGone(ticketId)) return;
    db.logActivity(
      ticketId,
      'ready_error',
      `Push failed: ${err.message}. Squashed commit is still on branch ${branchName} in the worktree — ticket stays in review, retry when ready.`
    );
    db.updateTicketField(ticketId, 'status', 'idle');
  } finally {
    runningProcs.delete(ticketId);
  }
}





// ── Post-implement finalizer (commit, diff, transition) ─────
// Shared between the /implement handler and crash-recovery re-attach.
async function finishImplement(ticketId, worktreePath, runTokens, onProgress) {
  const ticket = db.getTicket(ticketId);

  const tokens = runTokens || { cost: 0, input: '0', output: '0' };
  db.updateTicket(ticket.id, {
    token_cost: (parseFloat(ticket.token_cost) || 0) + (parseFloat(tokens.cost) || 0),
    token_input: String((parseInt(ticket.token_input) || 0) + (parseInt(tokens.input) || 0)),
    token_output: String((parseInt(ticket.token_output) || 0) + (parseInt(tokens.output) || 0)),
  });
  db.logActivity(ticket.id, 'token_usage', JSON.stringify(tokens));

  let commitSha = commitWorktreeChanges(worktreePath, ticket.id, `${ticket.id}: implement`);
  if (!commitSha) {
    try { commitSha = runGit(`rev-parse HEAD`, worktreePath); } catch {}
  }

  let diffSummary = '';
  try { diffSummary = runGit(`log ${resolveDiffBase(worktreePath)}..HEAD --stat`, worktreePath); } catch {}
  if (!diffSummary) {
    try { diffSummary = runGit(`diff --stat HEAD`, worktreePath); } catch { diffSummary = '(no diff)'; }
  }

  const t2 = db.getTicket(ticket.id);
  if (!t2) return { error: 'Ticket data lost' };
  const lastRes = (t2.activity || []).find(a => a.action === 'resource');
  const p = lastRes ? Object.fromEntries(lastRes.detail.split(' ').map(s => s.split('='))) : {};
  db.updateTicket(ticket.id, {
    total_cpu: p.cpu || '0', total_elapsed: p.elapsed || '0',
    commit_sha: commitSha || null, stage: 'review', status: 'idle',
  });
  db.logActivity(ticket.id, 'implement_done', diffSummary.slice(0, 500));
  assertWorktreeClean(ticket, { stage: 'implement' });

  const testRunId = runTicketTests(ticket.id, 'auto');
  return { success: true, commit_sha: commitSha, diff_summary: diffSummary, test_run_id: testRunId };
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
    branchDefault: config.branchDefault,
    mergeStrategy: config.mergeStrategy,
  });
});

// ── List all tickets ──────────────────────────────────────
app.get('/api/tickets', (req, res) => {
  const tickets = db.getAllTickets();
  res.json({ tickets, stages: ['clarification', 'implementation', 'review', 'ready', 'pr_opened', 'done'], stageLabels: STAGE_LABELS });
});

// ── Get single ticket (with resources) ────────────────────
async function getTicketResponse(id) {
  const t = db.getTicket(id);
  if (!t) return null;
  const stageResources = db.getStageResources(id);
  const latestTest = db.getLatestTestRun(id);
  const behindCount = getBranchStaleness(t.worktree_path);
  let pr_state = null;
  if (t.stage === 'pr_opened' || t.stage === 'done') {
    // Resolve PR URL: prefer ticket row, fall back to activity log
    let prUrl = t.pr_url;
    if (!prUrl) {
      const entry = (t.activity || []).find(a => a.action === 'pr_created' || a.action === 'pr_link');
      if (entry) prUrl = entry.detail;
    }
    if (prUrl) {
      const m = prUrl.match(/\/pull\/(\d+)/);
      if (m) {
        try {
          const { exec } = require('child_process');
          const stdout = await new Promise((res, rej) => {
            exec(`gh pr view ${m[1]} --json state`, { cwd: config.projectDir, timeout: 5000 },
              (err, out) => err ? rej(err) : res(out));
          });
          const parsed = JSON.parse(stdout);
          if (parsed?.state) {
            pr_state = parsed.state.toLowerCase();
            if (t.stage === 'pr_opened' && (pr_state === 'merged' || pr_state === 'closed')) {
              db.updateTicket(t.id, { stage: 'done' });
              db.logActivity(t.id, 'pr_' + pr_state, `PR ${m[1]} ${pr_state} — auto-transitioned to done`);
              await worktrees.release(t.id);
            }
          }
        } catch {}
      }
    }
  }
  const updated = pr_state ? db.getTicket(id) : t;
  return { ...updated, stage_resources: stageResources, latest_test: latestTest, behind_count: behindCount, pr_state };
}

app.get('/api/tickets/:id', async (req, res) => {
  const data = await getTicketResponse(req.params.id);
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
// Shared logic for both the HTTP endpoint and auto-trigger from PR checker.
async function runClarify(ticketId) {
  const ticket = db.getTicket(ticketId);
  if (!ticket || ticket.stage !== 'clarification' || ticket.status === 'running') return;

  const fbTitle1 = ticket.review_feedback?.match(/^PR #\d+/) ? 'PR issues' : 'Review feedback from previous implementation';
  const isPR = !!ticket.review_feedback?.match(/^PR #\d+/);
  const outPath = path.join(config.projectDir, '.jira-dashboard', 'tickets', ticket.id, 'clarification.json');
  try { fs.unlinkSync(outPath); } catch {} // clean slate for this round
  const contextSections = [
    { title: 'Ticket title', body: ticket.title },
    { title: 'Ticket description', body: ticket.content },
    ticket.review_feedback && { title: fbTitle1, body: ticket.review_feedback },
  ];
  if (ticket.branch_name) {
    contextSections.push({ title: 'Branch', body: ticket.branch_name });
  }
  if (ticket.pr_url) {
    contextSections.push({ title: 'PR URL', body: ticket.pr_url });
  }
  if (ticket.worktree_path) {
    contextSections.push({ title: 'Worktree path', body: ticket.worktree_path });
  }
  contextSections.push({ title: 'Output file', body: `Write your JSON output to: ${outPath}` });
  const contextFile = writeTicketContext(ticket.id, contextSections.filter(Boolean));

  const clarifyPrompt = isPR ? prompts.clarifyPR : prompts.clarify;
  const prompt = `${clarifyPrompt}\n\nRead full ticket context at: ${contextFile}\n\nWrite your JSON output to: ${outPath}`;

  db.logActivity(ticket.id, 'clarify_start');
  db.updateTicketField(ticket.id, 'status', 'running');
  if (!isPR) {
    db.updateTicketField(ticket.id, 'ocode_session', null);
  }

  // For PR-based tickets without a worktree, acquire one on the existing branch
  if (isPR && !ticket.worktree_path && ticket.branch_name) {
    try {
      const fresh = db.getTicket(ticket.id);
      const { worktreePath } = await worktrees.acquire(fresh);
      db.logActivity(ticket.id, 'worktree_reacquired', worktreePath);
    } catch (e) {
      db.logActivity(ticket.id, 'worktree_reacquire_failed', e.message);
    }
  }

  const ticket2 = db.getTicket(ticket.id);
  const cwd = ticket2?.worktree_path || config.projectDir;
    const onProgress = (line) => {
      if (line.startsWith('[resource] ')) {
        const detail = line.slice(11);
        db.logActivity(ticket.id, 'resource', detail, 'clarification');
        sseBroadcast(ticket.id, 'resource', { detail });
    } else {
      sseBroadcast(ticket.id, 'stdout', { text: line });
    }
  };
  const result = await runCoder(ticket.id, prompt, { timeout: config.coder.timeouts.clarify, onProgress, cwd });
  captureSessionId(ticket.id, result.sessionId);
  db.updateTicketField(ticket.id, 'status', 'idle');

  // Read the coder's structured output from the file, with text fallback
  let parsed;
  let fileContent = null;
  let fileParseError = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      fileContent = fs.readFileSync(outPath, 'utf-8');
      parsed = JSON.parse(fileContent);
      break;
    } catch (e1) {
      fileParseError = e1;
      if (attempt < 29) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  if (!parsed) {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) { try { parsed = JSON.parse(jsonMatch[0]); } catch {} }
  }
  try { fs.unlinkSync(outPath); } catch {}

  if (!parsed) {
    const snippet = (fileContent || result.text || '').slice(0, 500);
    throw new Error(
      `Coder did not write valid JSON output` +
      (fileParseError ? ` — ${fileParseError.message}` : '') +
      (fileContent ? `\nFile content (${fileContent.length} chars):\n${snippet}` : '') +
      (!fileContent ? `\nRaw output (${result.text?.length || 0} chars):\n${snippet}` : '')
    );
  }

  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(
      path.join(config.projectDir, '.jira-dashboard', 'clarification.schema.json'), 'utf-8'));
  } catch { /* skip validation if schema file not found */ }
  if (schema) {
    const ajv = new Ajv();
    if (!ajv.validate(schema, parsed)) {
      const output = fileContent || result.text || '(no output)';
      const snippet = output.length > 2000 ? output.slice(0, 2000) + '\n... (truncated)' : output;
      db.logActivity(ticket.id, 'clarify_error_detail', `Coder produced:\n${snippet}`);
      throw new Error(
        `Schema validation failed: ${ajv.errorsText()}\n\nRaw coder output:\n${snippet}`);
    }
  }

  const questions = parsed.questions || [];
  const notes = parsed.notes || '';

  if (parsed.ready && (!questions || questions.length === 0)) {
    const planText = formatPlanText(parsed.plan);
    db.deleteQuestionsForTicket(ticket.id);
    db.updateTicket(ticket.id, {
      plan: planText,
      estimated_complexity: parsed.estimated_complexity || null,
      plan_notes: notes || null,
      stage: 'implementation',
    });
    db.logActivity(ticket.id, 'clarified_skip', planText.slice(0, 200));
    if (parsed.files_to_modify) {
      db.logActivity(ticket.id, 'files_affected', parsed.files_to_modify.join(', '));
    }
    return { clarified: true, plan: planText, notes };
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
  return { clarified: false };
}

app.post('/api/tickets/:id/clarify', async (req, res) => {
  const ticket = db.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.stage !== 'clarification') return res.status(400).json({ error: `Ticket is in ${ticket.stage} stage` });
  if (ticket.status === 'running') return res.status(409).json({ error: 'Already processing, wait for completion' });

  try {
    const result = await runClarify(ticket.id);
    if (result?.clarified) {
      return res.json({ clarified: true, plan: result.plan, notes: result.notes, ticket: db.getTicket(ticket.id) });
    }
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

  const fbTitle2 = updatedTicket.review_feedback?.match(/^PR #\d+/) ? 'PR issues' : 'Previous review feedback';
  const contextFile = writeTicketContext(updatedTicket.id, [
    { title: 'Ticket title', body: updatedTicket.title },
    { title: 'Ticket description', body: updatedTicket.content },
    { title: 'Clarification Q&A', body: qaText },
    updatedTicket.review_feedback && { title: fbTitle2, body: updatedTicket.review_feedback },
  ].filter(Boolean));

  const prompt = `${prompts.evaluate}\n\nRead full ticket context at: ${contextFile}`;

  try {
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
    const result = await runCoder(ticket.id, prompt, { timeout: config.coder.timeouts.clarify, onProgress, cwd: config.projectDir });
    db.updateTicketField(ticket.id, 'status', 'idle');
    const output = result.text;

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

// ── PR tasks (non-code, gh CLI only) ─────────────────────
app.post('/api/tickets/:id/pr-tasks', async (req, res) => {
  const ticket = db.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.stage !== 'pr_opened') {
    return res.status(400).json({ error: `Ticket is in ${ticket.stage} stage` });
  }
  if (ticket.status === 'running') return res.status(409).json({ error: 'Already processing, wait for completion' });

  // Filter review_feedback: strip IGNORE checks (never shown) and REWORK checks
  // (handled by Path 2 auto-move).  Only Show-bucket items reach the coder.
  const ignorePatterns = (config.prCheckIgnore || []).map(p => new RegExp(p, 'i'));
  const reworkPatterns = (config.prReworkChecks || []).map(p => new RegExp(p, 'i'));
  const isFilteredLine = (line) => {
    if (!line.includes('—')) return false;
    for (const re of ignorePatterns) { if (re.test(line)) return true; }
    for (const re of reworkPatterns) { if (re.test(line)) return true; }
    return false;
  };
  const actionableLines = !ticket.review_feedback ? [] :
    ticket.review_feedback.split('\n').filter(l => !isFilteredLine(l));

  // Parse check lines into structured JSON
  const checkLineRe = /^\s*•\s+(.+?)\s*—\s+(.+?)(?:\s+\((.+?)\))?\s*$/;
  const checks = [];
  for (const line of actionableLines) {
    const m = line.match(checkLineRe);
    if (m) checks.push({ name: m[1].trim(), status: m[2].trim(), targetUrl: m[3] || null });
  }

  if (checks.length === 0) {
    // Trigger an immediate PR re-check so feedback is available shortly
    if (_recheckTicket) _recheckTicket(ticket.id);
    return res.status(400).json({ error: 'No actionable PR checks found. Triggered a re-check — try again in a few seconds.' });
  }

  // Write structured input for the coder
  const ticketDir = config.ticketContextDir(ticket.id);
  fs.mkdirSync(ticketDir, { recursive: true });
  const inputPath = path.join(ticketDir, 'pr-tasks-input.json');
  const inputData = {
    pr_url: ticket.pr_url,
    branch: ticket.branch_name,
    checks,
    ignored_checks: (config.prCheckIgnore || []).filter(Boolean),
  };
  fs.writeFileSync(inputPath, JSON.stringify(inputData, null, 2));

  // Use a file-based output contract (same pattern as clarification) so the
  // coder writes structured JSON to a known path rather than embedding it in
  // conversation text.
  const outPath = path.join(ticketDir, 'pr-rework.json');
  try { fs.unlinkSync(outPath); } catch {} // clean slate

  const contextFile = writeTicketContext(ticket.id, [
    { title: 'Ticket title', body: ticket.title },
    { title: 'Ticket description', body: ticket.content },
    { title: 'PR URL', body: ticket.pr_url || '(none)' },
    { title: 'Branch', body: ticket.branch_name || '(none)' },
    { title: 'PR checks to address', body: `See ${inputPath}` },
    { title: 'Output file', body: `Write your JSON output to: ${outPath}` },
  ].filter(Boolean));

  const inputSchemaPath = path.join(config.projectDir, '.jira-dashboard', 'pr-tasks-input.schema.json');
  const outputSchemaPath = path.join(config.projectDir, '.jira-dashboard', 'pr-rework.schema.json');

  // Parse PR URL to provide a ready-to-use GraphQL command for reading open review comments
  const prUrlMatch = (ticket.pr_url || '').match(/^https?:\/\/([^\/]+)\/([^\/]+)\/([^\/]+)\/pull\/(\d+)$/);
  const ghCmd = prUrlMatch
    ? `gh api graphql --hostname ${prUrlMatch[1]} -f query='query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewThreads(first:100){nodes{isResolved comments(first:100){nodes{databaseId body path line isMinimized}}}}}}}' -f o=${prUrlMatch[2]} -f n=${prUrlMatch[3]} -F p=${prUrlMatch[4]} --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false).comments.nodes[]'`
    : null;

  let prompt = `${prompts.prTasks}\n\nRead full ticket context at: ${contextFile}\n\nRead the PR checks to address from: ${inputPath}\nSchema: ${inputSchemaPath}\n\nWrite your JSON output to: ${outPath}\nSchema: ${outputSchemaPath}`;
  if (ghCmd) {
    prompt += `\n\nRead open review comments:\n${ghCmd}\n(databaseId → comment_id)`;
  }

  try {
    db.logActivity(ticket.id, 'pr_tasks_start');
    db.updateTicketField(ticket.id, 'status', 'running');
    // Start fresh — don't reuse prior session so --dangerously-skip-permissions applies
    db.updateTicketField(ticket.id, 'ocode_session', null);
    const onProgress = (line) => {
      if (line.startsWith('[resource] ')) {
        const detail = line.slice(11);
        db.logActivity(ticket.id, 'resource', detail, 'pr_opened');
        sseBroadcast(ticket.id, 'resource', { detail });
      } else if (line.trim()) {
        sseBroadcast(ticket.id, 'stdout', { text: line });
      }
    };
    const result = await runCoder(ticket.id, prompt, { timeout: config.coder.timeouts.clarify, onProgress, cwd: config.projectDir });

    // Track token usage from the coder run
    if (result?.tokens) {
      const t = db.getTicket(ticket.id);
      if (t) {
        const tokens = result.tokens;
        db.updateTicket(ticket.id, {
          token_cost: (parseFloat(t.token_cost) || 0) + (parseFloat(tokens.cost) || 0),
          token_input: String((parseInt(t.token_input) || 0) + (parseInt(tokens.input) || 0)),
          token_output: String((parseInt(t.token_output) || 0) + (parseInt(tokens.output) || 0)),
        });
      }
      db.logActivity(ticket.id, 'token_usage', JSON.stringify(result.tokens));
    }
    // Track resource usage from the last resource activity entry
    const finalTicket = db.getTicket(ticket.id);
    if (finalTicket) {
      const lastRes = (finalTicket.activity || []).find(a => a.action === 'resource');
      if (lastRes) {
        const p = Object.fromEntries(lastRes.detail.split(' ').map(s => s.split('=')));
        db.updateTicket(ticket.id, { total_cpu: p.cpu || '0', total_elapsed: p.elapsed || '0' });
      }
    }

    // ── Parse rework assessment from the output file ──────────
    let reworkList = [];
    let touchedList = [];
    let resolvedComments = [];
    let fileContent = null;
    try { fileContent = fs.readFileSync(outPath, 'utf-8'); } catch {}
    if (fileContent) {
      try {
        const parsed = JSON.parse(fileContent);
        if (Array.isArray(parsed.rework_checks)) reworkList = parsed.rework_checks.filter(Boolean);
        if (Array.isArray(parsed.touched_checks)) touchedList = parsed.touched_checks.filter(c => c && c.name);
        if (Array.isArray(parsed.resolved_comments)) resolvedComments = parsed.resolved_comments.filter(c => c && c.comment_id);
      } catch {}
    }
    try { fs.unlinkSync(outPath); } catch {}

    // If review comments were resolved without rework, ensure the check is reflected as touched
    if (resolvedComments.length > 0 && !touchedList.some(c => c.name === 'PR Review OPEN Comments')) {
      touchedList.push({ name: 'PR Review OPEN Comments', action: 'resolved', result: `Closed ${resolvedComments.length} review comment(s)` });
    }

    const touchedJson = touchedList.length > 0 ? JSON.stringify(touchedList) : null;

    if (reworkList.length > 0) {
      // Coder identified checks needing code rework → move to clarification
      const prNum = (ticket.pr_url || '').match(/\/pull\/(\d+)/)?.[1] || '?';
      const reasonText = reworkList.map(c => `  • ${c.name || c} — ${c.reason || ''}`).join('\n');
      const feedback = `PR #${prNum} — checks that need code changes:\n${reasonText}`;
      db.updateTicket(ticket.id, { status: 'idle', stage: 'clarification', plan: null, review_feedback: feedback, pr_rework_needed: 1, pr_touched_checks: touchedJson });
      db.logActivity(ticket.id, 'pr_tasks_rework', `Rework needed: ${reworkList.map(c => c.name || c).join(', ')}`);
      if (_runClarify) _runClarify(ticket.id);
    } else {
      db.updateTicket(ticket.id, { status: 'idle', pr_rework_needed: 0, pr_touched_checks: touchedJson });
      db.logActivity(ticket.id, 'pr_tasks_done', 'PR tasks addressed');
      if (_recheckTicket) _recheckTicket(ticket.id);
    }
    // Log each touched check for observability
    for (const tc of touchedList) {
      db.logActivity(ticket.id, 'pr_tasks_touched', `${tc.name} — ${tc.action}: ${tc.result}`);
    }
    // Log each resolved review comment for observability
    for (const rc of resolvedComments) {
      db.logActivity(ticket.id, 'pr_comment_resolved', `Comment #${rc.comment_id}: ${rc.reply || '(no reply)'}`);
    }
    const final = { ...db.getTicket(ticket.id), stage_resources: db.getStageResources(ticket.id) };
    sseBroadcast(ticket.id, 'ticket', final);
    res.json(final);
  } catch (err) {
    db.logActivity(ticket.id, 'pr_tasks_error', err.message);
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

  let worktreePath, branchName;
  let fileMonitor = null;

  try {
    // Set up (or reuse) the ticket's worktree. In pooled mode this claims a
    // free slot; a full pool surfaces as a clean 409 rather than an
    // implementation failure.
    try {
      ({ worktreePath, branchName } = await worktrees.acquire(ticket));
    } catch (err) {
      if (err.code === 'POOL_FULL') {
        db.updateTicketField(ticket.id, 'status', 'idle');
        return res.status(409).json({ error: err.message });
      }
      throw err; // real setup failure — fall through to the salvage handler
    }

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
      ticket.review_feedback && { title: ticket.review_feedback.match(/^PR #\d+/) ? 'PR issues' : 'Review feedback from previous implementation', body: ticket.review_feedback },
      testContext && { title: 'Most recent test run', body: testContext },
    ].filter(Boolean));

    const prompt = `${prompts.implement}\n\nRead full ticket context at: ${contextFile}\n\nYour current working directory (cwd) is: ${worktreePath}\nThis is a git worktree dedicated to this ticket. All file edits, reads, and git commands MUST use paths relative to this directory — never the main project checkout at ${config.projectDir}.`;

    db.logActivity(ticket.id, 'implement_start');
    db.updateTicketField(ticket.id, 'status', 'running');

    // File-change monitor
    const seenFiles = new Set();
    fileMonitor = setInterval(() => {
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

    const runResult = await runCoder(ticket.id, prompt, {
      timeout: config.coder.timeouts.implement,
      onProgress,
      cwd: worktreePath,
    });

    clearInterval(fileMonitor);

    // Ticket was closed while implementing — stop here, don't commit or
    // transition it back into 'review'.
    if (isClosed(ticket.id)) {
      return res.json({ closed: true, ticket: db.getTicket(ticket.id) });
    }

    const implResult = await finishImplement(ticket.id, worktreePath, runResult.tokens, onProgress);

    res.json({
      ...implResult,
      worktree_path: worktreePath, branch_name: branchName,
      output_summary: runResult.text.slice(-1000),
      ticket: db.getTicket(ticket.id),
    });
  } catch (err) {
    clearInterval(fileMonitor);
    // Killed because the ticket was closed mid-run — its worktree is already
    // released and the stage is terminal. Don't salvage-commit or reopen it.
    if (isClosed(ticket.id)) {
      return res.json({ closed: true, ticket: db.getTicket(ticket.id) });
    }
    const t2 = db.getTicket(ticket.id);
    if (t2) {
      const lastRes = (t2.activity || []).find(a => a.action === 'resource');
      if (lastRes) {
        const p = Object.fromEntries(lastRes.detail.split(' ').map(s => s.split('=')));
        db.updateTicket(ticket.id, { total_cpu: p.cpu || '0', total_elapsed: p.elapsed || '0' });
      }
      // Only attempt a salvage commit if we actually got a worktree. If setup
      // failed before one was assigned, `worktreePath` is undefined and running
      // git with a null cwd would operate on the main checkout — never do that.
      const partialSha = worktrees.isValidWorktree(worktreePath)
        ? commitWorktreeChanges(worktreePath, ticket.id,
            `${ticket.id}: partial (error: ${err.message.slice(0, 80).replace(/"/g, '')})`, { partial: true })
        : null;
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
  if (ticket.stage !== 'review' && ticket.stage !== 'pr_opened') return res.status(400).json({ error: `Ticket is in ${ticket.stage} stage` });

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
  if (!['clarification', 'ready', 'review'].includes(ticket.stage)) return res.status(400).json({ error: `Ticket is in ${ticket.stage} stage` });
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

    // Rebase onto the CURRENT upstream tip (origin/<default>), not the stale
    // local ref. Pool worktrees never fetch on their own, so the local
    // default-branch ref drifts behind origin; freshDefaultBase fetches and
    // resolves origin/<default> (falling back to the local ref when there's no
    // remote). This mirrors how new worktrees are based off the fresh tip.
    const rebaseBase = worktrees.freshDefaultBase(ticket.worktree_path);

    // Attempt the rebase
    try {
      runGit(`rebase ${rebaseBase}`, ticket.worktree_path);
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

      // Build context file with conflict details for the coder
      const conflictDetails = [
        `Default branch: ${config.branchDefault}`,
        `Worktree: ${ticket.worktree_path}`,
        `Conflicted files:\n${conflictFiles.join('\n') || '(unknown)'}`,
        '',
        'Git status:',
        '```',
        gitStatus || '(unavailable)',
        '```',
      ];
      const ctxSections = [
        { title: 'Ticket title', body: ticket.title },
        { title: 'Ticket content', body: ticket.content },
        { title: 'Rebase conflict details', body: conflictDetails.join('\n') },
      ];
      const contextFile = writeTicketContext(ticket.id, ctxSections);
      const resolvePrompt = `${prompts.resolveConflictAuto}\n\nWorktree: ${ticket.worktree_path}\nRead full ticket context at: ${contextFile}`;

      db.updateTicketField(ticket.id, 'status', 'running');
      try {
        const resolveResult = await runCoder(ticket.id, resolvePrompt, {
          timeout: config.coder.timeouts.implement,
          onProgress: (line) => {
            if (line.startsWith('[resource] ')) {
              const detail = line.slice(11);
              db.logActivity(ticket.id, 'resource', detail, 'review');
              sseBroadcast(ticket.id, 'resource', { detail });
            } else {
              db.logActivity(ticket.id, 'rebase_coder_progress', line.slice(0, 200));
              sseBroadcast(ticket.id, 'stdout', { text: line });
            }
          },
          cwd: ticket.worktree_path,
        });
        const resolveOutput = resolveResult.text;

        // Check if conflicts remain
        let remainingConflicts = [];
        try {
          remainingConflicts = runGit(`diff --name-only --diff-filter=U`, ticket.worktree_path)
            .split('\n').map(s => s.trim()).filter(Boolean);
        } catch {}

        let coderResolved = false;
        try {
          const coderResult = JSON.parse(resolveOutput);
          coderResolved = coderResult.resolved === true;
        } catch { /* fall back to string check */ }
        if (!coderResolved) coderResolved = remainingConflicts.length === 0 && !resolveOutput.includes('UNRESOLVABLE');
        if (remainingConflicts.length === 0 && coderResolved) {
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
        db.updateTicket(ticket.id, { stage: 'clarification', review_feedback: feedbackText, plan: null, status: 'idle' });
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
        db.updateTicket(ticket.id, { stage: 'clarification', review_feedback: feedbackText, plan: null, status: 'idle' });

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
app.post('/api/tickets/:id/ready', async (req, res) => {
  let ticket = db.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.stage !== 'review') return res.status(400).json({ error: `Ticket is in ${ticket.stage} stage` });
  if (ticket.status === 'running') return res.status(409).json({ error: 'Already processing, wait for completion' });

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
    // PR strategy only commits new worktree changes — pre-existing branch
    // commits (from a prior run) are already on the branch and don't need
    // a new commit.  Non-PR strategies need the branch-ahead check so the
    // subsequent rebase/cherry-pick has something to apply.
    if (!hasChanges && config.mergeStrategy !== 'pr') {
      try {
        const ahead = parseInt(runGit(`rev-list --count origin/${config.branchDefault}..${ticket.branch_name}`, ticket.worktree_path), 10) || 0;
        if (ahead > 0) hasChanges = true;
      } catch {}
    }

    if (!hasChanges && config.mergeStrategy !== 'pr') {
      const msg = `No uncommitted changes and no commits ahead of ${config.branchDefault} on this branch.`;
      db.logActivity(ticket.id, 'no_changes', msg);
      return res.status(409).json({ error: msg, ticket: db.getTicket(ticket.id) });
    }

    // PR strategy: no new commit needed if worktree is clean — the coder's
    // commits are already on the branch. Just push and create/update the PR.
    if (config.mergeStrategy === 'pr' && !hasChanges) {
      commitSha = runGit(`rev-parse HEAD`, ticket.worktree_path);
    } else {
      const commitMsg = `${ticket.id}: ${ticket.title}`;
      runGit(`add -A`, ticket.worktree_path);

      // PR strategy preserves branch history. Other strategies squash into
      // a single commit for clean cherry-pick / merge.
      if (config.mergeStrategy !== 'pr') {
        const baseSha = ticket.base_sha;
        if (baseSha) {
          try {
            runGit(`reset --soft ${baseSha}`, ticket.worktree_path);
            db.logActivity(ticket.id, 'squashed', `All commits squashed to base ${baseSha.slice(0, 7)}`);
          } catch {
            db.logActivity(ticket.id, 'squash_skipped', 'Could not reset to recorded base, committing as-is');
          }
        } else {
          db.logActivity(ticket.id, 'squash_skipped', 'No base_sha recorded — committing as-is');
        }
      }

      runGit(`commit -m "${escShell(commitMsg)}"`, ticket.worktree_path);
      commitSha = runGit(`rev-parse HEAD`, ticket.worktree_path);
      db.logActivity(ticket.id, 'committed', commitSha);
      assertWorktreeClean(ticket, { stage: 'cherry-pick' });
    }

    if (config.mergeStrategy === 'pr') {
      // Push + PR creation runs in the background — a slow local pre-push hook
      // (or network round-trip) must not block and time out this request. The
      // commit is already squashed onto the branch; the ticket stays in
      // `review` with status `running` until the background task advances it to
      // `done` on success (or drops it back to idle on failure, preserving the
      // commit so the user can retry `ready`).
      db.updateTicket(ticket.id, { commit_sha: commitSha, status: 'running' });
      db.logActivity(ticket.id, 'pushing', `Pushing ${ticket.branch_name} and opening PR in the background…`);
      pushAndOpenPr(ticket.id, ticket.branch_name, `${ticket.id}: ${ticket.title}`, ticket.worktree_path);
      return res.json({ success: true, pending: true, commit_sha: commitSha, ticket: db.getTicket(ticket.id) });
    } else {
      try {
        runGit(`rebase ${config.branchDefault}`, ticket.worktree_path);
        commitSha = runGit(`rev-parse HEAD`, ticket.worktree_path);
        // Move the default-branch ref to the rebased commit via plumbing.
        // `git update-ref` is a metadata operation: it rewrites the branch
        // pointer without touching the main checkout's working tree — no
        // checkout, no merge, no risk of clobbering the user's uncommitted
        // local changes. If those changes ever need to be reconciled with
        // the new branch state, that's a regular git reset/merge the user
        // can do in their own time.
        runGit(`update-ref refs/heads/${config.branchDefault} ${commitSha}`);
      } catch (err) {
        db.logActivity(ticket.id, 'rebase_failed', err.message);
        try { runGit(`rebase --abort`, ticket.worktree_path); } catch {}
        // Report rebase conflicts directly from the worktree (no main-checkout
        // involvement). The user can resolve them in their worktree.
        let conflictFiles = [];
        let gitStatus = '';
        try {
          conflictFiles = runGit(`diff --name-only --diff-filter=U`, ticket.worktree_path)
            .split('\n').map(s => s.trim()).filter(Boolean);
          gitStatus = runGit(`status --short`, ticket.worktree_path);
        } catch {}
        const errorDetail = err.message ? err.message.slice(0, 300) : '';
        const fileList = conflictFiles.length > 0
          ? '\nConflicting files (in worktree):\n' + conflictFiles.map(f => '  • ' + f).join('\n')
          : '';
        const gitHint = conflictFiles.length === 0 && errorDetail
          ? `\nGit error: ${errorDetail}`
          : '';
        return res.status(409).json({
          error: `Rebase failed against ${config.branchDefault}.${fileList}${gitHint}\nResolve in worktree ${ticket.worktree_path}, then retry.`,
          ticket: db.getTicket(ticket.id)
        });
      }
      db.logActivity(ticket.id, 'cherry_picked', commitSha);
    }

    db.updateTicket(ticket.id, { stage: 'done', commit_sha: commitSha });
    await worktrees.release(ticket.id);

    res.json({ success: true, commit_sha: commitSha, ticket: db.getTicket(ticket.id) });
  } catch (err) {
    const tail = commitSha
      ? ` Squashed commit ${commitSha.slice(0, 7)} is still on branch ${ticket.branch_name} in the worktree.`
      : '';
    db.logActivity(ticket.id, 'ready_error', `${err.message}${tail} Worktree preserved — ticket stays in review.`);
    res.status(500).json({ error: err.message, ticket: db.getTicket(ticket.id) });
  }
});

// ── Close ticket ──────────────────────────────────────────
// Terminal action available in ANY stage — including while a stage is
// running. Kills the active coder process (if any), releases the worktree /
// pool slot and branch, then moves the ticket to the terminal 'done' stage.
// An already-closed ticket cannot be closed again.
app.post('/api/tickets/:id/close', async (req, res) => {
  const ticket = db.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.stage === 'done') {
    return res.status(400).json({ error: 'Ticket is already done' });
  }

  // 1. Stop any in-flight coder process for this ticket.
  const killed = killTicketProcess(ticket.id);

  // 2. Mark terminal BEFORE releasing the worktree. A handler whose coder
  //    process we just killed will resume in its catch block; seeing the
  //    closed stage (via isClosed) it bails instead of reopening the ticket.
  db.updateTicket(ticket.id, { stage: 'done', status: 'idle', commit_sha: null });

  // 3. Release the worktree / pool slot and branch (safe when there is none).
  await worktrees.release(ticket.id);

  db.logActivity(ticket.id, 'closed', killed ? 'closed (running process killed)' : 'closed');
  const updated = db.getTicket(ticket.id);
  sseBroadcast(ticket.id, 'ticket', updated);
  res.json({ success: true, ticket: updated });
});

// ── Delete ticket ─────────────────────────────────────────
app.delete('/api/tickets/:id', async (req, res) => {
  const ticket = db.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  // Stop any in-flight work (coder run or background push) before touching the
  // worktree, so we don't remove a path a `git push`/`gh` child is still using.
  killTicketProcess(ticket.id);

  // Return a pooled slot to the pool, or remove a per-ticket worktree.
  await worktrees.release(ticket.id);

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
    const base = resolveDiffBase(ticket.worktree_path);
    let diff = runGit(`log ${base}..HEAD --oneline --stat`, ticket.worktree_path);
    let files = [];
    if (!diff) {
      // No commits ahead of default branch — changes may have been
      // incorporated via cherry-pick/merge. Show diff from merge-base.
      diff = runGit(`diff ${base}...HEAD --stat`, ticket.worktree_path);
      if (diff) {
        try {
          const nameOnly = runGit(`log ${base}...HEAD --name-only --format=""`, ticket.worktree_path);
          files = [...new Set(nameOnly.split('\n').map(s => s.trim()).filter(Boolean))];
        } catch {}
        diff = `(commits already in ${config.branchDefault} — showing diff from merge-base)\n${diff}`;
      } else {
        return res.status(400).json({ error: `No diff available — worktree has no changes ahead of ${config.branchDefault}`, files: [], explorer_prefix: null });
      }
    } else {
      try {
        const nameOnly = runGit(`log ${base}..HEAD --name-only --format=""`, ticket.worktree_path);
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

  const out = fs.createWriteStream(outFile);
  let proc;
  if (config.test.commandOverride) {
    proc = spawn('bash', ['-lc', config.test.commandOverride], {
      cwd: config.projectDir,
      timeout: config.test.timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    const py = config.venvPython();
    const testModule = `${config.projectName}.test`;
    proc = spawn(py, ['-m', testModule], {
      cwd: config.projectDir,
      env: { ...process.env, PYTHONPATH: path.join(config.projectDir, config.venv.pythonpath) },
      timeout: config.test.timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
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

app.post('/api/restart', (req, res) => {
  res.json({ ok: true });
  // Respond first, then restart — process.exit will kill this process
  setTimeout(() => {
    const { execSync } = require('child_process');
    try { execSync(`systemctl --user restart jira-dashboard-${config.port}`, { timeout: 5000 }); } catch {}
  }, 100);
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
      const visionSection = vision.trim()
        ? vision
        : `_No vision document found at ${visionPath}. Infer the project's direction by exploring the codebase in the project root above._`;

      const sugDir = path.join(config.ticketContextDir(SUGGESTIONS_TICKET_ID));
      fs.mkdirSync(sugDir, { recursive: true });
      const contextFile = path.join(sugDir, 'context.md');
      fs.writeFileSync(contextFile,
        `# Suggestion generation context\n\n_Generated ${new Date().toISOString()}._\n\n` +
        `## Project root\n\n\`\`\`\n${config.projectDir}\n\`\`\`\n\n` +
        `## Project vision (${visionPath})\n\n${visionSection}\n`
      );

      const fullPrompt = `${prompts.suggest}\n\nSuggest ${SUGGESTIONS_MAX} tickets.\n\nExplore the codebase in the project root, then read the context file at: ${contextFile}`;
      const result = await runCoder(SUGGESTIONS_TICKET_ID, fullPrompt, { timeout: config.coder.timeouts.suggest, cwd: config.projectDir });
      const output = result.text;
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

app.get('/api/system/checks', (req, res) => res.json(_systemChecks));

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
(async function recoverStuckTickets() {
  const ids = db.getTicketIds();
  let changed = false;
  for (const tid of ids) {
    const t = db.getTicket(tid);
    if (t && t.status === 'running') {
      // A background push (pushAndOpenPr) is a fire-and-forget child, not a
      // coder session — nothing survives a restart, so a ticket left mid-push
      // must be recovered here; the session-liveness heuristic below doesn't
      // apply (it may have a stale ocode_session from an earlier stage that
      // still lists as "alive", which would leave the ticket stuck `running`
      // and blocking /ready with a 409 forever). We recover based on how far
      // the push lifecycle got, tracked by the latest activity marker:
      //   pushing                   → branch push never confirmed (else the
      //                               next marker would be logged). Reset to
      //                               idle so the user can retry (re-squash +
      //                               push) — nothing is on origin yet.
      //   branch_pushed             → branch IS on origin; re-pushing would be
      //   pr_created / pr_link        a non-fast-forward. Only PR creation
      //                               and/or the final `done` transition were
      //                               lost, both of which we finish here
      //                               WITHOUT touching git history.
      const latest = (t.activity || [])[0]?.action;
      if (latest === 'pushing') {
        db.updateTicketField(tid, 'status', 'idle');
        db.logActivity(tid, 'recovered', 'Server restarted mid-push — reset to idle; press Ready to push again.');
        changed = true;
        console.log(`Recovered: ${tid} reset to idle (interrupted push)`);
        continue;
      }
      if (latest === 'branch_pushed' || latest === 'pr_created' || latest === 'pr_link') {
        // Branch already landed on origin — do NOT re-push. If PR creation was
        // the interrupted step (latest is branch_pushed), leave a fallback
        // "open PR" link so the user can create it manually, then finalize.
        if (latest === 'branch_pushed') {
          try {
            const remoteUrl = runGit(`config --get remote.origin.url`, t.worktree_path);
            const repoPath = remoteUrl.replace(/\.git$/, '').replace(/^.*[:/]/, '');
            db.logActivity(tid, 'pr_link', `https://github.com/${repoPath}/pull/new/${t.branch_name}`);
          } catch {}
        }
        db.updateTicket(tid, { stage: 'done', status: 'idle' });
        await worktrees.release(tid);
        db.logActivity(tid, 'recovered', 'Server restarted after branch push — finalized to done (branch already on origin).');
        changed = true;
        console.log(`Recovered: ${tid} finalized to done (push completed before restart)`);
        continue;
      }

      // Tickets running a coder session: kill orphaned process (if any)
      // by saved PGID, then re-attach to the managed session so the coder
      // picks up where it left off with full conversation context.
      killTicketProcess(tid, t.coder_pgid, t.ocode_session);
      db.updateTicketField(tid, 'coder_pgid', null);

      if (t.ocode_session && t.stage === 'implementation') {
        db.logActivity(tid, 'recovered', `Server restarted — re-attaching to session ${t.ocode_session}`);
        changed = true;
        console.log(`Recovered: ${tid} re-attaching to session ${t.ocode_session}`);
        const recCwd = t.worktree_path || config.projectDir;
        (async () => {
          try {
            const prompt = 'The server was restarted while you were implementing this ticket. '
              + 'Your session is preserved and the worktree has your existing changes. '
              + 'Review the current state of the worktree and continue implementing where you left off. '
              + 'Do NOT start over — resume from the current worktree state. '
              + 'Commit when done.';
            const recoveryResult = await runCoder(tid, prompt, {
              timeout: config.coder.timeouts.implement,
              cwd: recCwd,
              onProgress: line => {
                if (line.startsWith('[resource] ')) {
                  db.logActivity(tid, 'resource', line.slice(11), 'implementation');
                  sseBroadcast(tid, 'resource', { detail: line.slice(11) });
                } else if (line.trim()) {
                  sseBroadcast(tid, 'stdout', { text: line });
                }
              },
            });
            if (t.worktree_path && db.getTicket(tid)?.stage !== 'done') {
              await finishImplement(tid, t.worktree_path, recoveryResult.tokens);
            }
          } catch (err) {
            db.logActivity(tid, 'recover_error', `Re-attach failed: ${err.message}`);
            db.updateTicketField(tid, 'status', 'idle');
            console.log(`Recovered: ${tid} re-attach failed — reset to idle`);
          }
        })();
      } else {
        const reason = t.ocode_session
          ? `session exists but stage is ${t.stage} — not resumable`
          : 'no session to resume';
        db.updateTicketField(tid, 'status', 'idle');
        db.logActivity(tid, 'recovered', `Server restarted — ${reason}, reset to idle`);
        changed = true;
        console.log(`Recovered: ${tid} reset to idle (${reason})`);
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
  _systemChecks = runMachineChecks(config);
  for (const c of _systemChecks) {
    if (c.status !== 'ok') console.log(`[machine-check] ${c.status}: ${c.name} — ${c.detail}`);
  }
  if (suggestions.length < SUGGESTIONS_MAX) generateSuggestions();

  // Periodic PR checker — scans pr_opened tickets for new failures/reviews
  _runClarify = (tid) => { try { runClarify(tid); } catch {} };
  const prChecker = startPrChecker(db, config, sseBroadcast, _runClarify);
  _recheckTicket = prChecker.recheckTicket;
  _startWatchingPr = prChecker.startWatching;
});
