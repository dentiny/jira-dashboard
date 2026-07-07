const { exec } = require('child_process');

function startPrChecker(db, config, sseBroadcast, runClarify) {
  const INTERVAL = 180_000; // 3 min
  const prStates = new Map(); // ticketId → state hash
  const watched = new Set();   // ticketIds that have an active setInterval

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

    const isIgnored = (name) => {
      if (!config.prCheckIgnore) return false;
      for (const pattern of config.prCheckIgnore) {
        if (new RegExp(`^${pattern}$`, 'i').test(name)) return true;
      }
      return false;
    };

    // FAILURE/ERROR checks that the coder can address → move to clarification
    const actionableFailures = (pr.statusCheckRollup || []).filter(
      s => (s.state === 'FAILURE' || s.state === 'ERROR') && !isIgnored(s.context));

    // PENDING + non-actionable failures → show but stay in pr_opened (Address PR)
    const showItems = (pr.statusCheckRollup || []).filter(s => {
      if (s.state === 'FAILURE' || s.state === 'ERROR') return isIgnored(s.context);
      if (s.state === 'PENDING') return true;
      return false;
    });

    const changeRequested = (pr.reviews || []).filter(
      r => r.state === 'CHANGES_REQUESTED');

    const ignoredAuthors = (config.prCheckIgnoreAuthors || []).map(a => a.toLowerCase());
    const newComments = (pr.comments || []).filter(c => {
      if (c.isMinimized) return false;
      if (ignoredAuthors.includes((c.author?.login || '').toLowerCase())) return false;
      return true;
    });

    const totalItems = actionableFailures.length + showItems.length + changeRequested.length + newComments.length;
    if (totalItems === 0) {
      if (t.pr_tasks_only) {
        db.updateTicket(tid, { pr_tasks_only: 0, review_feedback: null });
        db.logActivity(tid, 'pr_feedback', `PR #${m[1]} all clear — flags reset`);
        sseBroadcast(tid, 'ticket', db.getTicket(tid));
      }
      return;
    }

    const sig = JSON.stringify({ actionableFailures, showItems, changeRequested, newComments });
    const prev = prStates.get(tid);
    if (prev === sig) {
      db.updateTicketField(tid, 'updated_at', new Date().toISOString());
      return;
    }
    prStates.set(tid, sig);

    const needsMove = actionableFailures.length > 0 || changeRequested.length > 0;
    const parts = [];
    if (!needsMove) {
      // Only show items (pending, non-actionable, comments) → stay in pr_opened, flag for Address PR
      for (const f of showItems) {
        const link = f.targetUrl ? ` (${f.targetUrl})` : '';
        parts.push(`  • ${f.context} — ${f.state}${link}`);
      }
      if (newComments.length > 0) {
        parts.push(`  • ${newComments.length} new comment(s) on the PR`);
      }
      const summary = parts.join('\n');
      const header = `PR #${m[1]} has tasks that need attention:\n`;
      db.updateTicket(tid, { review_feedback: header + summary, pr_tasks_only: 1 });
      db.logActivity(tid, 'pr_feedback', `PR tasks set on ${tid}:\n${header}${summary}`);
    } else {
      // Has actionable failures or change requests → move to clarification
      const summaryParts = [`PR #${m[1]} — actionable failures to fix (code may need changes):`];
      for (const f of actionableFailures) {
        const link = f.targetUrl ? ` (${f.targetUrl})` : '';
        summaryParts.push(`  • ${f.context} — ${f.state}${link}`);
      }
      if (changeRequested.length > 0) {
        summaryParts.push('');
        summaryParts.push(`Changes requested on the PR (address via code changes if applicable):`);
        for (const r of changeRequested) {
          summaryParts.push(`  • Review by ${r.author?.login || 'someone'} requests changes`);
        }
      }
      summaryParts.push('');
      summaryParts.push(`IGNORE the following — they are pending, non-actionable, or outside code scope:`);
      for (const f of showItems) {
        summaryParts.push(`  • ${f.context} — ${f.state} (ignore)`);
      }
      if (newComments.length > 0) {
        summaryParts.push(`  • Comments on the PR (ignore — review them manually)`);
      }
      const summary = summaryParts.join('\n');
      // Preserve previous Q&A history in feedback before clearing
      const prevQA = db.getTicket(tid)?.questions || [];
      const qaText = prevQA.map((q, i) => `Q: ${q.question}\nA: ${q.answer || '(unanswered)'}`).join('\n\n');
      const fullFeedback = qaText ? `Previous Q&A:\n${qaText}\n\n---\n\n${summary}` : summary;
      db.deleteQuestionsForTicket(tid);
      db.updateTicket(tid, { stage: 'clarification', review_feedback: fullFeedback, plan: null, status: 'idle', pr_tasks_only: 0 });
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

  scheduleAll();

  // Expose so the server can trigger an immediate re-check
  // after a manual Address PR action completes.
  return { recheckTicket: checkTicket, startWatching };
}

module.exports = { startPrChecker };
