const path = require('path');
const fs = require('fs');
const config = require('./config');

function writeTicketContext(ticketId, sections) {
  const dir = config.ticketContextDir(ticketId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'context.md');
  const header = `# Ticket context: ${ticketId}\n\n_Generated ${new Date().toISOString()} by jira-dashboard._\n\n`;
  const body = sections
    .filter(s => s && s.body && String(s.body).trim().length > 0)
    .map(s => `## ${s.title}\n\n${s.body}\n`)
    .join('\n');
  fs.writeFileSync(file, header + body);
  return file;
}

module.exports = { writeTicketContext };
