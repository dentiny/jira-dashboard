const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

const STAGES = ['clarification', 'implementation', 'review', 'ready', 'done'];
const STAGE_LABELS = {
  clarification: 'Clarification',
  implementation: 'Implementation',
  review: 'Review',
  ready: 'Ready',
  done: 'Done'
};

let ticketsCache = [];
let currentTicketId = null;
let _pollTimer = null;
let _lastUpdated = null;

// ── Board ─────────────────────────────────────────────────
async function loadBoard() {
  try {
    const res = await fetch('/api/tickets');
    const data = await res.json();
    ticketsCache = data.tickets;
    renderBoard(data);
  } catch (e) {
    console.error('Failed to load board', e);
  }
}

function renderBoard(data) {
  const board = $('#board');
  board.innerHTML = '';

  STAGES.forEach(stage => {
    const stageTickets = ticketsCache.filter(t => t.stage === stage);
    const section = document.createElement('section');
    section.className = 'stage-section';

    section.innerHTML = `
      <div class="stage-header">
        <h3>${STAGE_LABELS[stage]}</h3>
        <span class="stage-count">${stageTickets.length}</span>
      </div>
    `;

    const cardsContainer = document.createElement('div');
    cardsContainer.className = 'stage-cards';

    if (stageTickets.length === 0) {
      cardsContainer.innerHTML = '<div class="stage-empty">No tickets</div>';
    } else {
      stageTickets.forEach(t => {
        const card = document.createElement('div');
        card.className = 'card';
        card.onclick = () => openTicket(t.id);
        const running = t.status === 'running';
        card.innerHTML = `
          <div class="card-id">${t.id}</div>
          <div class="card-title">${running ? '<span class="spinner" style="width:12px;height:12px;border-width:2px;margin-right:4px;"></span>' : ''}${esc(t.title)}</div>
          <div class="card-meta">
            <span>${timeAgo(t.updated_at)}</span>
            ${t.questions?.length ? `<span class="card-qa">${t.questions.length} Q&As</span>` : ''}
          </div>
        `;
        cardsContainer.appendChild(card);
      });
    }

    section.appendChild(cardsContainer);
    board.appendChild(section);
  });
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function timeAgo(dt) {
  const diff = (Date.now() - new Date(dt).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff/60) + 'm ago';
  if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
  return Math.floor(diff/86400) + 'd ago';
}

// ── Modals ────────────────────────────────────────────────
function showModal(id) { $(`#${id}`).style.display = 'flex'; }
function closeModal(id) {
  $(`#${id}`).style.display = 'none';
  if (id === 'ticketModal') {
    clearTicketHash();
    stopPolling();
  }
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(t._timeout);
  t._timeout = setTimeout(() => t.style.display = 'none', 3500);
}

// ── Create Ticket ─────────────────────────────────────────
async function createTicket() {
  const title = $('#newTitle').value.trim();
  const content = $('#newContent').value.trim();
  if (!title) {
    $('#newTicketError').textContent = 'Title is required';
    $('#newTicketError').style.display = 'block';
    return;
  }

  const btn = document.querySelector('.new-ticket-row .btn-primary');
  btn.disabled = true;
  btn.textContent = 'Creating…';

  try {
    const res = await fetch('/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content })
    });
    if (!res.ok) throw new Error((await res.json()).error);
    const ticket = await res.json();
    $('#newTitle').value = '';
    $('#newContent').value = '';
    $('#newTicketError').style.display = 'none';
    currentTicketId = ticket.id;
    showModal('ticketModal');
    showClarifying(ticket);
    const clarified = await runClarification(ticket.id);
    if (clarified) {
      // clarified immediately (unlikely but handle)
      openTicket(ticket.id);
    } else {
      openTicket(ticket.id);
    }
  } catch (err) {
    $('#newTicketError').textContent = err.message;
    $('#newTicketError').style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Ticket';
  }
}

