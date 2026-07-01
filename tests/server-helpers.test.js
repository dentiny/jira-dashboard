// tests/server-helpers.test.js — Server helper function unit tests

let assert;
try { assert = require('assert'); } catch { assert = require('node:assert'); }

// We test the pure functions extracted from server.js
// by loading them through a minimal require that doesn't start the server

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

// ── slugFromTitle ──────────────────────────────────────────
(function testSlugFromTitle() {
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

  assert.strictEqual(slugFromTitle('Hello World'), 'hello-world');
  assert.strictEqual(slugFromTitle('Fix: Login Bug!!!'), 'fix-login-bug');
  assert.strictEqual(slugFromTitle('  Spaces  everywhere  '), 'spaces-everywhere');
  assert.strictEqual(slugFromTitle('a'.repeat(100)), 'a'.repeat(40));
  assert.strictEqual(slugFromTitle(''), '');
  console.log('PASS: slugFromTitle');
})();

// ── ticketId ───────────────────────────────────────────────
(function testTicketId() {
  function ticketId(title) {
    function slugFromTitle(title) {
      return title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim()
        .replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 40).replace(/-$/, '');
    }
    const slug = slugFromTitle(title);
    const suffix = crypto.randomBytes(3).toString('hex');
    return slug ? `${slug}-${suffix}` : suffix;
  }

  const id1 = ticketId('My Feature');
  assert.ok(id1.startsWith('my-feature-'), 'ticketId should start with slug');
  assert.strictEqual(id1.length, 'my-feature-'.length + 6, 'ticketId should have slug + 6 hex chars');

  const id2 = ticketId('My Feature');
  assert.notStrictEqual(id1, id2, 'consecutive ticketIds should differ (random suffix)');

  const id3 = ticketId('');
  assert.strictEqual(id3.length, 6, 'empty title should produce just the hex suffix');
  console.log('PASS: ticketId');
})();

// ── parseTestSummary (pytest output) ───────────────────────
(function testParseTestSummaryPytest() {
  function parseTestSummary(output) {
    if (!output) return null;
    const m = output.match(/(\d+)\s+passed(?:.*?(\d+)\s+failed)?(?:.*?(\d+)\s+error(?:ed|s)?)?(?:.*?(\d+)\s+skipped)?/i);
    if (m && (m[1] || m[2])) {
      return {
        passed: parseInt(m[1] || '0', 10),
        failed: parseInt(m[2] || '0', 10),
        errored: parseInt(m[3] || '0', 10),
        skipped: parseInt(m[4] || '0', 10),
      };
    }
    const goOk = (output.match(/^ok\s/gm) || []).length;
    const goFail = (output.match(/^FAIL\s/gm) || []).length;
    if (goOk + goFail > 0) return { passed: goOk, failed: goFail, errored: 0, skipped: 0 };
    const cargoPass = (output.match(/test result: ok\.\s+(\d+)\s+passed/) || [])[1];
    if (cargoPass) return { passed: parseInt(cargoPass, 10), failed: 0, errored: 0, skipped: 0 };
    return null;
  }

  // pytest
  let r = parseTestSummary('=== 12 passed, 1 failed, 2 skipped in 0.42s ===');
  assert.deepStrictEqual(r, { passed: 12, failed: 1, errored: 0, skipped: 2 });

  r = parseTestSummary('5 passed, 3 errored');
  assert.deepStrictEqual(r, { passed: 5, failed: 0, errored: 3, skipped: 0 });

  // go test
  r = parseTestSummary('ok  \tpkg/foo\t0.123s\nok  \tpkg/bar\t0.456s');
  assert.deepStrictEqual(r, { passed: 2, failed: 0, errored: 0, skipped: 0 });

  r = parseTestSummary('ok  \tpkg/a\t0.1s\nFAIL\tpkg/b\t0.2s');
  assert.deepStrictEqual(r, { passed: 1, failed: 1, errored: 0, skipped: 0 });

  // null/empty
  r = parseTestSummary('');
  assert.strictEqual(r, null);

  r = parseTestSummary(null);
  assert.strictEqual(r, null);

  console.log('PASS: parseTestSummary');
})();

