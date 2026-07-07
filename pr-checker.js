const { exec } = require('child_process');

function startPrChecker(db, config, sseBroadcast) {
  const INTERVAL = 180_000; // 3 min
  const prStates = new Map(); // ticketId → state hash

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
    if (prev === sig) return;
    prStates.set(tid, sig);

    const addrs = actionableFailures.length + changeRequested.length + newComments.length;
    const parts = [];
    if (addrs === 0) {
      // Only show items (pending + non-actionable) → stay in pr_opened, flag for Address PR
      for (const f of showItems) {
        const link = f.targetUrl ? ` (${f.targetUrl})` : '';
        parts.push(`  • ${f.context} — ${f.state}${link}`);
      }
      const summary = parts.join('\n');
      const header = `PR #${m[1]} has tasks that need attention:\n`;
      db.updateTicket(tid, { review_feedback: header + summary, pr_tasks_only: 1 });
      db.logActivity(tid, 'pr_feedback', `PR tasks set on ${tid}:\n${header}${summary}`);
    } else {
      // Has actionable items → move to clarification
      parts.push(`PR #${m[1]} needs attention:`);
      for (const f of actionableFailures) {
        const link = f.targetUrl ? ` (${f.targetUrl})` : '';
        parts.push(`  • ${f.context} — ${f.state}${link}`);
      }
      for (const f of showItems) {
        const link = f.targetUrl ? ` (${f.targetUrl})` : '';
        parts.push(`  • ${f.context} — ${f.state}${link}`);
      }
      for (const r of changeRequested) {
        parts.push(`  • Review by ${r.author?.login || 'someone'} requests changes`);
      }
      for (const c of newComments) {
        const body = c.body?.replace(/\n/g, ' ').slice(0, 120) || '';
        parts.push(`  • Comment from ${c.author?.login || 'someone'}: "${body}"`);
      }
      const summary = parts.join('\n');
      db.updateTicket(tid, { stage: 'clarification', review_feedback: summary, plan: null, status: 'idle', pr_tasks_only: 0 });
      db.logActivity(tid, 'pr_feedback', `Moved to clarification:\n${summary}`);
    }
    sseBroadcast(tid, 'ticket', db.getTicket(tid));
    console.log(`[pr-check] ${tid} — PR #${m[1]} has new activity`);
  }

  function scheduleAll() {
    const ids = db.getTicketIds();
    let delay = 5_000;
    for (const tid of ids) {
      const t = db.getTicket(tid);
      if (t && t.stage === 'pr_opened' && t.pr_url && /\/pull\/(\d+)/.test(t.pr_url)) {
        const d = delay;
        setTimeout(() => {
          checkTicket(tid);
          setInterval(() => checkTicket(tid), INTERVAL);
        }, d);
        delay += 15_000;
      }
    }
  }

  scheduleAll();

  // Expose so the server can trigger an immediate re-check
  // after a manual Address PR action completes.
  return { recheckTicket: checkTicket };
}

module.exports = { startPrChecker };