// ── Ticket Detail ─────────────────────────────────────────
async function openTicket(id) {
  currentTicketId = id;
  setTicketHash(id);
  try {
    const res = await fetch(`/api/tickets/${id}`);
    if (!res.ok) throw new Error('Ticket not found');
    const ticket = await res.json();
    _lastUpdated = ticket.updated_at;

    // Auto-drive workflow: if implementation stage + idle + has plan + never attempted
    const alreadyTried = (ticket.activity || []).some(a => a.action === 'implement_start' || a.action === 'implement_done');
    if (ticket.stage === 'implementation' && ticket.status !== 'running' && ticket.plan && !alreadyTried) {
      showModal('ticketModal');
      showImplementing(ticket);
      startPolling();
      startImplementation(id);
      return;
    }

    renderTicket(ticket);
    showModal('ticketModal');
    startPolling();
  } catch (err) {
    toast('Error loading ticket');
  }
}

function startPolling() {
  stopPolling();
  _pollTimer = setInterval(pollTicket, 2000);
}

function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

async function pollTicket() {
  if (!currentTicketId) return;
  try {
    const res = await fetch(`/api/tickets/${currentTicketId}`);
    if (!res.ok) return;
    const ticket = await res.json();
    if (ticket.updated_at === _lastUpdated) return;

    // Full re-render on stage change, silent on same stage
    const currentStage = document.querySelector('.stage-badge')?.textContent?.trim();
    if (currentStage && currentStage !== STAGE_LABELS[ticket.stage]) {
      renderTicket(ticket);
    } else {
      // Preserve input values for same-stage silent update
      const savedAnswers = {};
      $$('[id^="answer-"]').forEach(inp => { savedAnswers[inp.id] = inp.value; });
      renderTicket(ticket, true);
      for (const [id, val] of Object.entries(savedAnswers)) {
        const inp = document.getElementById(id);
        if (inp) inp.value = val;
      }
    }
    _lastUpdated = ticket.updated_at;
  } catch { /* best-effort */ }
}

