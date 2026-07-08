const assert = (() => { try { return require('assert'); } catch { return require('node:assert'); } })();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { slugFromTitle, ticketId, uid, escShell, formatPlanText } = require('../helpers');
const { parseTestSummary, formatSummary, detectTestFramework } = require('../test-runner');
const { isWorktreeDirty } = require('../git-utils');

// ── slugFromTitle ──────────────────────────────────────────
(function testSlugFromTitle() {
  assert.strictEqual(slugFromTitle('Hello World'), 'hello-world');
  assert.strictEqual(slugFromTitle('Fix: Login Bug!!!'), 'fix-login-bug');
  assert.strictEqual(slugFromTitle('  Spaces  everywhere  '), 'spaces-everywhere');
  assert.strictEqual(slugFromTitle('a'.repeat(100)), 'a'.repeat(40));
  assert.strictEqual(slugFromTitle(''), '');
  console.log('PASS: slugFromTitle');
})();

// ── ticketId ───────────────────────────────────────────────
(function testTicketId() {
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
  let r = parseTestSummary('=== 12 passed, 1 failed, 2 skipped in 0.42s ===');
  assert.deepStrictEqual(r, { passed: 12, failed: 1, errored: 0, skipped: 2 });

  r = parseTestSummary('5 passed, 3 errored');
  assert.deepStrictEqual(r, { passed: 5, failed: 0, errored: 3, skipped: 0 });

  r = parseTestSummary('ok  \tpkg/foo\t0.123s\nok  \tpkg/bar\t0.456s');
  assert.deepStrictEqual(r, { passed: 2, failed: 0, errored: 0, skipped: 0 });

  r = parseTestSummary('ok  \tpkg/a\t0.1s\nFAIL\tpkg/b\t0.2s');
  assert.deepStrictEqual(r, { passed: 1, failed: 1, errored: 0, skipped: 0 });

  r = parseTestSummary('');
  assert.strictEqual(r, null);

  r = parseTestSummary(null);
  assert.strictEqual(r, null);

  console.log('PASS: parseTestSummary');
})();

// ── formatSummary ──────────────────────────────────────────
(function testFormatSummary() {
  assert.strictEqual(formatSummary(null, 'pass'), 'All tests passed');
  assert.strictEqual(formatSummary(null, 'fail'), 'Tests failed');
  assert.strictEqual(formatSummary(null, 'skip'), 'skip');
  assert.strictEqual(formatSummary({ passed: 10, failed: 2, errored: 0, skipped: 1 }), '10 passed, 2 failed, 1 skipped');
  assert.strictEqual(formatSummary({ passed: 5 }, 'fail'), '5 passed');
  console.log('PASS: formatSummary');
})();

// ── uid ────────────────────────────────────────────────────
(function testUid() {
  const u1 = uid();
  const u2 = uid();
  assert.strictEqual(u1.length, 12, 'uid should be 12 hex chars');
  assert.notStrictEqual(u1, u2, 'uids should be unique');
  console.log('PASS: uid');
})();

// ── isWorktreeDirty (post-stage invariant) ────────────────
(function testIsWorktreeDirty() {
  assert.strictEqual(isWorktreeDirty(''), false, 'empty status = clean');
  assert.strictEqual(isWorktreeDirty('   '), false, 'whitespace = clean');
  assert.strictEqual(isWorktreeDirty('\n\n'), false, 'newlines = clean');
  assert.strictEqual(isWorktreeDirty(undefined), false, 'undefined = clean');
  assert.strictEqual(isWorktreeDirty(null), false, 'null = clean');

  assert.strictEqual(isWorktreeDirty(' M foo.ts'), true, 'unstaged = dirty');
  assert.strictEqual(isWorktreeDirty('M  foo.ts'), true, 'staged = dirty');
  assert.strictEqual(isWorktreeDirty('A  foo.ts'), true, 'added = dirty');
  assert.strictEqual(isWorktreeDirty('D  foo.ts'), true, 'deleted = dirty');
  assert.strictEqual(isWorktreeDirty('?? untracked.txt'), true, 'untracked = dirty');
  assert.strictEqual(isWorktreeDirty('UU conflict.ts'), true, 'conflict = dirty');
  assert.strictEqual(isWorktreeDirty(' M foo.ts\n?? new.txt'), true, 'multi-line = dirty');

  console.log('PASS: isWorktreeDirty');
})();

