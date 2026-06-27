const express = require('express');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3006;
const PYXEN_DIR = '/home/cutuy/.openclaw/workspace/pyxen';
const OPENCODE_BIN = '/home/cutuy/.opencode/bin/opencode';
const WORKTREES_DIR = '/home/cutuy/.openclaw/workspace/pyxen/.worktrees';
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');

// ── JSON File Store ───────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch {
    return { tickets: {}, nextQId: 1 };
  }
}

function saveStore(store) {
  fs.writeFileSync(DB_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

// ── Helpers ───────────────────────────────────────────────
const STAGE_LABELS = {
  clarification: 'Clarification',
  implementation: 'Implementation',
  review: 'Review',
  ready: 'Ready',
  done: 'Done'
};

function uid() {
  return Date.now().toString(36).toUpperCase();
}

function getTicket(store, id) {
  const t = store.tickets[id];
  if (!t) return null;
  if (!t.activity) t.activity = [];
  return t;
}

function logActivity(store, ticketId, action, detail = '') {
  const t = store.tickets[ticketId];
  if (!t) return;
  if (!t.activity) t.activity = [];
  t.activity.unshift({ action, detail, time: new Date().toISOString() });
  // Keep last 50
  if (t.activity.length > 500) t.activity = t.activity.slice(0, 500);
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

function runOpenCode(ticketId, prompt, onProgress) {
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

    // Resource monitor — tracks CPU seconds, memory, token usage
    const startTime = Date.now();
    const clkTck = 100;
    const ncores = parseInt(fs.readFileSync('/proc/cpuinfo', 'utf-8').match(/processor/g)?.length) || 4;
    // Accumulate across runs for this ticket
    let baseCpu = 0, baseElapsed = 0;
    try {
      const s = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
      const t = s.tickets[ticketId];
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
        const elapsed = baseElapsed + Math.round((Date.now() - startTime) / 1000);

        // Token usage via opencode stats for this project
        let tokens = '';
        try {
          const statsOut = execSync(`${OPENCODE_BIN} stats --project ''`, { encoding: 'utf-8', timeout: 3000, stdio: 'pipe', cwd: PYXEN_DIR });
          const inp = (statsOut.match(/Input\s+([\d,.]+[KMB]?)/) || [])[1];
          const out = (statsOut.match(/Output\s+([\d,.]+[KMB]?)/) || [])[1];
          const cost = (statsOut.match(/Total Cost\s+\$?([\d.]+)/) || [])[1];
          if (inp) tokens = ` tokens_in=${inp} tokens_out=${out} cost=$${cost}`;
        } catch {}

        const resStr = `cpu=${cpuSec}s mem=${memMB}MB threads=${threads} elapsed=${elapsed}s ncores=${ncores}${tokens}`;
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

    proc.on('close', code => {
      clearInterval(resMonitor);
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

// SPA fallback — serve index.html for all non-API routes
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public-spa', 'index.html'));
});

// List all tickets
app.get('/api/tickets', (req, res) => {
  const store = loadStore();
  const tickets = Object.values(store.tickets)
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  res.json({
    tickets,
    stages: ['clarification', 'implementation', 'review', 'ready', 'done'],
    stageLabels: STAGE_LABELS
  });
});

// Get single ticket
app.get('/api/tickets/:id', (req, res) => {
  const store = loadStore();
  const t = getTicket(store, req.params.id);
  if (!t) return res.status(404).json({ error: 'Ticket not found' });
  res.json(t);
});

// Create ticket
app.post('/api/tickets', (req, res) => {
  const { title, content } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title required' });

  const store = loadStore();
  const id = uid();
  const now = new Date().toISOString();
  store.tickets[id] = {
    id, title: title.trim(), content: (content || '').trim(),
    stage: 'clarification', plan: null,
    worktree_path: null, branch_name: null, commit_sha: null, review_feedback: null,
    questions: [], activity: [],
    created_at: now, updated_at: now
  };
  logActivity(store, id, 'created', title.trim());
  saveStore(store);

  res.status(201).json(store.tickets[id]);
});

// ── Stage 1: Clarification ────────────────────────────────
app.post('/api/tickets/:id/clarify', async (req, res) => {
  const store = loadStore();
  const ticket = getTicket(store, req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.stage !== 'clarification') return res.status(400).json({ error: `Ticket is in ${ticket.stage} stage` });

  // Reset questions for fresh start
  ticket.questions = [];

  let extraContext = '';
  if (ticket.review_feedback) {
    extraContext = `\n\nReview feedback from previous implementation:\n${ticket.review_feedback}`;
  }

  const prompt = `A ticket has been filed for the pyxen project at ${PYXEN_DIR}.

Title: ${ticket.title}
Content: ${ticket.content}${extraContext}

Your job:
1. Ask clarifying questions about what exactly needs to be done. Ask 3-5 focused questions.
2. Format your response as a JSON object with a "questions" array. Each question should be a string.
   Example: {"questions": ["Question 1?", "Question 2?"], "notes": "Optional context notes"}

IMPORTANT: Output ONLY the JSON object, no other text.`;

  try {
    logActivity(store, ticket.id, 'clarify_start');
    ticket.status = 'running';
    ticket.updated_at = new Date().toISOString();
    saveStore(store);
    const output = await runOpenCode(ticket.id, prompt);
    ticket.status = 'idle';

    let parsed;
    try {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { questions: [output] };
    } catch {
      parsed = { questions: [output], notes: 'Could not parse structured output' };
    }

    const questions = parsed.questions || [];
    const notes = parsed.notes || '';

    for (const q of questions) {
      ticket.questions.push({ id: store.nextQId++, question: q, answer: null, round: 1 });
    }
    if (notes) logActivity(store, ticket.id, 'clarify_notes', notes);

    ticket.updated_at = new Date().toISOString();
    saveStore(store);
    res.json(ticket);
  } catch (err) {
    logActivity(store, ticket.id, 'clarify_error', err.message);
    ticket.status = 'idle';
    saveStore(store);
    res.status(500).json({ error: err.message });
  }
});

// Submit answers and get follow-up or plan
app.post('/api/tickets/:id/answer', async (req, res) => {
  const store = loadStore();
  const ticket = getTicket(store, req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.stage !== 'clarification') return res.status(400).json({ error: `Ticket is in ${ticket.stage} stage` });

  const { answers } = req.body;
  if (!answers || Object.keys(answers).length === 0) {
    return res.status(400).json({ error: 'No answers provided' });
  }

  // Save answers
  for (const [qId, answer] of Object.entries(answers)) {
    const q = ticket.questions.find(q => q.id === parseInt(qId));
    if (q) q.answer = answer;
  }

  logActivity(store, ticket.id, 'answers_submitted', JSON.stringify(answers).slice(0, 200));

  // Build Q&A context
  const qaText = ticket.questions.map((q, i) =>
    `Q${i + 1}: ${q.question}\nA${i + 1}: ${q.answer || '(no answer yet)'}`
  ).join('\n\n');

  let extraContext = '';
  if (ticket.review_feedback) {
    extraContext = `\n\nPrevious review feedback: ${ticket.review_feedback}`;
  }

  const prompt = `You are helping plan work on the pyxen codebase at ${PYXEN_DIR}.

Ticket: ${ticket.title}
Content: ${ticket.content}${extraContext}

Clarification Q&A so far:
${qaText}

Your job:
1. Evaluate if you have enough information to create an implementation plan
2. If you NEED MORE CLARIFICATION, respond with JSON: {"need_more": true, "questions": ["Follow-up Q1?", "Follow-up Q2?"], "notes": "Why I need more info"}
3. If you HAVE ENOUGH INFO, respond with JSON: {"need_more": false, "plan": "Detailed high-level implementation plan here...", "files_to_modify": ["file1.py", "file2.py"], "estimated_complexity": "low|medium|high", "notes": "Any assumptions made"}

IMPORTANT: Output ONLY the JSON object, no other text.`;

  try {
    logActivity(store, ticket.id, 'answer_process');
    ticket.status = 'running';
    ticket.updated_at = new Date().toISOString();
    saveStore(store);
    const output = await runOpenCode(ticket.id, prompt);
    ticket.status = 'idle';

    let parsed;
    try {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { need_more: false, plan: output };
    } catch {
      parsed = { need_more: false, plan: output };
    }

    if (parsed.need_more) {
      const maxRound = Math.max(...ticket.questions.map(q => q.round || 1), 1);
      for (const q of (parsed.questions || [])) {
        ticket.questions.push({ id: store.nextQId++, question: q, answer: null, round: maxRound + 1 });
      }
      if (parsed.notes) logActivity(store, ticket.id, 'followup_notes', parsed.notes);
      ticket.updated_at = new Date().toISOString();
      saveStore(store);
      return res.json({ clarified: false, ...ticket });
    }

    // All clarified - store plan and move to implementation
    ticket.plan = parsed.plan || '';
    ticket.review_feedback = null;
    ticket.stage = 'implementation';
    ticket.updated_at = new Date().toISOString();
    logActivity(store, ticket.id, 'clarified_plan', parsed.notes || '');
    if (parsed.files_to_modify) {
      logActivity(store, ticket.id, 'files_affected', parsed.files_to_modify.join(', '));
    }
    saveStore(store);

    res.json({ clarified: true, plan: ticket.plan, notes: parsed.notes, ticket });
  } catch (err) {
    logActivity(store, ticket.id, 'answer_error', err.message);
    ticket.status = 'idle';
    saveStore(store);
    res.status(500).json({ error: err.message });
  }
});

// ── Stage 2: Implementation ───────────────────────────────
app.post('/api/tickets/:id/implement', async (req, res) => {
  const store = loadStore();
  const ticket = getTicket(store, req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.stage !== 'implementation' && ticket.stage !== 'review') return res.status(400).json({ error: `Ticket is in ${ticket.stage} stage` });

  // If coming from review (continue), move back to implementation
  if (ticket.stage === 'review') {
    ticket.stage = 'implementation';
    ticket.updated_at = new Date().toISOString();
    logActivity(store, ticket.id, 'continued', 'Resuming implementation from review');
  }

  ensureWorktreesDir();
  const safeId = ticket.id.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const branchName = `feature/${safeId}`;
  const worktreePath = path.join(WORKTREES_DIR, safeId);

  try {
    // Ensure worktree exists and is usable
    const dirHere = fs.existsSync(worktreePath);
    const tracked = (() => { try { return execSync(`git worktree list`, { cwd: PYXEN_DIR, encoding: 'utf-8' }).includes(worktreePath); } catch { return false; } })();
    console.log(`[implement] ${ticket.id} dirHere=${dirHere} tracked=${tracked} path=${worktreePath}`);

    if (dirHere && tracked) {
      // Worktree already set up — nothing to do
    } else if (dirHere && !tracked) {
      // Directory exists but git doesn't know — repair and re-attach
      fs.rmSync(worktreePath, { recursive: true, force: true });
      try { runGit(`branch -D ${branchName}`); } catch {}
      runGit(`checkout -b ${branchName}`);
      runGit(`checkout main`);
      runGit(`worktree add ${worktreePath} ${branchName}`);
    } else {
      // Fresh setup
      try { runGit(`branch -D ${branchName}`); } catch {}
      runGit(`checkout -b ${branchName}`);
      runGit(`checkout main`);
      runGit(`worktree add ${worktreePath} ${branchName}`);
    }

    ticket.worktree_path = worktreePath;
    ticket.branch_name = branchName;
    logActivity(store, ticket.id, 'worktree_created', worktreePath);

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

    logActivity(store, ticket.id, 'implement_start');
    ticket.status = 'running';
    ticket.updated_at = new Date().toISOString();

    // Capture token baseline before implementation
    const tokensBefore = getOpencodeTokens();

    saveStore(store);

    // File-change monitor — tracks which files opencode modifies
    const seenFiles = new Set();
    const fileMonitor = setInterval(() => {
      try {
        const changed = execSync(`git diff --name-only`, { cwd: worktreePath, encoding: 'utf-8', timeout: 5000 }).trim();
        if (changed) {
          changed.split('\n').forEach(f => {
            if (!seenFiles.has(f)) {
              seenFiles.add(f);
              const s = loadStore();
              if (s.tickets[ticket.id]) {
                if (!s.tickets[ticket.id].activity) s.tickets[ticket.id].activity = [];
                s.tickets[ticket.id].activity.unshift({ action: 'file_changed', detail: f, time: new Date().toISOString() });
                if (s.tickets[ticket.id].activity.length > 500) s.tickets[ticket.id].activity = s.tickets[ticket.id].activity.slice(0, 500);
                s.tickets[ticket.id].updated_at = new Date().toISOString();
                saveStore(s);
              }
            }
          });
        }
      } catch { /* best-effort */ }
    }, 2000);

    const output = await runOpenCode(ticket.id, prompt, (line) => {
      // Only log resource lines as progress — skip LLM rambling
      if (line.startsWith('[resource]')) {
        try {
          const s = loadStore();
          if (s.tickets[ticket.id]) {
            if (!s.tickets[ticket.id].activity) s.tickets[ticket.id].activity = [];
            s.tickets[ticket.id].activity.unshift({ action: 'resource', detail: line.replace('[resource] ', ''), time: new Date().toISOString() });
            if (s.tickets[ticket.id].activity.length > 500) s.tickets[ticket.id].activity = s.tickets[ticket.id].activity.slice(0, 500);
            s.tickets[ticket.id].updated_at = new Date().toISOString();
            saveStore(s);
          }
        } catch { /* best-effort */ }
      }
    });

    // Store token usage delta
    const tokensAfter = getOpencodeTokens();
    const tokenDelta = {
      cost: (tokensAfter.cost - tokensBefore.cost).toFixed(3),
      input: tokensAfter.input, output: tokensAfter.output
    };
    ticket.token_usage = tokenDelta;
    logActivity(store, ticket.id, 'token_usage', JSON.stringify(tokenDelta));

    clearInterval(fileMonitor);

    let diffSummary = '';
    try { diffSummary = runGit(`diff --stat`, worktreePath); } catch { diffSummary = '(no diff)'; }

    // Save cumulative CPU/elapsed from last resource entry
    const store2 = loadStore();
    const t2 = store2.tickets[ticket.id];
    if (!t2) return res.status(500).json({ error: 'Ticket data lost' });
    const lastRes = (t2.activity || []).find(a => a.action === 'resource');
    if (lastRes) {
      const p = Object.fromEntries(lastRes.detail.split(' ').map(s => s.split('=')));
      t2.total_cpu = p.cpu || '0';
      t2.total_elapsed = p.elapsed || '0';
    }

    t2.stage = 'review';
    t2.status = 'idle';
    t2.updated_at = new Date().toISOString();
    logActivity(store2, ticket.id, 'implement_done', diffSummary.slice(0, 500));
    saveStore(store2);

    res.json({
      success: true, worktree_path: worktreePath, branch_name: branchName,
      diff_summary: diffSummary, output_summary: output.slice(-1000), ticket: t2
    });
  } catch (err) {
    const store2 = loadStore();
    const t2 = store2.tickets[ticket.id];
    if (t2) {
      const lastRes = (t2.activity || []).find(a => a.action === 'resource');
      if (lastRes) {
        const p = Object.fromEntries(lastRes.detail.split(' ').map(s => s.split('=')));
        t2.total_cpu = p.cpu || '0';
        t2.total_elapsed = p.elapsed || '0';
      }
      // On timeout/error: commit whatever was done, move to review, let user decide
      try { runGit(`add -A`, worktreePath); } catch {}
      try { runGit(`commit -m "${ticket.id}: partial (error: ${err.message.slice(0, 80).replace(/"/g, '')})"`, worktreePath); } catch {}
      logActivity(store2, ticket.id, 'implement_error', err.message);
      t2.stage = 'review';
      t2.status = 'idle';
      t2.updated_at = new Date().toISOString();
      saveStore(store2);
      res.json({ error: err.message, note: 'Changes auto-committed. Choose: continue (restart implementation) or review and cherry-pick.' });
    } else {
      logActivity(store, ticket.id, 'implement_error', err.message);
      saveStore(store);
      res.status(500).json({ error: err.message });
    }
  }
});

// ── Stage 3: Review feedback ──────────────────────────────
app.post('/api/tickets/:id/feedback', async (req, res) => {
  const store = loadStore();
  const ticket = getTicket(store, req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.stage !== 'review') return res.status(400).json({ error: `Ticket is in ${ticket.stage} stage` });

  const { feedback } = req.body;
  if (!feedback || !feedback.trim()) return res.status(400).json({ error: 'Feedback required' });

  ticket.stage = 'clarification';
  ticket.review_feedback = feedback.trim();
  ticket.plan = null;
  ticket.updated_at = new Date().toISOString();
  logActivity(store, ticket.id, 'review_feedback', feedback.trim().slice(0, 300));

  // Preserve worktree — prior commits and files stay intact for Continue or re-implementation

  saveStore(store);
  res.json({ success: true, message: 'Ticket moved back to clarification', ticket });
});

// ── Stage 4: Ready → cherry-pick + close ──────────────────
app.post('/api/tickets/:id/ready', async (req, res) => {
  const store = loadStore();
  const ticket = getTicket(store, req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.stage !== 'review') return res.status(400).json({ error: `Ticket is in ${ticket.stage} stage` });

  try {
    // Check if there are any changes to commit
    let hasChanges = false;
    try { runGit(`diff --quiet`, ticket.worktree_path); } catch { hasChanges = true; }
    try { runGit(`diff --cached --quiet`, ticket.worktree_path); } catch { hasChanges = true; }

    if (!hasChanges) {
      logActivity(store, ticket.id, 'no_changes', 'No code changes to commit — closing ticket directly');
      ticket.stage = 'done';
      ticket.commit_sha = null;
      ticket.updated_at = new Date().toISOString();
      saveStore(store);
      res.json({ success: true, commit_sha: null, note: 'No changes to cherry-pick', ticket });
      return;
    }

    const commitMsg = `${ticket.id}: ${ticket.title}`;

    // Stage all changes
    runGit(`add -A`, ticket.worktree_path);

    // Squash everything into one clean commit
    // Find the merge-base with main, soft-reset to it, then single commit
    try {
      const mergeBase = runGit(`merge-base main ${ticket.branch_name}`);
      runGit(`reset --soft ${mergeBase}`, ticket.worktree_path);
      logActivity(store, ticket.id, 'squashed', `All commits squashed to merge-base ${mergeBase.slice(0, 7)}`);
    } catch {
      // If merge-base fails (e.g. no common ancestor), just use the current state
      logActivity(store, ticket.id, 'squash_skipped', 'Could not find merge-base, committing as-is');
    }

    runGit(`commit -m "${commitMsg}"`, ticket.worktree_path);
    const commitSha = runGit(`rev-parse HEAD`, ticket.worktree_path);
    logActivity(store, ticket.id, 'committed', commitSha);

    // Rebase onto main before cherry-pick to avoid conflicts
    try {
      runGit(`checkout ${ticket.branch_name}`);
      runGit(`rebase main`);
      runGit(`checkout main`);
    } catch (err) {
      logActivity(store, ticket.id, 'rebase_failed', err.message);
      // Try to abort rebase and fall through to cherry-pick anyway
      try { runGit(`rebase --abort`); } catch {}
      runGit(`checkout main`);
    }

    runGit(`cherry-pick ${commitSha}`);
    logActivity(store, ticket.id, 'cherry_picked', commitSha);

    ticket.stage = 'done';
    ticket.commit_sha = commitSha;
    ticket.updated_at = new Date().toISOString();
    saveStore(store);

    res.json({ success: true, commit_sha: commitSha, ticket });
  } catch (err) {
    logActivity(store, ticket.id, 'ready_error', err.message);
    saveStore(store);
    res.status(500).json({ error: err.message });
  } finally {
    // Always clean up worktree and branch, even on error
    const wt = ticket.worktree_path;
    const bn = ticket.branch_name;
    try { runGit(`worktree remove --force ${wt}`); } catch {}
    try { runGit(`branch -D ${bn}`); } catch {}
    if (fs.existsSync(wt)) {
      try { fs.rmSync(wt, { recursive: true, force: true }); } catch {}
    }
    ticket.worktree_path = null;
    ticket.branch_name = null;
    saveStore(store);
  }
});

// Delete ticket
app.delete('/api/tickets/:id', (req, res) => {
  const store = loadStore();
  const ticket = store.tickets[req.params.id];
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  if (ticket.worktree_path && fs.existsSync(ticket.worktree_path)) {
    try { runGit(`worktree remove --force ${ticket.worktree_path}`); } catch {}
  }
  if (ticket.branch_name) {
    try { runGit(`branch -D ${ticket.branch_name}`); } catch {}
  }

  delete store.tickets[req.params.id];
  saveStore(store);
  res.json({ success: true });
});

// Get diff
app.get('/api/tickets/:id/diff', (req, res) => {
  const store = loadStore();
  const ticket = store.tickets[req.params.id];
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

// Dry-run pre-push hook on main checkout (top-level) — streaming
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
// Crash recovery: reset any tickets stuck in "running" from a previous crash
(function recoverStuckTickets() {
  const store = loadStore();
  let changed = false;
  for (const tid of Object.keys(store.tickets)) {
    const t = store.tickets[tid];
    if (t.status === 'running') {
      // Check if opencode session is still alive
      let alive = false;
      if (t.ocode_session) {
        try {
          const sessions = execSync(`${OPENCODE_BIN} session list`, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
          alive = sessions.includes(t.ocode_session);
        } catch {}
      }
      if (!alive) {
        t.status = 'idle';
        t.updated_at = new Date().toISOString();
        if (!t.activity) t.activity = [];
        t.activity.unshift({ action: 'recovered', detail: 'Server restarted — previous opencode session gone, reset to idle', time: new Date().toISOString() });
        changed = true;
        console.log(`Recovered: ${tid} reset to idle (session not alive)`);
      }
    }
  }
  if (changed) saveStore(store);
})();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Pyxen Jira Dashboard running on http://0.0.0.0:${PORT}`);
  console.log(`   Pyxen: ${PYXEN_DIR}`);
  console.log(`   OpenCode: ${OPENCODE_BIN}`);
  console.log(`   Data: ${DB_FILE}`);
});
