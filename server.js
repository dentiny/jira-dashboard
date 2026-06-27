const express = require('express');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');

const PORT = process.env.PORT || 3006;
const PYXEN_DIR = '/home/cutuy/.openclaw/workspace/pyxen';
const OPENCODE_BIN = '/home/cutuy/.opencode/bin/opencode';
const WORKTREES_DIR = '/home/cutuy/.openclaw/workspace/pyxen/.worktrees';
const DATA_DIR = path.join(__dirname, 'data');

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

function runOpenCode(ticketId, prompt, onProgress, stage = null) {
  return new Promise((resolve, reject) => {
    const venvBin = path.join(PYXEN_DIR, '.venv', 'bin');
    const pyxenEnv = loadPyxenEnv();
    const env = {
      ...process.env,
      ...pyxenEnv,
      HOME: process.env.HOME,
      PATH: `${venvBin}:${process.env.PATH}`,
      VIRTUAL_ENV: path.join(PYXEN_DIR, '.venv'),
    };
    const proc = spawn(OPENCODE_BIN, ['run', prompt], {
      cwd: PYXEN_DIR,
      env,
      timeout: 600_000,
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
        const memMB = (rss * 4096 / (1024 * 1024)).toFixed(1);
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

        const resStr = `cpu=${cpuSec}s mem=${memMB}MB threads=${threads} elapsed=${elapsed}s ncores=${ncores}${tokensStr}`;
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

      // Compute per-stage delta summary
      const tokensAfter = getOpencodeTokens();
      let deltaCpu = '0', deltaElapsed = '0', deltaPeakMem = peakMem.toFixed(0);
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

      if (!killed) {
        if (code === 0) {
          if (!stdout.trim() && stderr.trim()) {
            reject(new Error(`OpenCode produced no output: ${stderr.slice(-500)}`));
          } else {
            resolve(stdout.trim());
          }
        } else {
          reject(new Error(`OpenCode exited ${code}: ${stderr.slice(-500)}`));
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

function ensureWorktreesDir() {
  if (!fs.existsSync(WORKTREES_DIR)) fs.mkdirSync(WORKTREES_DIR, { recursive: true });
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
  res.json({ ...t, stage_resources: stageResources });
});

// ── Create ticket ─────────────────────────────────────────
app.post('/api/tickets', (req, res) => {
  const { title, content } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title required' });

  const id = uid();
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

  let extraContext = '';
  if (ticket.review_feedback) {
    extraContext = `\n\nReview feedback from previous implementation:\n${ticket.review_feedback}`;
  }

  const prompt = `A ticket has been filed for the pyxen project at ${PYXEN_DIR}.

Title: ${ticket.title}
Content: ${ticket.content}${extraContext}

Your job:
1. Ask clarifying questions about what exactly needs to be done. Ask as many as you genuinely need — no fixed minimum or maximum.
2. For each question, decide the best answer format:
   - free_text: the user types a free-form answer in a textbox
   - multiple_choice: the user picks one option from a predefined list (2-5 options)
3. Format your response as a JSON object:

{
  "questions": [
    {
      "question": "What approach should we use?",
      "type": "multiple_choice",
      "options": ["Approach A", "Approach B", "Approach C"]
    },
    {
      "question": "Any additional details?",
      "type": "free_text"
    }
  ],
  "notes": "Optional context notes"
}

Rules:
- Each question object MUST have "question" and "type" fields.
- For "multiple_choice", include an "options" array with 2-5 strings.
- For "free_text", do NOT include an "options" field.

IMPORTANT: Output ONLY the JSON object, no other text.`;

  try {
    db.logActivity(ticket.id, 'clarify_start');
    db.updateTicketField(ticket.id, 'status', 'running');
    const output = await runOpenCode(ticket.id, prompt, undefined, 'clarification');
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

  let extraContext = '';
  if (updatedTicket.review_feedback) {
    extraContext = `\n\nPrevious review feedback: ${updatedTicket.review_feedback}`;
  }

  const prompt = `You are helping plan work on the pyxen codebase at ${PYXEN_DIR}.

Ticket: ${updatedTicket.title}
Content: ${updatedTicket.content}${extraContext}

Clarification Q&A so far:
${qaText}

Your job:
1. Evaluate if you have enough information to create an implementation plan
2. If you NEED MORE CLARIFICATION, respond with JSON:
{
  "need_more": true,
  "questions": [
    {
      "question": "Follow-up question?",
      "type": "free_text"
    },
    {
      "question": "Another question?",
      "type": "multiple_choice",
      "options": ["Option A", "Option B"]
    }
  ],
  "notes": "Why I need more info"
}
3. If you HAVE ENOUGH INFO, respond with JSON: {"need_more": false, "plan": "Detailed high-level implementation plan here...", "files_to_modify": ["file1.py", "file2.py"], "estimated_complexity": "low|medium|high", "notes": "Any assumptions made"}

Rules for questions:
- Each question object MUST have "question" and "type" fields.
- For "multiple_choice", include an "options" array with 2-5 strings.
- For "free_text", do NOT include an "options" field.
- Ask as many questions as genuinely needed.

IMPORTANT: Output ONLY the JSON object, no other text.`;

  try {
    db.logActivity(ticket.id, 'answer_process');
    db.updateTicketField(ticket.id, 'status', 'running');
    const output = await runOpenCode(ticket.id, prompt, undefined, 'clarification');
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

  // If coming from review (continue), move back to implementation
  if (ticket.stage === 'review') {
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

    const prompt = `You are implementing changes for a ticket in the pyxen project. Work in the directory: ${worktreePath}

Ticket: ${ticket.title}
Content: ${ticket.content}

Clarification Q&A:
${qaText}

Implementation Plan:
${ticket.plan}

Your job:
1. Read the relevant source files to understand the current code
2. Implement the changes described in the plan
3. Write clean, well-tested, maintainable code
4. Make sure all existing tests still pass
5. Update any relevant documentation
6. Commit logical groups of changes with clear messages as you go — ALWAYS commit your work

Work in: ${worktreePath}`;

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

    const output = await runOpenCode(ticket.id, prompt, undefined, 'implementation');

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

    let diffSummary = '';
    try { diffSummary = runGit(`diff --stat`, worktreePath); } catch { diffSummary = '(no diff)'; }

    // Save cumulative CPU/elapsed from last resource entry
    const t2 = db.getTicket(ticket.id);
    if (!t2) return res.status(500).json({ error: 'Ticket data lost' });
    const lastRes = (t2.activity || []).find(a => a.action === 'resource');
    if (lastRes) {
      const p = Object.fromEntries(lastRes.detail.split(' ').map(s => s.split('=')));
      db.updateTicket(ticket.id, {
        total_cpu: p.cpu || '0',
        total_elapsed: p.elapsed || '0',
        stage: 'review',
        status: 'idle'
      });
    } else {
      db.updateTicket(ticket.id, { stage: 'review', status: 'idle' });
    }
    db.logActivity(ticket.id, 'implement_done', diffSummary.slice(0, 500));

    res.json({
      success: true, worktree_path: worktreePath, branch_name: branchName,
      diff_summary: diffSummary, output_summary: output.slice(-1000),
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
      try { runGit(`add -A`, worktreePath); } catch {}
      try { runGit(`commit -m "${ticket.id}: partial (error: ${err.message.slice(0, 80).replace(/"/g, '')})"`, worktreePath); } catch {}
      db.logActivity(ticket.id, 'implement_error', err.message);
      db.updateTicket(ticket.id, { stage: 'review', status: 'idle' });
      res.json({ error: err.message, note: 'Changes auto-committed. Choose: continue (restart implementation) or review and cherry-pick.' });
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
    try {
      runGit(`checkout ${ticket.branch_name}`);
      runGit(`rebase main`);
      runGit(`checkout main`);
    } catch (err) {
      db.logActivity(ticket.id, 'rebase_failed', err.message);
      try { runGit(`rebase --abort`); } catch {}
      runGit(`checkout main`).catch(() => {});
      // Rebase failed — still try the cherry-pick (some bases are
      // already in main), but if it also fails the outer catch
      // will hold the worktree intact.
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
app.get('/api/tickets/:id/diff', (req, res) => {
  const ticket = db.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (!ticket.worktree_path || !fs.existsSync(ticket.worktree_path)) {
    return res.json({ diff: '(no worktree available)' });
  }
  try {
    const diff = runGit(`log main..HEAD --oneline --stat`, ticket.worktree_path);
    res.json({ diff: diff || '(no changes)' });
  } catch (err) {
    res.json({ diff: `Error: ${err.message}` });
  }
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
  const proc = spawn(python, ['-m', 'pyxen.test'], { cwd: PYXEN_DIR, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const proc = spawn('bash', [hookPath], { cwd: PYXEN_DIR, timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.pipe(out);
  proc.stderr.pipe(out);
  proc.on('close', code => { runResults[runId].status = code === 0 ? 'pass' : 'fail'; });
  proc.on('error', err => { fs.appendFileSync(outFile, '\nError: ' + err.message); runResults[runId].status = 'fail'; });
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
});