// ── escShell ──────────────────────────────────────────────
(function testEscShell() {
  assert.strictEqual(escShell('plain'), 'plain', 'plain passes through');
  assert.strictEqual(escShell('a"b'), 'a\\"b', 'double-quote escaped');
  assert.strictEqual(escShell('a$b'), 'a\\$b', 'dollar escaped');
  assert.strictEqual(escShell('a`b'), 'a\\`b', 'backtick escaped');
  assert.strictEqual(escShell('a\\b'), 'a\\\\b', 'backslash escaped');

  assert.strictEqual(escShell("Live status shows raw JSON"),
    "Live status shows raw JSON", 'apostrophe-free text unchanged');
  assert.strictEqual(escShell("It's a test"), "It\\'s a test",
    'apostrophe now escaped');
  assert.strictEqual(escShell('"Live status" shows raw JSON'),
    '\\"Live status\\" shows raw JSON',
    'double-quotes in real ticket titles now safe');

  console.log('PASS: escShell');
})();

// ── detectTestFramework: always returns something or null ──
(function testDetectTestFramework() {
  const tmp = fs.mkdtempSync('/tmp/jd-tf-');
  try {
    const r = detectTestFramework(tmp);
    // When commandOverride is not set, returns null on empty dir.
    // When set, returns custom framework. Either is valid.
    assert.ok(r === null || r.framework === 'custom',
      'detectTestFramework should return null or custom framework for empty dir');
    console.log('PASS: detectTestFramework');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
})();

// ── PR check line parsing ──────────────────────────────────
(function testPrCheckLineParsing() {
  // Same regex as in server.js pr-tasks endpoint
  const checkLineRe = /^\s*•\s+(.+?)\s*—\s+(.+?)(?:\s+\((.+?)\))?\s*$/;

  const m1 = '  • CarBench Status — PENDING'.match(checkLineRe);
  assert.ok(m1, 'should match check line without URL');
  assert.strictEqual(m1[1], 'CarBench Status');
  assert.strictEqual(m1[2], 'PENDING');
  assert.strictEqual(m1[3], undefined);

  const m2 = '  • Simtest Status — PENDING (http://example.com)'.match(checkLineRe);
  assert.ok(m2, 'should match check line with URL');
  assert.strictEqual(m2[1], 'Simtest Status');
  assert.strictEqual(m2[2], 'PENDING');
  assert.strictEqual(m2[3], 'http://example.com');

  const m3 = '  • Code Checks — FAILURE (http://build/1)'.match(checkLineRe);
  assert.ok(m3, 'should match failure check');
  assert.strictEqual(m3[1], 'Code Checks');
  assert.strictEqual(m3[2], 'FAILURE');

  const no1 = '  • 2 new comment(s) on the PR'.match(checkLineRe);
  assert.strictEqual(no1, null, 'comment lines should not match');

  const no2 = 'PR #273092 has tasks that need attention:'.match(checkLineRe);
  assert.strictEqual(no2, null, 'header lines should not match');

  // Edge cases
  const m4 = '• Foo — BAR'.match(checkLineRe);
  assert.ok(m4, 'should match minimal bullet');
  assert.strictEqual(m4[1], 'Foo');

  const m5 = '  •   Name with spaces   —   STATUS   '.match(checkLineRe);
  assert.ok(m5, 'should handle extra whitespace');
  assert.strictEqual(m5[1], 'Name with spaces');
  assert.strictEqual(m5[2], 'STATUS');

  console.log('PASS: testPrCheckLineParsing');
})();
(function testFormatPlanText() {
  assert.strictEqual(formatPlanText('do the thing'), 'do the thing');
  assert.strictEqual(formatPlanText({ plan: 'implement foo' }), 'implement foo');
  assert.strictEqual(formatPlanText({ description: 'add bar' }), 'add bar');
  assert.strictEqual(formatPlanText({ text: 'refactor baz' }), 'refactor baz');
  assert.strictEqual(formatPlanText({ content: 'fix qux' }), 'fix qux');
  assert.strictEqual(formatPlanText({ message: 'update quux' }), 'update quux');
  assert.strictEqual(formatPlanText({ type: 'step_start', part: {} }), '');
  assert.strictEqual(formatPlanText('{"plan":"add tests"}'), 'add tests');
  assert.strictEqual(formatPlanText('{"description":"write docs"}'), 'write docs');
  assert.strictEqual(formatPlanText('{"type":"text","text":"hello"}'), 'hello');
  assert.strictEqual(formatPlanText('"simple"'), 'simple');
  assert.strictEqual(formatPlanText('{"type":"step_start","sessionID":"ses_123"}'), '');
  assert.strictEqual(formatPlanText(null), '');
  assert.strictEqual(formatPlanText(undefined), '');
  assert.strictEqual(formatPlanText(''), '');
  console.log('PASS: formatPlanText');
})();

console.log('\n✅ All server-helper tests passed\n');