function renderTicket(ticket, silent) {
  const badgeClass = 'badge-' + ticket.stage;

  // Only update title on full render (silent polls skip title to preserve copy-link)
  if (!silent || ticket.status !== 'running') {
    $('#ticketTitle').innerHTML = `
      <span style="color:var(--text3);font-size:0.75rem;font-family:monospace;">${ticket.id}</span>
      <br>${esc(ticket.title)}
      <div style="margin-top:6px;">
        <button class="btn-ghost btn-sm" onclick="copyTicketUrl('${ticket.id}')" style="font-size:0.72rem;padding:3px 10px;" title="Copy deep link">Copy link</button>
      </div>
    `;
  }

  let body = '<div class="ticket-layout"><div class="ticket-main">';
  body += `<p class="ticket-content">${esc(ticket.content)}</p>`;
  body += `<span class="stage-badge ${badgeClass}">${STAGE_LABELS[ticket.stage]}</span>`;

  // ── Clarification ──
  if (ticket.stage === 'clarification') {
    if (ticket.review_feedback) {
      body += `<div class="feedback-box">Review feedback: ${esc(ticket.review_feedback)}</div>`;
    }

    if (ticket.questions && ticket.questions.length > 0) {
      body += '<div class="qa-section">';
      const rounds = [...new Set(ticket.questions.map(q => q.round))];
      rounds.forEach(round => {
        body += `<div class="qa-round-label">Round ${round}</div>`;
        ticket.questions.filter(q => q.round === round).forEach(q => {
          body += '<div class="qa-item">';
          body += `<div class="qa-question">${esc(q.question)}</div>`;
          if (q.answer) {
            body += `<div class="qa-answer">${esc(q.answer)}</div>`;
          } else {
            body += `<div class="qa-input"><input type="text" id="answer-${q.id}" placeholder="Your answer (optional)…" /></div>`;
          }
          body += '</div>';
        });
      });
      body += '</div>';
    }

    const allAnswered = ticket.questions && ticket.questions.length > 0 && ticket.questions.every(q => q.answer);
    const hasUnanswered = ticket.questions && ticket.questions.some(q => !q.answer);

    $('#ticketFooter').innerHTML = `
      ${!ticket.questions?.length ? `<button class="btn btn-ghost btn-sm" onclick="startClarification('${ticket.id}')">Retry</button>` : ''}
      ${hasUnanswered ? `<button class="btn btn-primary btn-sm" onclick="submitAnswers()">Submit Answers (partial OK)</button>` : ''}
      ${allAnswered ? `<button class="btn btn-primary btn-sm" onclick="submitAnswers()">Process Answers</button>` : ''}
    `;
  }

  // ── Implementation ──
  if (ticket.stage === 'implementation') {
    if (ticket.plan) {
      body += '<h4 style="font-size:0.82rem;color:var(--text2);margin:12px 0 4px;">Implementation Plan</h4>';
      body += `<div class="plan-box">${esc(ticket.plan)}</div>`;
    }

    if (ticket.status === 'running') {
      body += '<div class="status-bar"><span class="spinner"></span> Implementing…</div>';
      // Resource usage — visual gauges
      const resources = (ticket.activity || []).filter(a => a.action === 'resource');
      if (resources.length) {
        const latest = resources[0].detail;
        // Parse: cpu=12.3s mem=580.6MB threads=26 elapsed=102s tokens=15,234
        const p = Object.fromEntries(latest.split(' ').map(s => s.split('=')));
        const cpu = parseFloat(p.cpu) || 0;
        const mem = parseFloat(p.mem) || 0;
        const elapsed = parseInt(p.elapsed) || 1;
        const cores = parseInt(p.ncores) || 8;
        // Recent window: CPU utilization over last interval (not lifetime average)
        let recentCores = 0;
        if (resources.length > 1) {
          const prev = Object.fromEntries(resources[1].detail.split(' ').map(s => s.split('=')));
          const prevCpu = parseFloat(prev.cpu) || 0;
          const prevElapsed = parseInt(prev.elapsed) || 0;
          recentCores = prevElapsed ? (cpu - prevCpu) / (elapsed - prevElapsed) : 0;
        }
        const avgCores = (cpu / elapsed).toFixed(2);
        const recentPct = Math.min(recentCores / cores * 100, 100);
        // Memory watermark: track peak RSS across all resource snapshots
        const allMem = resources.map(r => parseFloat(r.detail.split(' ').find(s => s.startsWith('mem='))?.split('=')[1]) || 0);
        const peakMem = Math.max(...allMem, mem);
        body += '<div class="metrics">';
        body += '<div class="metric"><div class="metric-label">CPU</div><div class="metric-val" style="min-width:auto;flex:0;margin-right:8px;">' + (p.cpu || '--') + '</div><div class="metric-bar"><div class="metric-fill" style="width:' + recentPct + '%"></div></div><div class="metric-val" style="min-width:80px;">' + (recentCores > 0 ? recentCores.toFixed(1) + '/' + cores + ' c' : avgCores + '/' + cores + ' c') + '</div></div>';
        body += '<div class="metric"><div class="metric-label">Memory</div><div class="metric-val" style="min-width:auto;flex:0;margin-right:8px;">' + mem.toFixed(0) + ' MB</div><div class="metric-bar"><div class="metric-fill" style="width:' + (peakMem ? (mem / peakMem * 100) : 0) + '%"></div></div><div class="metric-val" style="min-width:50px;">peak ' + peakMem.toFixed(0) + ' MB</div></div>';
        body += '<div class="metrics-info"><span>Threads: ' + (p.threads || '--') + '</span><span>Elapsed: ' + (parseInt(p.elapsed) || '--') + 's</span>';
        if (p.tokens_in) body += '<span>Tokens: ' + p.tokens_in + ' in / ' + (p.tokens_out || '--') + ' out</span>';
        if (p.cost) body += '<span>Cost: ' + p.cost + '</span>';
        body += '</div></div>';
      }
      // Files changed
      const filesChanged = (ticket.activity || []).filter(a => a.action === 'file_changed');
      if (filesChanged.length) {
        body += '<div class="activity-log"><h4>Files modified (' + filesChanged.length + ')</h4>';
        filesChanged.slice(0, 10).forEach(a => {
          body += `<div class="activity-item" style="font-size:0.7rem;font-family:monospace;">${esc(a.detail)}</div>`;
        });
        body += '</div>';
      }
      $('#ticketFooter').innerHTML = `
        <span style="font-size:0.75rem;color:var(--text3);padding:8px;">Running… check back soon</span>
      `;
    } else {
      body += '<div class="status-bar">Ready to implement based on the plan above.</div>';
      $('#ticketFooter').innerHTML = `
        <button class="btn btn-success btn-sm" onclick="startImplementation('${ticket.id}')">Start Implementation</button>
      `;
    }
  }

  // ── Review ──
  if (ticket.stage === 'review') {
    if (ticket.worktree_path) {
      body += `<div class="status-bar">Worktree: <code>${esc(ticket.worktree_path)}</code></div>`;
      body += `<div class="status-bar">Branch: <code>${esc(ticket.branch_name)}</code></div>`;

      // Post-implementation resource summary
      const resources = (ticket.activity || []).filter(a => a.action === 'resource');
      if (resources.length) {
        const last = resources[0].detail;
        const p = Object.fromEntries(last.split(' ').map(s => s.split('=')));
        body += '<div class="metrics">';
        body += '<div class="metrics-info"><span>Total CPU: ' + (parseFloat(p.cpu) || '--') + 's</span><span>Peak memory: ' + (parseFloat(p.mem) || '--') + ' MB</span><span>Total time: ' + (parseInt(p.elapsed) || '--') + 's</span></div>';
        if (p.tokens_in) body += '<div class="metrics-info" style="border-top:none;margin-top:0;padding-top:0;"><span>Tokens: ' + p.tokens_in + ' in / ' + (p.tokens_out || '--') + ' out</span>' + (p.cost ? '<span>Cost: ' + p.cost + '</span>' : '') + '</div>';
        body += '</div>';
      }

      body += '<div class="editor-links">';
      body += `<a class="editor-link" href="vscode://vscode-remote/ssh-remote+cutuy-claw${esc(ticket.worktree_path)}" target="_blank">Open in VSCode</a>`;
      body += `<a class="editor-link" href="cursor://ssh-remote+cutuy-claw${esc(ticket.worktree_path)}" target="_blank">Open in Cursor</a>`;
      body += '</div>';
      body += `<button class="btn btn-ghost btn-sm" onclick="loadDiff('${ticket.id}')" style="margin-top:4px;">View Diff</button>`;
      body += '<div id="diffContainer"></div>';
    }

    $('#ticketFooter').innerHTML = `
      <button class="btn btn-ghost btn-sm" onclick="moveToImpl('${ticket.id}')">Continue</button>
      <button class="btn btn-success btn-sm" onclick="markReady('${ticket.id}')">Ready → Cherry-pick</button>
    `;

    // Always-show feedback box
    body += `
      <div id="feedbackForm" style="margin-top:12px;">
        <textarea id="feedbackText" rows="2" placeholder="Feedback (optional) — sends ticket back to clarification" style="width:100%;"></textarea>
        <div style="display:flex;gap:8px;margin-top:6px;">
          <button class="btn btn-warn btn-sm" onclick="submitFeedback('${ticket.id}')">Send Feedback</button>
        </div>
      </div>
    `;
  }

  // ── Done ──
  if (ticket.stage === 'done') {
    body += `<div class="success-msg">Merged into main · Commit: <code>${esc(ticket.commit_sha || 'N/A')}</code></div>`;

    // Show Q&A if any
    if (ticket.questions && ticket.questions.length > 0) {
      body += '<div class="qa-section">';
      const rounds = [...new Set(ticket.questions.map(q => q.round))];
      rounds.forEach(round => {
        body += `<div class="qa-round-label">Round ${round}</div>`;
        ticket.questions.filter(q => q.round === round).forEach(q => {
          body += '<div class="qa-item">';
          body += `<div class="qa-question">${esc(q.question)}</div>`;
          if (q.answer) body += `<div class="qa-answer">${esc(q.answer)}</div>`;
          body += '</div>';
        });
      });
      body += '</div>';
    }

    // Show implementation plan if any
    if (ticket.plan) {
      body += '<h4 style="font-size:0.82rem;color:var(--text2);margin:12px 0 4px;">Implementation Plan</h4>';
      body += `<div class="plan-box">${esc(ticket.plan)}</div>`;
    }

    $('#ticketFooter').innerHTML = `
      <button class="btn btn-danger btn-sm" onclick="deleteTicket('${ticket.id}')">Delete</button>
    `;
  }

  body += '</div>'; // close ticket-main

  // Activity sidebar — click to expand detail
  if (ticket.activity && ticket.activity.length > 0) {
    const visible = ticket.activity.filter(a => a.action !== 'resource' && a.action !== 'file_changed');
    if (visible.length > 0) {
      body += '<div class="activity-sidebar"><h4>Activity</h4>';
      visible.slice(0, 30).forEach(a => {
        const hasDetail = a.detail && a.detail.length > 0;
        const shortDetail = hasDetail ? a.detail.slice(0, 80) : '';
        body += `<div class="activity-row" onclick="this.classList.toggle('expanded')">`;
        body += `<span class="activity-time">${timeAgo(a.time)}</span>`;
        body += `<span class="activity-action">${esc(a.action)}</span>`;
        if (hasDetail) body += `<span class="activity-detail">${esc(shortDetail)}${a.detail.length > 80 ? '…' : ''}</span>`;
        body += '</div>';
      });
      body += '</div>';
    }
  }

  body += '</div>'; // close ticket-layout

  $('#ticketBody').innerHTML = body;
}

