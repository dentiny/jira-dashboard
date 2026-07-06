const crypto = require('crypto');

const PREPUSH_RUN_PREFIX = 'prepush-';
const TEST_RUN_PREFIX = 'test-';

const STAGE_LABELS = {
  clarification: 'Clarification',
  implementation: 'Implementation',
  review: 'Review',
  ready: 'Ready',
  done: 'Done'
};

function uid() {
  return crypto.randomBytes(6).toString('hex');
}

function slugFromTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/-$/, '');
}

function ticketId(title) {
  const slug = slugFromTitle(title);
  const suffix = crypto.randomBytes(3).toString('hex');
  return slug ? `${slug}-${suffix}` : suffix;
}

function formatPlanText(plan) {
  if (!plan) return '';
  const extract = (obj) =>
    obj.plan || obj.description || obj.summary
    || (typeof obj.text === 'string' ? obj.text : null)
    || (typeof obj.content === 'string' ? obj.content : null)
    || (typeof obj.message === 'string' ? obj.message : null)
    || '';
  if (typeof plan === 'object') return extract(plan);
  if (typeof plan === 'string') {
    try {
      const parsed = JSON.parse(plan);
      if (typeof parsed === 'string') return parsed;
      return extract(parsed);
    } catch {
      return plan;
    }
  }
  return String(plan);
}

function escShell(str) {
  return str.replace(/[\\'"$`]/g, '\\$&');
}

module.exports = {
  PREPUSH_RUN_PREFIX,
  TEST_RUN_PREFIX,
  STAGE_LABELS,
  uid,
  slugFromTitle,
  ticketId,
  formatPlanText,
  escShell,
};
