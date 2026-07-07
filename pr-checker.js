const { exec } = require('child_process');

function startPrChecker(db, config, sseBroadcast, runClarify) {
  const INTERVAL = 180_000; // 3 min
  const prStates = new Map(); // ticketId → state hash
  const watched = new Set();   // ticketIds that have an active setInterval

  // ── Check classification helpers ──────────────────────────
  const ignoreSet = new Set(config.prCheckIgnore || []);
  const reworkSet = new Set(config.prReworkChecks || []);

  function isIgnored(name) {
    if (ignoreSet.size === 0) return false;
    for (const pattern of ignoreSet) {
      if (new RegExp(`^${pattern}$`, 'i').test(name)) return true;
    }
    return false;
  }

  function isRework(name) {
    if (reworkSet.size === 0) return false;
    for (const pattern of reworkSet) {
      if (new RegExp(`^${pattern}$`, 'i').test(name)) return true;
    }
    return false;
  }

  async function checkTicket(tid) {
    const t = db.getTicket(tid);
    if (!t || t.stage !== 'pr_opened' || !t.pr_url) return;

    const m = t.pr_url.match(/\/pull\/(\d+)/);
    if (!m) return;

    let json;
    try {
      json = await new Promise((res, rej) => {
        exec(`gh pr view ${m[1]} --json state,reviews,comments,statusCheckRollup`,
          { cwd: config.projectDir, timeout: 15000 },
          (err, out) => err ? rej(err) : res(out));
      });
    } catch { return; }

    const pr = JSON.parse(json);
    if (pr.state !== 'OPEN') return;

    // ── Normalize check fields ──────────────────────────────
    // StatusContext uses context/state; CheckRun uses name/conclusion/status.
    const checkName = (c) => c.context || c.name || '';
    const checkState = (c) => c.state || c.conclusion || (
      c.status === 'IN_PROGRESS' || c.status === 'QUEUED' ? 'PENDING' : c.status
    ) || '?';
    const isFailed = (c) => {
      const s = checkState(c);
      return s === 'FAILURE' || s === 'ERROR';
    };
    const isSuccess = (c) => {
      const s = checkState(c);
      return s === 'SUCCESS' || s === 'NEUTRAL' || s === 'SKIPPED';
    };

    // ── Classify each check into Ignore / Rework / Show ────
    const reworkFailures = []; // FAILURE/ERROR rework checks → trigger code rework
    const showItems = [];      // everything else → Address PR button

    for (const check of (pr.statusCheckRollup || [])) {
      const name = checkName(check);
      if (isIgnored(name)) continue; // fully ignored, never stored or shown
      if (isRework(name) && isFailed(check)) {
        reworkFailures.push(check);
      } else if (!isSuccess(check)) {
        showItems.push(check);
      }
    }

    const changeRequested = (pr.reviews || []).filter(
      r => r.state === 'CHANGES_REQUESTED');

    const newComments = (pr.comments || []).filter(c => !c.isMinimized);

    const totalItems = reworkFailures.length + showItems.length + changeRequested.length + newComments.length;
    if (totalItems === 0) {
      if (t.pr_rework_needed) {
        db.updateTicket(tid, { pr_rework_needed: 0, review_feedback: null });
        db.logActivity(tid, 'pr_feedback', `PR #${m[1]} all clear — flags reset`);
        sseBroadcast(tid, 'ticket', db.getTicket(tid));
      }
      return;
    }

    const sig = JSON.stringify({ reworkFailures, showItems, changeRequested, newComments });
    const prev = prStates.get(tid);
    if (prev === sig) {
      db.updateTicketField(tid, 'updated_at', new Date().toISOString());
      return;
    }
    prStates.set(tid, sig);

    const needsMove = reworkFailures.length > 0 || changeRequested.length > 0;

    const showItemLine = (f) => `  • ${checkName(f)} — ${checkState(f)}${f.targetUrl ? ` (${f.targetUrl})` : ''}`;

    if (!needsMove) {
      // Only Show items + comments → stay in pr_opened, show Address PR button
      const parts = [];
      for (const f of showItems) {
        parts.push(showItemLine(f));
      }
      if (newComments.length > 0) {
        parts.push(`  • ${newComments.length} new comment(s) on the PR`);
      }
      const summary = parts.join('\n');
      const header = `PR #${m[1]} has tasks that need attention:\n`;
      db.updateTicket(tid, { review_feedback: header + summary, pr_rework_needed: 0 });
      db.logActivity(tid, 'pr_feedback', `PR tasks set on ${tid}:\n${header}${summary}`);
    } else {
      // Rework failures or change requests → move to clarification
      const summaryParts = [];
      if (reworkFailures.length > 0) {
        summaryParts.push([
          `PR #${m[1]} — the following checks require code changes:`,
          ...reworkFailures.map(showItemLine),
        ].join('\n'));
      }
      if (changeRequested.length > 0) {
        summaryParts.push('');
        summaryParts.push(`Changes requested on the PR (address via code changes if applicable):`);
        for (const r of changeRequested) {
          summaryParts.push(`  • Review by ${r.author?.login || 'someone'} requests changes`);
        }
      }
      summaryParts.push(``);
      summaryParts.push(`IGNORE the following — they are pending, non-actionable, or outside code scope:`);
      for (const f of showItems) {
        summaryParts.push(`${showItemLine(f)} (ignore)`);
      }
      const summary = summaryParts.join('\n');
      // Preserve previous Q&A history in feedback before clearing
      const prevQA = db.getTicket(tid)?.questions || [];
      const qaText = prevQA.map((q, i) => `Q: ${q.question}\nA: ${q.answer || '(unanswered)'}`).join('\n\n');
      const fullFeedback = qaText ? `Previous Q&A:\n${qaText}\n\n---\n\n${summary}` : summary;
      db.deleteQuestionsForTicket(tid);
      db.updateTicket(tid, { stage: 'clarification', review_feedback: fullFeedback, plan: null, status: 'idle', pr_rework_needed: 1 });
      db.logActivity(tid, 'pr_feedback', `Moved to clarification:\n${summary}`);
      // Auto-trigger clarify so the coder generates questions automatically
      if (runClarify) runClarify(tid);
    }
    sseBroadcast(tid, 'ticket', db.getTicket(tid));
    console.log(`[pr-check] ${tid} — PR #${m[1]} has new activity`);
  }

  // Register a ticket for periodic PR checking.  Idempotent: only the first
  // call per ticket sets up the interval, so callers never worry about
  // duplicates (boot scan vs mid-session creation vs manual re-check).
  function startWatching(tid) {
    if (watched.has(tid)) return;
    watched.add(tid);
    checkTicket(tid);
    setInterval(() => checkTicket(tid), INTERVAL);
  }

  function scheduleAll() {
    const ids = db.getTicketIds();
    let delay = 5_000;
    for (const tid of ids) {
      const t = db.getTicket(tid);
      if (t && t.stage === 'pr_opened' && t.pr_url && /\/pull\/(\d+)/.test(t.pr_url)) {
        setTimeout(() => startWatching(tid), delay);
        delay += 15_000;
      }
    }
  }

  // Clear stale review_feedback from previous sessions — it gets repopulated
  // by the first checkTicket run.  Without this, old "tasks that need attention"
  // content survives across restarts and is visible during the boot delay.
  for (const tid of db.getTicketIds()) {
    const t = db.getTicket(tid);
    if (t && t.stage === 'pr_opened') {
      db.updateTicketField(tid, 'review_feedback', null);
    }
  }

  scheduleAll();

  // Periodic rescan: catch any tickets that entered pr_opened mid-session
  // (e.g. manual DB edit, PR checker clearing a clarification move, recovery
  // from interrupted push) without needing a server restart.  Idempotent via
  // the watched Set — already-watched tickets are skipped.
  setInterval(() => {
    const ids = db.getTicketIds();
    for (const tid of ids) {
      const t = db.getTicket(tid);
      if (t && t.stage === 'pr_opened' && t.pr_url) startWatching(tid);
    }
  }, INTERVAL); // same cadence as per-ticket checks

  // Expose so the server can trigger an immediate re-check
  // after a manual Address PR action completes.
  return { recheckTicket: checkTicket, startWatching };
}

module.exports = { startPrChecker };