function showImplementing(ticket) {
  $('#ticketTitle').innerHTML = `
    <span style="color:var(--text3);font-size:0.75rem;font-family:monospace;">${ticket.id}</span>
    <br>${esc(ticket.title)}
    <div style="margin-top:6px;">
      <button class="btn-ghost btn-sm" onclick="copyTicketUrl('${ticket.id}')" style="font-size:0.72rem;padding:3px 10px;" title="Copy deep link">Copy link</button>
    </div>
  `;
  $('#ticketBody').innerHTML = `
    <p class="ticket-content">${esc(ticket.content)}</p>
    <span class="stage-badge badge-implementation">Implementation</span>
    <div class="status-bar"><span class="spinner"></span> Starting implementation…</div>
  `;
  $('#ticketFooter').innerHTML = '';
}

function showClarifying(ticket) {
  $('#ticketTitle').innerHTML = `
    <span style="color:var(--text3);font-size:0.75rem;font-family:monospace;">${ticket.id}</span>
    <br>${esc(ticket.title)}
    <div style="margin-top:6px;">
      <button class="btn-ghost btn-sm" onclick="copyTicketUrl('${ticket.id}')" style="font-size:0.72rem;padding:3px 10px;" title="Copy deep link">Copy link</button>
    </div>
  `;
  $('#ticketBody').innerHTML = `
    <p class="ticket-content">${esc(ticket.content)}</p>
    <span class="stage-badge badge-clarification">Clarification</span>
    <div class="status-bar"><span class="spinner"></span> OpenCode is analyzing the codebase…</div>
  `;
  $('#ticketFooter').innerHTML = '';
}

