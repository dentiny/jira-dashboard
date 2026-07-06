const sseClients = new Map();

function sseBroadcast(ticketId, event, data) {
  const clients = sseClients.get(ticketId);
  if (!clients) return;
  const payload = `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

module.exports = { sseClients, sseBroadcast };
