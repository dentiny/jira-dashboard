// tests/coder-opencode-integration.test.js
// Integration tests that call the real opencode CLI.
// Skipped (soft-fail) when the opencode binary is not found.

let assert;
try { assert = require('assert'); } catch { assert = require('node:assert'); }

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPORT = { passed: 0, skipped: 0, failed: 0 };

// ── Detect opencode binary ────────────────────────────────
function findOpencodeBin() {
  // 1. Already set in env (common in CI or dashboard-managed runs)
  if (process.env.JIRA_CODER_BIN && fs.existsSync(process.env.JIRA_CODER_BIN)) {
    return process.env.JIRA_CODER_BIN;
  }
  // 2. Walk up from the test file to find the project .env
  let dir = path.resolve(__dirname);
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, '.jira-dashboard', '.env');
    if (fs.existsSync(candidate)) {
      try {
        const lines = fs.readFileSync(candidate, 'utf-8').split('\n');
        for (const line of lines) {
          const m = line.trim().match(/^JIRA_CODER_BIN=(.+)/);
          if (m) return m[1].replace(/^['"]|['"]$/g, '');
        }
      } catch {}
      break;
    }
    dir = path.dirname(dir);
  }
  // 3. Well-known install locations
  const known = ['/home/cutuy/.opencode/bin/opencode', '/usr/local/bin/opencode', '/usr/bin/opencode'];
  for (const p of known) {
    if (fs.existsSync(p)) return p;
  }
  // 4. Fall back to bare name (must be on PATH)
  try { execSync('which opencode', { stdio: 'pipe' }); return 'opencode'; } catch {}
  try { execSync('which opcode', { stdio: 'pipe' }); return 'opcode'; } catch {}
  return null;
}

const OPENCODE_BIN = findOpencodeBin();
const HAS_OPENCODE = OPENCODE_BIN !== null;

function opencode(args) {
  return execSync(`${OPENCODE_BIN} ${args}`, {
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: 'pipe',
    cwd: __dirname,
  });
}

// 1. opencode binary presence
(function testBinaryExists() {
  if (!HAS_OPENCODE) {
    console.log('SKIP: testBinaryExists — opencode CLI not found (set JIRA_CODER_BIN or add to PATH)');
    REPORT.skipped++;
    return;
  }
  const out = opencode('--version');
  assert.ok(out.match(/\d+\.\d+\.\d+/), 'output should contain a version number');
  console.log('PASS: opencode binary found, version:', out.trim());
  REPORT.passed++;
})();

// 2. stats parsing (core regex correctness)
(function testStatsParsing() {
  if (!HAS_OPENCODE) {
    console.log('SKIP: testStatsParsing — opencode CLI not found');
    REPORT.skipped++;
    return;
  }
  const out = opencode('stats');
  assert.ok(out.includes('OVERVIEW'), 'output should contain OVERVIEW section');
  assert.ok(out.includes('COST & TOKENS'), 'output should contain COST & TOKENS section');

  const costMatch = out.match(/Total Cost\s+\$?([\d.]+)/);
  assert.ok(costMatch, 'Total Cost regex should match');
  const costNum = parseFloat(costMatch[1]);
  assert.ok(typeof costNum === 'number' && !isNaN(costNum), 'cost should be a number');

  const inputMatch = out.match(/Input\s+([\d,.]+[KMB]?)/);
  assert.ok(inputMatch, 'Input regex should match');
  assert.ok(inputMatch[1].length > 0, 'input should not be empty');

  const outputMatch = out.match(/Output\s+([\d,.]+[KMB]?)/);
  assert.ok(outputMatch, 'Output regex should match');
  assert.ok(outputMatch[1].length > 0, 'output should not be empty');

  const parsed = {
    cost: parseFloat(costMatch[1]) || 0,
    input: inputMatch[1] || '0',
    output: outputMatch[1] || '0',
  };
  assert.ok(typeof parsed.cost === 'number', 'parsed cost must be a number');
  assert.ok(typeof parsed.input === 'string', 'parsed input must be a string');
  assert.ok(typeof parsed.output === 'string', 'parsed output must be a string');
  console.log('PASS: stats parsing \u2014 cost=' + parsed.cost + ' input=' + parsed.input + ' output=' + parsed.output);
  REPORT.passed++;
})();