async function runClarification(id) {
  try {
    const res = await fetch(`/api/tickets/${id}/clarify`, { method: 'POST' });
    if (!res.ok) throw new Error((await res.json()).error);
    const ticket = await res.json();
    await loadBoard();
    return false; // questions returned, not yet clarified
  } catch (err) {
    toast('OpenCode error: ' + err.message);
    await loadBoard();
    return false;
  }
}

async function startClarification(id) {
  showModal('ticketModal');
  const res = await fetch(`/api/tickets/${id}`);
  const ticket = await res.json();
  currentTicketId = id;
  showClarifying(ticket);
  await runClarification(id);
  openTicket(id);
}

async function submitAnswers() {
  const answers = {};

  // Collect from input fields (newly typed answers)
  $$('[id^="answer-"]').forEach(inp => {
    if (inp.value.trim()) answers[inp.id.replace('answer-', '')] = inp.value.trim();
  });

  // If no new inputs, fall back to all saved answers (re-processing case)
  if (Object.keys(answers).length === 0) {
    const ticket = ticketsCache.find(t => t.id === currentTicketId);
    const saved = (ticket?.questions || []).filter(q => q.answer);
    if (saved.length === 0) {
      toast('Please answer at least one question');
      return;
    }
    saved.forEach(q => { answers[q.id] = q.answer; });
  }

  $('#ticketFooter').innerHTML = '<div style="padding:12px 24px;"><span class="spinner"></span> Processing…</div>';
  try {
    const res = await fetch(`/api/tickets/${currentTicketId}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers })
    });
    if (!res.ok) throw new Error((await res.json()).error);
    const data = await res.json();

    if (data.clarified) {
      // Auto-trigger implementation
      currentTicketId = data.ticket.id;
      showModal('ticketModal');
      showImplementing(data.ticket);
      startImplementation(currentTicketId);
    } else {
      renderTicket(data);
      toast('More clarification needed — please answer the new questions');
    }
  } catch (err) {
    toast('Error: ' + err.message);
  }
  await loadBoard();
}

async function startImplementation(id) {
  $('#ticketFooter').innerHTML = '<div style="padding:12px 24px;"><span class="spinner"></span> OpenCode implementing… (may take several minutes)</div>';
  try {
    const res = await fetch(`/api/tickets/${id}/implement`, { method: 'POST' });
    if (!res.ok) throw new Error((await res.json()).error);
    const data = await res.json();
    toast('Implementation done — ready for review');
    renderTicket(data.ticket);
  } catch (err) {
    toast('Error: ' + err.message);
  }
  await loadBoard();
}

async function loadDiff(id) {
  const container = $('#diffContainer');
  container.innerHTML = '<span class="spinner"></span> Loading diff…';
  try {
    const res = await fetch(`/api/tickets/${id}/diff`);
    const data = await res.json();
    container.innerHTML = `<div class="diff-box">${esc(data.diff)}</div>`;
  } catch {
    container.innerHTML = '<div class="error">Failed to load diff</div>';
  }
}

function showOutputModal(title, success, output) {
  $('#outputTitle').textContent = title;
  if (success === null) {
    $('#outputBody').innerHTML = output;
  } else {
    $('#outputBody').innerHTML = `
      <div class="${success ? 'success-msg' : 'error'}" style="margin-bottom:10px;">${success ? 'Passed' : 'Failed'}</div>
      <div class="diff-box">${esc(output)}</div>
    `;
  }
  showModal('outputModal');
}

async function runGlobalTest() {
  const btn = document.querySelector('.header-inner .btn-ghost:nth-child(1)');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> Testing…';
  showOutputModal('Test Results', null, '<span class="spinner"></span> Running unit tests…');
  try {
    const res = await fetch('/api/test', { method: 'POST' });
    const { runId } = await res.json();
    await streamRun(runId, 'Test Results');
  } catch (err) {
    $('#outputBody').innerHTML = `<div class="error">Error: ${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run Tests';
  }
}

async function runGlobalPrepush() {
  const btn = document.querySelector('.header-inner .btn-ghost:nth-child(2)');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> Checking…';
  showOutputModal('Pre-push Check Results', null, '<span class="spinner"></span> Running pre-push checks… (may take a minute)');
  try {
    const res = await fetch('/api/prepush', { method: 'POST' });
    const { runId } = await res.json();
    await streamRun(runId, 'Pre-push Check Results');
  } catch (err) {
    $('#outputBody').innerHTML = `<div class="error">Error: ${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Pre-push Check';
  }
}

async function streamRun(runId, title) {
  let lastLen = 0;
  const poll = async () => {
    try {
      const res = await fetch(`/api/run/${runId}`);
      const data = await res.json();
      const output = data.output || '';
      if (output.length > lastLen || data.status !== 'running') {
        lastLen = output.length;
        $('#outputBody').innerHTML = `
          <div class="${data.status === 'pass' ? 'success-msg' : data.status === 'fail' ? 'error' : ''}" style="margin-bottom:10px;">${data.status === 'pass' ? 'Passed' : data.status === 'fail' ? 'Failed' : '<span class="spinner"></span> Running…'}</div>
          <div class="diff-box">${esc(output)}</div>
        `;
      }
      if (data.status === 'running') setTimeout(poll, 500);
    } catch {
      setTimeout(poll, 1000);
    }
  };
  poll();
}

async function moveToImpl(id) {
  const res = await fetch(`/api/tickets/${id}`);
  const ticket = await res.json();
  showImplementing(ticket);
  startImplementation(id);
}

function showFeedbackForm(id) {
  const form = $('#feedbackForm');
  if (form) {
    form.style.display = 'block';
    $('#feedbackText').focus();
  }
}

async function submitFeedback(id) {
  const feedback = $('#feedbackText').value.trim();
  if (!feedback) return;

  $('#feedbackText').value = '';
  document.getElementById('feedbackForm').style.display = 'none';
  $('#ticketFooter').innerHTML = '<div style="padding:12px 24px;"><span class="spinner"></span> Sending…</div>';
  try {
    const res = await fetch(`/api/tickets/${id}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback })
    });
    if (!res.ok) throw new Error((await res.json()).error);
    const data = await res.json();
    showClarifying(data.ticket);
    await runClarification(data.ticket.id);
    openTicket(data.ticket.id);
  } catch (err) {
    toast('Error: ' + err.message);
  }
  await loadBoard();
}