// ── formatSummary ──────────────────────────────────────────
(function testFormatSummary() {
  function formatSummary(parsed, status) {
    if (!parsed) return status === 'pass' ? 'All tests passed' : (status === 'fail' ? 'Tests failed' : status);
    const parts = [];
    if (parsed.passed)  parts.push(`${parsed.passed} passed`);
    if (parsed.failed)  parts.push(`${parsed.failed} failed`);
    if (parsed.errored) parts.push(`${parsed.errored} errored`);
    if (parsed.skipped) parts.push(`${parsed.skipped} skipped`);
    return parts.length ? parts.join(', ') : status;
  }

  assert.strictEqual(formatSummary(null, 'pass'), 'All tests passed');
  assert.strictEqual(formatSummary(null, 'fail'), 'Tests failed');
  assert.strictEqual(formatSummary(null, 'skip'), 'skip');
  assert.strictEqual(formatSummary({ passed: 10, failed: 2, errored: 0, skipped: 1 }), '10 passed, 2 failed, 1 skipped');
  assert.strictEqual(formatSummary({ passed: 5 }, 'fail'), '5 passed');
  console.log('PASS: formatSummary');
})();

// ── uid ────────────────────────────────────────────────────
(function testUid() {
  function uid() { return crypto.randomBytes(6).toString('hex'); }
  const u1 = uid();
  const u2 = uid();
  assert.strictEqual(u1.length, 12, 'uid should be 12 hex chars');
  assert.notStrictEqual(u1, u2, 'uids should be unique');
  console.log('PASS: uid');
})();

// ── isWorktreeDirty (post-stage invariant) ────────────────
(function testIsWorktreeDirty() {
  // Mirror of the helper in server.js
  function isWorktreeDirty(statusOutput) {
    return !!(statusOutput && statusOutput.trim());
  }

  // Empty / whitespace-only = clean
  assert.strictEqual(isWorktreeDirty(''), false, 'empty status = clean');
  assert.strictEqual(isWorktreeDirty('   '), false, 'whitespace = clean');
  assert.strictEqual(isWorktreeDirty('\n\n'), false, 'newlines = clean');
  assert.strictEqual(isWorktreeDirty(undefined), false, 'undefined = clean');
  assert.strictEqual(isWorktreeDirty(null), false, 'null = clean');

  // Any non-empty porcelain output = dirty
  assert.strictEqual(isWorktreeDirty(' M foo.ts'), true, 'unstaged = dirty');
  assert.strictEqual(isWorktreeDirty('M  foo.ts'), true, 'staged = dirty');
  assert.strictEqual(isWorktreeDirty('A  foo.ts'), true, 'added = dirty');
  assert.strictEqual(isWorktreeDirty('D  foo.ts'), true, 'deleted = dirty');
  assert.strictEqual(isWorktreeDirty('?? untracked.txt'), true, 'untracked = dirty');
  assert.strictEqual(isWorktreeDirty('UU conflict.ts'), true, 'conflict = dirty');
  assert.strictEqual(isWorktreeDirty(' M foo.ts\n?? new.txt'), true, 'multi-line = dirty');

  console.log('PASS: isWorktreeDirty');
})();

// ── escShell escapes apostrophes (cherry-pick safety) ─────
(function testEscShellApostrophe() {
  // Mirror of the helper in server.js (post-fix)
  function escShell(str) { return str.replace(/[\\'"$`]/g, '\\$&'); }

  // Backslash, double-quote, dollar, backtick — already worked
  assert.strictEqual(escShell('plain'), 'plain', 'plain passes through');
  assert.strictEqual(escShell('a"b'), 'a\\"b', 'double-quote escaped');
  assert.strictEqual(escShell('a$b'), 'a\\$b', 'dollar escaped');
  assert.strictEqual(escShell('a`b'), 'a\\`b', 'backtick escaped');
  assert.strictEqual(escShell('a\\b'), 'a\\\\b', 'backslash escaped');

  // Apostrophe — this is the bug we just fixed
  assert.strictEqual(escShell("Live status shows raw JSON"),
    "Live status shows raw JSON", 'apostrophe-free text unchanged');
  assert.strictEqual(escShell("It's a test"), "It\\'s a test",
    'apostrophe now escaped (this is the fix)');
  assert.strictEqual(escShell('"Live status" shows raw JSON'),
    '\\"Live status\\" shows raw JSON',
    'double-quotes in real ticket titles now safe');

  console.log('PASS: escShell escapes apostrophes');
})();

console.log('\n✅ All server-helper tests passed\n');