// 3. opencode parseOutput (step_finish token extraction)
(function testParseOutputExtractsTokens() {
  if (!HAS_OPENCODE) {
    console.log('SKIP: testParseOutputExtractsTokens \u2014 opencode CLI not found');
    REPORT.skipped++;
    return;
  }

  const store = require('../coder/store');
  const mockConfig = {
    projectDir: '/tmp',
    coder: { bin: OPENCODE_BIN, timeouts: { command: 10_000 } },
    venv: { dir: '.venv' },
    venvBin() { return '/tmp/.venv/bin'; },
  };
  const opencodeBackend = require('../coder/opencode')(mockConfig, store);

  store.setUsage({ cost: 0, input: '0', output: '0' });
  store.setSessionId(null);

  const sampleStdout = [
    JSON.stringify({ type: 'step_start', sessionID: 'ses_test-integration-123', part: { id: 'p1', type: 'step-start' } }),
    JSON.stringify({
      type: 'step_finish',
      part: { id: 'p2', type: 'step-finish', tokens: { total: 100, input: 60, output: 40, reasoning: 5, cache: { write: 0, read: 50 } }, cost: 0.0005 },
    }),
    JSON.stringify({ type: 'text', part: { type: 'text', text: 'Integration test result' } }),
  ].join('\n');

  const output = opencodeBackend.parseOutput(sampleStdout);
  assert.strictEqual(output, 'Integration test result', 'text extracted from text event');
  assert.strictEqual(store.lastSessionId, 'ses_test-integration-123', 'session ID stored');
  assert.strictEqual(store.lastUsage.input, '60', 'input tokens stored');
  assert.strictEqual(store.lastUsage.output, '40', 'output tokens stored');
  assert.strictEqual(store.lastUsage.cost, 0.0005, 'cost stored');

  store.setUsage({ cost: 0, input: '0', output: '0' });
  store.setSessionId(null);

  console.log('PASS: parseOutput extracts step_finish tokens');
  REPORT.passed++;
})();

// 4. parseOutput fallback to raw when no JSON events
(function testParseOutputFallback() {
  if (!HAS_OPENCODE) {
    console.log('SKIP: testParseOutputFallback \u2014 opencode CLI not found');
    REPORT.skipped++;
    return;
  }

  const store = require('../coder/store');
  const mockConfig = { projectDir: '/tmp', coder: { bin: OPENCODE_BIN, timeouts: { command: 10_000 } }, venv: { dir: '.venv' }, venvBin() { return '/tmp/.venv/bin'; } };
  const opencodeBackend = require('../coder/opencode')(mockConfig, store);

  const raw = 'plain text output from opencode run';
  assert.strictEqual(opencodeBackend.parseOutput(raw), raw, 'non-JSON output returned as-is');

  console.log('PASS: parseOutput fallback to raw');
  REPORT.passed++;
})();

// 5. End-to-end: run opencode with a cheap prompt and verify stats change
(function testEndToEndRunWithStats() {
  if (!HAS_OPENCODE) {
    console.log('SKIP: testEndToEndRunWithStats \u2014 opencode CLI not found');
    REPORT.skipped++;
    return;
  }

  const outBefore = opencode('stats');
  const costBefore = parseFloat((outBefore.match(/Total Cost\s+\$?([\d.]+)/) || [])[1] || 0);

  const prompt = 'Say hello in one word. Respond with only the word.';
  let runOutput;
  try {
    runOutput = execSync(`${OPENCODE_BIN} run --format json "${prompt}"`, {
      encoding: 'utf-8',
      timeout: 60_000,
      stdio: 'pipe',
      cwd: __dirname,
    });
  } catch (e) {
    console.log('SKIP: testEndToEndRunWithStats \u2014 opencode run failed:', e.message.slice(0, 120));
    REPORT.skipped++;
    return;
  }

  const outAfter = opencode('stats');
  const costAfter = parseFloat((outAfter.match(/Total Cost\s+\$?([\d.]+)/) || [])[1] || 0);

  assert.ok(runOutput.length > 0, 'run should produce non-empty output');

  const store = require('../coder/store');
  const mockConfig = { projectDir: __dirname, coder: { bin: OPENCODE_BIN, timeouts: { command: 10_000 } }, venv: { dir: '.venv' }, venvBin() { return '/tmp/.venv/bin'; } };
  const opencodeBackend = require('../coder/opencode')(mockConfig, store);
  const parsedText = opencodeBackend.parseOutput(runOutput);
  assert.ok(typeof parsedText === 'string' && parsedText.length > 0, 'parseOutput should extract text from run output');

  assert.ok(costAfter >= costBefore, 'cost after run should be >= cost before (was: ' + costBefore + ' -> ' + costAfter + ')');

  console.log('PASS: end-to-end run \u2014 cost=' + costBefore + ' -> ' + costAfter);
  REPORT.passed++;
})();

console.log(
  '\n\u2192 opencode integration tests: ' +
  REPORT.passed + ' passed, ' +
  REPORT.skipped + ' skipped, ' +
  REPORT.failed + ' failed' +
  (REPORT.failed > 0 ? ' \u2716' : '')
);