async function markReady(id) {
  if (!confirm('Commit, cherry-pick into main, and close this ticket?')) return;

  $('#ticketFooter').innerHTML = '<div style="padding:12px 24px;"><span class="spinner"></span> Cherry-picking…</div>';
  try {
    const res = await fetch(`/api/tickets/${id}/ready`, { method: 'POST' });
    if (!res.ok) throw new Error((await res.json()).error);
    const data = await res.json();
    if (data.commit_sha) {
      toast('Merged · ' + data.commit_sha.slice(0, 7));
    } else {
      toast('Closed — no changes to merge');
    }
    renderTicket(data.ticket);
  } catch (err) {
    toast('Error: ' + err.message);
  }
  await loadBoard();
}

async function deleteTicket(id) {
  if (!confirm('Delete this ticket permanently?')) return;
  try {
    await fetch(`/api/tickets/${id}`, { method: 'DELETE' });
    toast('Ticket deleted');
    closeModal('ticketModal');
  } catch (err) {
    toast('Error: ' + err.message);
  }
  await loadBoard();
}

// ── Deep link routing ─────────────────────────────────────
function getTicketFromHash() {
  const m = location.hash.match(/^#ticket\/(.+)$/);
  return m ? m[1] : null;
}

function setTicketHash(id) {
  if (location.hash !== '#ticket/' + id) {
    history.replaceState(null, '', '#ticket/' + id);
  }
}

function clearTicketHash() {
  if (location.hash.startsWith('#ticket/')) {
    history.replaceState(null, '', ' ');
  }
}

async function copyTicketUrl(id) {
  const url = location.origin + location.pathname + '#ticket/' + id;
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied');
  } catch {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast('Link copied');
  }
}

// ── Boot ──────────────────────────────────────────────────
(async function boot() {
  await loadBoard();
  const ticketId = getTicketFromHash();
  if (ticketId) {
    openTicket(ticketId);
  }
})();

setInterval(loadBoard, 10000);

window.addEventListener('hashchange', () => {
  const ticketId = getTicketFromHash();
  if (ticketId) {
    openTicket(ticketId);
  } else {
    closeModal('ticketModal');
    stopPolling();
  }
});

document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.style.display = 'none';
    clearTicketHash();
  }
});
