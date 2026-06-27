const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'store.db');
const JSON_PATH = path.join(DATA_DIR, 'store.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Init ──────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

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
    review_feedback TEXT,
    status TEXT DEFAULT 'idle',
    ocode_session TEXT,
    total_cpu TEXT,
    total_elapsed TEXT,
    token_cost REAL,
    token_input TEXT,
    token_output TEXT,
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

  CREATE INDEX IF NOT EXISTS idx_questions_ticket ON questions(ticket_id);
  CREATE INDEX IF NOT EXISTS idx_activity_ticket ON activity(ticket_id);
`);

// Migration: add type/options columns to questions (added 2026-06-27)
try { db.exec(`ALTER TABLE questions ADD COLUMN type TEXT DEFAULT 'free_text'`); } catch {}
try { db.exec(`ALTER TABLE questions ADD COLUMN options TEXT`); } catch {}

// Migration: add stage column to activity for per-stage resource tracking
try { db.exec(`ALTER TABLE activity ADD COLUMN stage TEXT`); } catch {}

// ── Prepared statements ───────────────────────────────────
const stmts = {
  // Tickets
  getTicket: db.prepare(`SELECT * FROM tickets WHERE id = ?`),
  getAllTickets: db.prepare(`SELECT * FROM tickets ORDER BY updated_at DESC`),
  getAllTicketIds: db.prepare(`SELECT id FROM tickets`),
  insertTicket: db.prepare(`
    INSERT INTO tickets (id, title, content, stage, plan, worktree_path,
      branch_name, commit_sha, review_feedback, status, ocode_session,
      total_cpu, total_elapsed, token_cost, token_input, token_output,
      created_at, updated_at)
    VALUES (@id, @title, @content, @stage, @plan, @worktree_path,
      @branch_name, @commit_sha, @review_feedback, @status, @ocode_session,
      @total_cpu, @total_elapsed, @token_cost, @token_input, @token_output,
      @created_at, @updated_at)
  `),
  updateTicket: db.prepare(`
    UPDATE tickets SET
      title = @title, content = @content, stage = @stage, plan = @plan,
      worktree_path = @worktree_path, branch_name = @branch_name,
      commit_sha = @commit_sha, review_feedback = @review_feedback,
      status = @status, ocode_session = @ocode_session,
      total_cpu = @total_cpu, total_elapsed = @total_elapsed,
      token_cost = @token_cost, token_input = @token_input,
      token_output = @token_output, updated_at = @updated_at
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
    review_feedback: null,
    ocode_session: null,
    total_cpu: null,
    total_elapsed: null,
    token_cost: null,
    token_input: null,
    token_output: null,
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

function close() {
  db.close();
}

// ── Stage resource aggregation ────────────────────────────
// Walks the activity log for a ticket and buckets every
// `resource` entry into its tagged stage.  Within each stage,
// the FIRST resource entry is the baseline and the LAST is
// the final cumulative reading; delta between them is the
// contribution of that stage.  For `stage_summary` entries
// (which already carry delta totals per opencode call) we
// sum the parsed fields directly — that handles the case
// where a stage ran multiple opencode calls.
//
// Tokens / cost come from opencode's project-wide stats which
// are absolute cumulative, so the same delta trick works.
//
// Returns:
//   {
//     clarification: { cpu, elapsed, peak_mem, tokens_in, tokens_out, cost, calls },
//     implementation: { ... },
//     total: { cpu, elapsed, peak_mem, tokens_in, tokens_out, cost, calls }
//   }
// Missing stages come back as null so the UI can render an
// "n/a" cleanly.
function _emptyBucket() { return { cpu: 0, elapsed: 0, peak_mem: 0, tokens_in: 0, tokens_out: 0, cost: 0, calls: 0 }; }

function getStageResources(ticketId) {
  const rows = stmts.getActivity.all(ticketId).slice().reverse(); // chronological
  // group resource entries by stage, preserving order
  const byStage = {};
  let baselineByStage = {};   // first resource entry per stage (cumulative values)
  for (const r of rows) {
    if (r.action !== 'resource') continue;
    const stage = r.stage || 'unknown';
    if (!(stage in byStage)) { byStage[stage] = []; baselineByStage[stage] = null; }
    byStage[stage].push(r);
  }
  const summary = { clarification: null, implementation: null, total: _emptyBucket() };
  for (const [stage, entries] of Object.entries(byStage)) {
    const bucket = _emptyBucket();
    // cpu / elapsed / tokens come from delta(last - first)
    const first = entries[0];
    const last = entries[entries.length - 1];
    const parseKv = (s) => Object.fromEntries((s || '').split(' ').map(k => k.split('=')));
    const fp = parseKv(first.detail);
    const lp = parseKv(last.detail);
    bucket.cpu = Math.max(0, (parseFloat(lp.cpu) || 0) - (parseFloat(fp.cpu) || 0));
    bucket.elapsed = Math.max(0, (parseInt(lp.elapsed) || 0) - (parseInt(fp.elapsed) || 0));
    bucket.tokens_in = (lp.tokens_in || '').replace(/[,KMB]/g, '');
    bucket.tokens_out = (lp.tokens_out || '').replace(/[,KMB]/g, '');
    // cost is $-prefixed in the detail string
    const parseCost = (s) => parseFloat((s || '').replace(/[$,]/g, '')) || 0;
    bucket.cost = Math.max(0, parseCost(lp.cost) - parseCost(fp.cost));
    // peak memory: max over all entries in this stage
    for (const e of entries) {
      const mem = parseFloat(parseKv(e.detail).mem) || 0;
      if (mem > bucket.peak_mem) bucket.peak_mem = mem;
    }
    bucket.calls = 1; // single opencode session per stage typically; refined below via stage_summary
    // If multiple distinct opencode calls happened in this stage
    // (e.g. clarify + answer), the deltas above only capture the
    // polling window of the last call.  Augment from stage_summary.
    const summaries = rows.filter(r => r.action === 'stage_summary' && (r.stage || 'unknown') === stage);
    if (summaries.length > 1) {
      const sum = _emptyBucket();
      for (const s of summaries) {
        const sp = parseKv(s.detail);
        sum.cpu += parseFloat(sp.cpu) || 0;
        sum.elapsed += parseFloat(sp.elapsed) || 0;
        sum.tokens_in += parseFloat((sp.tokens_in || '0').replace(/[,KMB]/g, '')) || 0;
        sum.tokens_out += parseFloat((sp.tokens_out || '0').replace(/[,KMB]/g, '')) || 0;
        sum.cost += parseCost(sp.cost);
        const m = parseFloat(sp.peak_mem) || 0;
        if (m > sum.peak_mem) sum.peak_mem = m;
      }
      sum.calls = summaries.length;
      // Prefer summed stage_summary values when available
      bucket.cpu = sum.cpu;
      bucket.elapsed = sum.elapsed;
      bucket.tokens_in = sum.tokens_in;
      bucket.tokens_out = sum.tokens_out;
      bucket.cost = sum.cost;
      bucket.peak_mem = sum.peak_mem;
      bucket.calls = sum.calls;
    }
    if (stage in summary) summary[stage] = bucket;
    else summary[stage] = bucket;
    // accumulate grand total
    summary.total.cpu += bucket.cpu;
    summary.total.elapsed += bucket.elapsed;
    summary.total.tokens_in += bucket.tokens_in;
    summary.total.tokens_out += bucket.tokens_out;
    summary.total.cost += bucket.cost;
    if (bucket.peak_mem > summary.total.peak_mem) summary.total.peak_mem = bucket.peak_mem;
    summary.total.calls += bucket.calls;
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
  logActivity,
  getStageResources,
  nextQuestionId,
  getTicketIds,
  close,
};
