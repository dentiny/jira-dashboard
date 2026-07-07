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

    const failures = (pr.statusCheckRollup || []).filter(
      s => s.state === 'FAILURE' || s.state === 'ERROR');

    const changeRequested = (pr.reviews || []).filter(
      r => r.state === 'CHANGES_REQUESTED');

    const newComments = (pr.comments || []).filter(c => {
      if (c.isMinimized) return false;
      if (c.author?.login === 'nuro-ci') return false;
      return true;
    });

    if (failures.length === 0 && changeRequested.length === 0 && newComments.length === 0) return;

    const sig = JSON.stringify({ failures, changeRequested, newComments });
    const prev = prStates.get(tid);
    if (prev === sig) return;
    prStates.set(tid, sig);

    const parts = [`PR #${m[1]} needs attention:`];
    for (const f of failures) {
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
    db.updateTicket(tid, { stage: 'clarification', review_feedback: summary, plan: null, status: 'idle' });
    db.logActivity(tid, 'pr_feedback', `Moved to clarification:\n${summary}`);
    sseBroadcast(tid, 'ticket', db.getTicket(tid));
    console.log(`[pr-check] ${tid} moved to clarification — PR #${m[1]} has new activity`);
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
}

module.exports = { startPrChecker };
