const config = require('./config');
const coder = require('./coder');
const db = require('./db');

const runningProcs = new Map();

function killTicketProcess(ticketId) {
  const proc = runningProcs.get(ticketId);
  if (!proc || proc.pid == null) return false;
  runningProcs.delete(ticketId);
  const pid = proc.pid;
  const signal = (sig) => {
    try { process.kill(-pid, sig); }
    catch { try { proc.kill(sig); } catch {} }
  };
  signal('SIGTERM');
  const t = setTimeout(() => signal('SIGKILL'), 2000);
  if (typeof t.unref === 'function') t.unref();
  return true;
}

function isClosed(ticketId) {
  return db.getTicket(ticketId)?.stage === 'done';
}

function ticketGone(ticketId) {
  const t = db.getTicket(ticketId);
  return !t || t.stage === 'done';
}

async function runCoder(ticketId, prompt, opts = {}) {
  const ticket = db.getTicket(ticketId);
  try {
    const result = await coder.run(prompt, {
      sessionId: ticket?.ocode_session,
      title: `ticket-${ticketId}`,
      timeout: opts.timeout || config.coder.timeouts.clarify,
      onProgress: opts.onProgress,
      cwd: opts.cwd,
      onSpawn: (proc) => runningProcs.set(ticketId, proc),
    });
    if (result.sessionId) {
      db.updateTicketField(ticketId, 'ocode_session', result.sessionId);
    }
    return result;
  } finally {
    runningProcs.delete(ticketId);
  }
}

function captureSessionId(ticketId, sessionId) {
  if (sessionId) {
    db.updateTicketField(ticketId, 'ocode_session', sessionId);
    return sessionId;
  }
  const coderMod = require('./coder');
  const sid = coderMod.getLastSessionId();
  if (sid) {
    db.updateTicketField(ticketId, 'ocode_session', sid);
    return sid;
  }
  return null;
}

module.exports = {
  runningProcs,
  killTicketProcess,
  isClosed,
  ticketGone,
  runCoder,
  captureSessionId,
};
