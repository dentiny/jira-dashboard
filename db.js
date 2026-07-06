const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const DATA_DIR = config.dataDir;
const DB_PATH = path.join(DATA_DIR, 'store.db');
const JSON_PATH = path.join(DATA_DIR, 'store.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Init ──────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma(`busy_timeout = ${config.dbBusyTimeout}`);

// ── Schema ────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT DEFAULT '',
    stage TEXT DEFAULT 'clarification',
    plan TEXT,
    worktree_path TEXT,
    branch_name TEXT,
    commit_sha TEXT,
    pr_url TEXT,
    review_feedback TEXT,
    status TEXT DEFAULT 'idle',
    ocode_session TEXT,
    total_cpu TEXT,
    total_elapsed TEXT,
    token_cost REAL,
    token_input TEXT,
    token_output TEXT,
    coder_pgid INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    answer TEXT,
    round INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    detail TEXT DEFAULT '',
    time TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS test_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'running',  -- running | pass | fail | skip | error
    framework TEXT,                          -- pytest | npm | go | cargo | shell
    command TEXT,                            -- exact command run (for transparency)
    exit_code INTEGER,
    summary TEXT,                            -- e.g. "12 passed, 1 failed"
    output TEXT DEFAULT '',                  -- full stdout+stderr (truncated to ~64KB)
    duration_ms INTEGER,
    triggered_by TEXT DEFAULT 'auto',        -- auto (after implement) | manual | continue
    started_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_questions_ticket ON questions(ticket_id);
  CREATE INDEX IF NOT EXISTS idx_activity_ticket ON activity(ticket_id);
  CREATE INDEX IF NOT EXISTS idx_test_runs_ticket ON test_runs(ticket_id, id DESC);
`);

// Migration: add type/options columns to questions (added 2026-06-27)
try { db.exec(`ALTER TABLE questions ADD COLUMN type TEXT DEFAULT 'free_text'`); } catch {}
try { db.exec(`ALTER TABLE questions ADD COLUMN options TEXT`); } catch {}

// Migration: add stage column to activity for per-stage resource tracking
try { db.exec(`ALTER TABLE activity ADD COLUMN stage TEXT`); } catch {}

// Migration: add estimated_complexity and notes columns to tickets
try { db.exec(`ALTER TABLE tickets ADD COLUMN estimated_complexity TEXT`); } catch {}
try { db.exec(`ALTER TABLE tickets ADD COLUMN plan_notes TEXT`); } catch {}

// Migration: add pr_url column to tickets (GitHub PR link for MERGE_STRATEGY=pr)
try { db.exec(`ALTER TABLE tickets ADD COLUMN pr_url TEXT`); } catch {}

// Migration: add base_sha column (origin/<default> commit at worktree acquire time)
try { db.exec(`ALTER TABLE tickets ADD COLUMN base_sha TEXT`); } catch {}

// Migration: add coder_pgid column (process group ID for orphan cleanup)
try { db.exec(`ALTER TABLE tickets ADD COLUMN coder_pgid INTEGER`); } catch {}

// ── Prepared statements ───────────────────────────────────
const stmts = {
  // Tickets
  getTicket: db.prepare(`SELECT * FROM tickets WHERE id = ?`),
  getAllTickets: db.prepare(`SELECT * FROM tickets ORDER BY updated_at DESC`),
  getAllTicketIds: db.prepare(`SELECT id FROM tickets`),
  insertTicket: db.prepare(`
    INSERT INTO tickets (id, title, content, stage, plan, worktree_path,
      branch_name, commit_sha, pr_url, review_feedback, status, ocode_session,
      total_cpu, total_elapsed, token_cost, token_input, token_output,
      estimated_complexity, plan_notes, coder_pgid, created_at, updated_at)
    VALUES (@id, @title, @content, @stage, @plan, @worktree_path,
      @branch_name, @commit_sha, @pr_url, @review_feedback, @status, @ocode_session,
      @total_cpu, @total_elapsed, @token_cost, @token_input, @token_output,
      @estimated_complexity, @plan_notes, @coder_pgid, @created_at, @updated_at)
  `),
  updateTicket: db.prepare(`
    UPDATE tickets SET
      title = @title, content = @content, stage = @stage, plan = @plan,
      worktree_path = @worktree_path, branch_name = @branch_name,
      commit_sha = @commit_sha, pr_url = @pr_url, review_feedback = @review_feedback,
      status = @status, ocode_session = @ocode_session,
      total_cpu = @total_cpu, total_elapsed = @total_elapsed,
      token_cost = @token_cost, token_input = @token_input,
      token_output = @token_output,
      estimated_complexity = @estimated_complexity,
      plan_notes = @plan_notes, coder_pgid = @coder_pgid, updated_at = @updated_at
    WHERE id = @id
  `),
  updateTicketField: (field) => db.prepare(`
    UPDATE tickets SET ${field} = ?, updated_at = ? WHERE id = ?
  `),
  deleteTicket: db.prepare(`DELETE FROM tickets WHERE id = ?`),

  // Questions
  insertQuestion: db.prepare(`
    INSERT INTO questions (ticket_id, question, answer, round, type, options)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getQuestions: db.prepare(`
    SELECT * FROM questions WHERE ticket_id = ? ORDER BY id
  `),
  updateQuestionAnswer: db.prepare(`
    UPDATE questions SET answer = ? WHERE id = ? AND ticket_id = ?
  `),

  // Questions (bulk)
  deleteQuestions: db.prepare(`DELETE FROM questions WHERE ticket_id = ?`),

  // Activity
  insertActivity: db.prepare(`
    INSERT INTO activity (ticket_id, action, detail, stage, time)
    VALUES (?, ?, ?, ?, ?)
  `),
  getActivity: db.prepare(`
    SELECT * FROM activity WHERE ticket_id = ? ORDER BY time DESC LIMIT 500
  `),

  clearStageActivity: db.prepare(`
    DELETE FROM activity WHERE ticket_id = ? AND (action = 'resource' OR action = 'stage_summary') AND stage = ?
  `),

  // Test runs
  insertTestRun: db.prepare(`
    INSERT INTO test_runs (ticket_id, status, framework, command, triggered_by, started_at)
    VALUES (?, 'running', ?, ?, ?, ?)
  `),
  finalizeTestRun: db.prepare(`
    UPDATE test_runs SET
      status = @status, exit_code = @exit_code, summary = @summary,
      output = @output, duration_ms = @duration_ms, finished_at = @finished_at
    WHERE id = @id
  `),
  getTestRun: db.prepare(`SELECT * FROM test_runs WHERE id = ?`),
  getLatestTestRun: db.prepare(`
    SELECT * FROM test_runs WHERE ticket_id = ?
    ORDER BY id DESC LIMIT 1
  `),
  getTestRuns: db.prepare(`
    SELECT * FROM test_runs WHERE ticket_id = ? ORDER BY id DESC LIMIT 20
  `),
  getTestRunsLimited: db.prepare(`
    SELECT * FROM test_runs WHERE ticket_id = ? ORDER BY id DESC LIMIT ?
  `),

  // Count
  nextQId: db.prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM questions`),
};

const updateFieldCache = {};
function getUpdateFieldStmt(field) {
  if (!updateFieldCache[field]) {
    updateFieldCache[field] = db.prepare(
      `UPDATE tickets SET ${field} = ?, updated_at = ? WHERE id = ?`
    );
  }
  return updateFieldCache[field];
}

// ── Public API ────────────────────────────────────────────

function getTicket(id) {
  const row = stmts.getTicket.get(id);
  if (!row) return null;
  row.questions = stmts.getQuestions.all(id).map(q => ({
    ...q,
    options: q.options ? JSON.parse(q.options) : undefined
  }));
  row.activity = stmts.getActivity.all(id);
  row.token_usage = (row.token_cost != null) ? {
    cost: String(row.token_cost),
    input: row.token_input || '',
    output: row.token_output || ''
  } : undefined;
  return row;
}

function getAllTickets() {
  const tickets = stmts.getAllTickets.all();
  for (const t of tickets) {
    t.questions = stmts.getQuestions.all(t.id).map(q => ({
      ...q,
      options: q.options ? JSON.parse(q.options) : undefined
    }));
    t.activity = stmts.getActivity.all(t.id);
    if (t.token_cost != null) {
      t.token_usage = {
        cost: String(t.token_cost),
        input: t.token_input || '',
        output: t.token_output || ''
      };
    }
  }
  return tickets;
}

function createTicket(data) {
  const defaults = {
    stage: 'clarification',
    status: 'idle',
    content: '',
    plan: null,
    worktree_path: null,
    branch_name: null,
    commit_sha: null,
    pr_url: null,
    review_feedback: null,
    ocode_session: null,
    total_cpu: null,
    total_elapsed: null,
    token_cost: null,
    token_input: null,
    token_output: null,
    estimated_complexity: null,
    plan_notes: null,
    coder_pgid: null,
  };
  const t = { ...defaults, ...data };
  stmts.insertTicket.run(t);
  logActivity(t.id, 'created', t.title);
  return getTicket(t.id);
}

function updateTicket(id, fields) {
  const ticket = stmts.getTicket.get(id);
  if (!ticket) return null;
  const merged = { ...ticket, ...fields, updated_at: new Date().toISOString() };
  stmts.updateTicket.run(merged);
  return getTicket(id);
}

function updateTicketField(id, field, value) {
  const now = new Date().toISOString();
  getUpdateFieldStmt(field).run(value, now, id);
}

function deleteTicket(id) {
  stmts.deleteTicket.run(id);
}

function deleteQuestionsForTicket(ticketId) {
  stmts.deleteQuestions.run(ticketId);
}

function clearStageActivity(ticketId, stage) {
  stmts.clearStageActivity.run(ticketId, stage);
}

function addQuestion(ticketId, questionText, answer, round, type, options) {
  const info = stmts.insertQuestion.run(
    ticketId, questionText, answer || null, round || 1,
    type || 'free_text', options || null
  );
  return Number(info.lastInsertRowid);
}

function updateQuestionAnswer(questionId, ticketId, answer) {
  stmts.updateQuestionAnswer.run(answer, questionId, ticketId);
}

function logActivity(ticketId, action, detail, stage = null) {
  stmts.insertActivity.run(ticketId, action, detail || '', stage, new Date().toISOString());
}

function nextQuestionId() {
  return stmts.nextQId.get().n;
}

function getTicketIds() {
  return stmts.getAllTicketIds.all().map(r => r.id);
}

// ── Test run API ───────────────────────────────────────────
// One test run per row.  `triggered_by` distinguishes auto-runs
// after implement from manual re-runs from the UI and from runs
// triggered by the Continue button.  Output is truncated at the
// SQL layer to keep the DB small (large logs can blow up).

const TEST_OUTPUT_MAX_BYTES = 64 * 1024;

function createTestRun(ticketId, framework, command, triggeredBy = 'auto') {
  const info = stmts.insertTestRun.run(
    ticketId, framework || null, command || null,
    triggeredBy, new Date().toISOString()
  );
  return Number(info.lastInsertRowid);
}

function finalizeTestRun(runId, fields) {
  const row = stmts.getTestRun.get(runId);
  if (!row) return null;
  let output = fields.output || '';
  if (output.length > TEST_OUTPUT_MAX_BYTES) {
    output = output.slice(0, TEST_OUTPUT_MAX_BYTES)
      + `\n\n[output truncated to ${TEST_OUTPUT_MAX_BYTES} bytes]`;
  }
  stmts.finalizeTestRun.run({
    id: runId,
    status: fields.status,
    exit_code: fields.exit_code ?? null,
    summary: fields.summary || null,
    output,
    duration_ms: fields.duration_ms ?? null,
    finished_at: new Date().toISOString(),
  });
  return stmts.getTestRun.get(runId);
}

function getLatestTestRun(ticketId) {
  return stmts.getLatestTestRun.get(ticketId) || null;
}

function getTestRuns(ticketId, limit = 20) {
  const capped = Math.max(1, Math.min(100, limit | 0));
  return stmts.getTestRunsLimited.all(ticketId, capped);
}

function close() {
  db.close();
}

// ── Stage resource aggregation ────────────────────────────
// Walks the activity log for a ticket and accumulates per-stage
// deltas.  Since the same stage may repeat across cycles (e.g.
// after review feedback), per-stage contributions are computed
// by summing deltas between CONSECUTIVE resource entries that
// share the same stage tag — NOT by a single (last - first)
// across the whole group, which would pull in interleaved costs
// from other stages.
//
// TOKEN/COST: opencode stats are project-wide cumulative, so
// the grand total uses (last overall - first overall) across ALL
// entries.  CPU/elapsed are per-process (resets on each coder run),
// so the grand total sums per-stage buckets.
//
// Returns:
//   {
//     clarification: { cpu, elapsed, peak_mem, tokens_in, tokens_out, cost, calls } | null,
//     implementation: { ... } | null,
//     total: { cpu, elapsed, peak_mem, tokens_in, tokens_out, cost, calls }
//   }

// Token parser helpers
function _parseToken(s) {
  if (!s) return 0;
  const raw = parseFloat(s.replace(/[,]/g, '')) || 0;
  if (/[Bb]$/.test(s)) return raw * 1e9;
  if (/[Mm]$/.test(s)) return raw * 1e6;
  if (/[Kk]$/.test(s)) return raw * 1e3;
  return raw;
}
function _parseCost(s) { return parseFloat((s || '0').replace(/[$,]/g, '')) || 0; }

function _emptyBucket() { return { cpu: 0, elapsed: 0, peak_mem: 0, tokens_in: 0, tokens_out: 0, cost: 0, calls: 0 }; }

function getStageResources(ticketId) {
  const rows = stmts.getActivity.all(ticketId).slice().reverse(); // chronological
  const parseKv = (s) => Object.fromEntries((s || '').split(' ').map(k => k.split('=')));

  const allRes = rows.filter(r => r.action === 'resource');

  const buckets = {};
  const peakMems = {};
  let prev = null;
  let prevStage = null;

  for (const r of allRes) {
    const stage = r.stage || 'unknown';
    if (!buckets[stage]) {
      buckets[stage] = _emptyBucket();
      peakMems[stage] = 0;
    }

    const cp = parseKv(r.detail);
    peakMems[stage] = Math.max(peakMems[stage], parseFloat(cp.mem) || 0);

    if (prev && stage === prevStage) {
      const pp = parseKv(prev.detail);
      buckets[stage].cpu += Math.max(0, (parseFloat(cp.cpu) || 0) - (parseFloat(pp.cpu) || 0));
      buckets[stage].elapsed += Math.max(0, (parseInt(cp.elapsed) || 0) - (parseInt(pp.elapsed) || 0));
      buckets[stage].tokens_in += Math.max(0, _parseToken(cp.tokens_in) - _parseToken(pp.tokens_in));
      buckets[stage].tokens_out += Math.max(0, _parseToken(cp.tokens_out) - _parseToken(pp.tokens_out));
      buckets[stage].cost += Math.max(0, _parseCost(cp.cost) - _parseCost(pp.cost));
    }

    if (stage !== prevStage) {
      buckets[stage].calls++;
      prevStage = stage;
    }
    prev = r;
  }

  // Assign peak memory and build summary
  for (const stage of Object.keys(buckets)) {
    buckets[stage].peak_mem = peakMems[stage];
  }

  const summary = { clarification: null, implementation: null, total: _emptyBucket() };
  for (const [stage, bucket] of Object.entries(buckets)) {
    if (stage in summary) summary[stage] = bucket;
    else summary[stage] = bucket;
  }

  // ── Grand total ──────────────────────────────────────
  if (allRes.length > 0) {
    const firstOverall = parseKv(allRes[0].detail);
    const lastOverall = parseKv(allRes[allRes.length - 1].detail);
    // tokens/cost are cumulative (opencode stats) – overall first→last delta
    summary.total.tokens_in = Math.max(0, _parseToken(lastOverall.tokens_in) - _parseToken(firstOverall.tokens_in));
    summary.total.tokens_out = Math.max(0, _parseToken(lastOverall.tokens_out) - _parseToken(firstOverall.tokens_out));
    summary.total.cost = Math.max(0, _parseCost(lastOverall.cost) - _parseCost(firstOverall.cost));
    // CPU/elapsed are per-process – sum per-stage buckets
    for (const key of Object.keys(summary)) {
      if (key === 'total') continue;
      const b = summary[key];
      if (b) {
        summary.total.cpu += b.cpu;
        summary.total.elapsed += b.elapsed;
      }
    }
    // peak memory: max across all entries
    for (const r of allRes) {
      const mem = parseFloat(parseKv(r.detail).mem) || 0;
      if (mem > summary.total.peak_mem) summary.total.peak_mem = mem;
    }
    // calls: sum of per-stage calls
    for (const key of Object.keys(summary)) {
      if (key === 'total') continue;
      const b = summary[key];
      if (b) summary.total.calls += b.calls;
    }
  }

  return summary;
}

// ── Migration from JSON ───────────────────────────────────
function migrateFromJSON() {
  if (!fs.existsSync(JSON_PATH)) return;

  const raw = fs.readFileSync(JSON_PATH, 'utf-8');
  let data;
  try { data = JSON.parse(raw); } catch { return; }

  if (!data.tickets || Object.keys(data.tickets).length === 0) return;

  const migrateAll = db.transaction(() => {
    for (const [tid, t] of Object.entries(data.tickets)) {
      stmts.insertTicket.run({
        id: tid,
        title: t.title || '',
        content: t.content || '',
        stage: t.stage || 'clarification',
        plan: t.plan || null,
        estimated_complexity: t.estimated_complexity || null,
        plan_notes: t.plan_notes || null,
        worktree_path: t.worktree_path || null,
        branch_name: t.branch_name || null,
        commit_sha: t.commit_sha || null,
        review_feedback: t.review_feedback || null,
        status: t.status || 'idle',
        ocode_session: t.ocode_session || null,
        total_cpu: t.total_cpu || null,
        total_elapsed: t.total_elapsed || null,
        token_cost: t.token_usage?.cost ? parseFloat(t.token_usage.cost) : null,
        token_input: t.token_usage?.input || null,
        token_output: t.token_usage?.output || null,
        created_at: t.created_at || new Date().toISOString(),
        updated_at: t.updated_at || new Date().toISOString(),
      });

      if (t.questions) {
        for (const q of t.questions) {
          stmts.insertQuestion.run(tid, q.question, q.answer || null, q.round || 1);
        }
      }

      if (t.activity) {
        for (const a of t.activity) {
          stmts.insertActivity.run(tid, a.action, a.detail || '', a.time || new Date().toISOString());
        }
      }
    }
  });

  try {
    migrateAll();
    // Rename JSON to mark as migrated
    fs.renameSync(JSON_PATH, JSON_PATH + '.migrated');
    console.log(`Migrated ${Object.keys(data.tickets).length} tickets from store.json → store.db`);
  } catch (err) {
    console.error('Migration failed:', err.message);
    throw err;
  }
}

// Run migration if needed
try {
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM tickets`).get();
  if (row.cnt === 0 && fs.existsSync(JSON_PATH)) {
    migrateFromJSON();
  }
} catch (err) {
  if (err.message.includes('no such table')) {
    // Tables don't exist yet — shouldn't happen since we create above
    console.error('Schema missing:', err.message);
  } else {
    throw err;
  }
}

module.exports = {
  getTicket,
  getAllTickets,
  createTicket,
  updateTicket,
  updateTicketField,
  deleteTicket,
  addQuestion,
  updateQuestionAnswer,
  deleteQuestionsForTicket,
  clearStageActivity,
  logActivity,
  getStageResources,
  nextQuestionId,
  getTicketIds,
  createTestRun,
  finalizeTestRun,
  getLatestTestRun,
  getTestRuns,
  close,
};
