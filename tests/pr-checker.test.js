// tests/pr-checker.test.js — PR checker unit tests

let assert;
try { assert = require('assert'); } catch { assert = require('node:assert'); }

// ── Module loads and exports ─────────────────────────────
const mod = require('../pr-checker');
assert.ok(mod.startPrChecker, 'startPrChecker exported');
assert.strictEqual(typeof mod.startPrChecker, 'function', 'startPrChecker is a function');
console.log('PASS: module loads and exports startPrChecker');

// ── Function accepts expected signature ──────────────────
const db = {
  getTicketIds: () => [],
  getTicket: () => null,
  updateTicket: () => {},
  logActivity: () => {},
};
const config = { projectDir: '/tmp' };
const sse = () => {};

// Call with empty state — should not crash
mod.startPrChecker(db, config, sse);
console.log('PASS: startPrChecker accepts db, config, sseBroadcast');

console.log('\n✅ All PR checker tests passed');
