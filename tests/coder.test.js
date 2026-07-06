// tests/coder.test.js — Coder abstraction unit tests

let assert;
try { assert = require('assert'); } catch { assert = require('node:assert'); }

// ── Helpers: create a mock config with given coder type ────
function injectMockConfig(type) {
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../coder')];

  const mockConfigPath = require.resolve('../config');
  require.cache[mockConfigPath] = {
    id: mockConfigPath,
    filename: mockConfigPath,
    loaded: true,
    exports: {
      port: 3006,
      projectName: 'test-project',
      projectDir: '/tmp',
      worktreesDir: '/tmp/test-project/.worktrees',
      dataDir: '/tmp/test-data',
      coder: {
        type: type,
        bin: 'echo',
        timeouts: { clarify: 1000, implement: 1000, suggest: 1000, test: 1000, command: 500 },
      },
      venv: { dir: '.venv', pythonpath: 'src' },
      test: { commandOverride: null, timeout: 1000 },
      venvBin() { return '/tmp/.venv/bin'; },
      venvPython() { return 'python3'; },
      ticketContextDir(id) { return `/tmp/.opencode/tickets/${id}`; },
    },
  };
}

function cleanupMock() {
  const mockConfigPath = require.resolve('../config');
  delete require.cache[mockConfigPath];
  delete require.cache[require.resolve('../coder')];
}

// ── Dummy backend tests ────────────────────────────────────
(function testDummyBackend() {
  injectMockConfig('dummy');
  const coder = require('../coder');

  const stats = coder.getStats();
  assert.strictEqual(typeof stats.cost, 'number', 'cost should be number');
  assert.strictEqual(typeof stats.input, 'string', 'input should be string');
  assert.strictEqual(typeof stats.output, 'string', 'output should be string');
  assert.strictEqual(stats.cost, 0);
  console.log('PASS: getStats returns sensible defaults with dummy backend');

  cleanupMock();
})();

(async function testRunDummy() {
  injectMockConfig('dummy');
  const coder = require('../coder');

  const result = await coder.run('test prompt', { timeout: 500 });
  assert.ok(typeof result === 'object' && typeof result.text === 'string', 'run should return { text, tokens, sessionId }');
  assert.ok(result.text.length >= 0, 'run should not throw');
  console.log('PASS: run with dummy backend resolves');

  cleanupMock();
})();

// ── buildSpawnOptions respects opts.cwd (worktree isolation) ───
(function testBuildSpawnOptionsCwd() {
  injectMockConfig('dummy');
  const coder = require('../coder');

  // Pass a cwd; it should be honored.
  const o1 = coder.buildSpawnOptions(
    { buildEnv: () => ({}) },
    { cwd: '/tmp/my-worktree', timeout: 5000 }
  );
  assert.strictEqual(o1.cwd, '/tmp/my-worktree', 'cwd should be the worktree path when provided');
  assert.strictEqual(o1.timeout, 5000, 'timeout should be forwarded');

  // No cwd; should fall back to config.projectDir.
  const o2 = coder.buildSpawnOptions({ buildEnv: () => ({}) }, { timeout: 1000 });
  assert.strictEqual(o2.cwd, require('../config').projectDir,
    'cwd should fall back to config.projectDir when not provided');

  console.log('PASS: buildSpawnOptions honors opts.cwd (worktree isolation)');

  cleanupMock();
})();

// ── Codex backend tests ────────────────────────────────────
(function testCodexBuildArgs() {
  const store = require('../coder/store');
  const mockConfig = {
    projectDir: '/tmp/test-project',
    venv: { dir: '.venv' },
    venvBin() { return '/tmp/test-project/.venv/bin'; },
  };
  const codexBackend = require('../coder/codex')(mockConfig, store);
  const backend = codexBackend;

  const argsNew = backend.buildArgs('hello world', null, null);
  assert.deepStrictEqual(argsNew, ['exec', '--json', 'hello world'], 'new session args');

  const argsResume = backend.buildArgs('continue fixing', 'sess-123', null);
  assert.deepStrictEqual(argsResume, ['exec', 'resume', 'sess-123', '--json', 'continue fixing'], 'resume session args');

  const argsLast = backend.buildArgs('go on', '--last', null);
  assert.deepStrictEqual(argsLast, ['exec', 'resume', '--last', '--json', 'go on'], 'resume --last args');

  console.log('PASS: codex buildArgs');
})();

(function testCodexFormatProgress() {
  const store = require('../coder/store');
  const mockConfig = { projectDir: '/tmp', venv: { dir: '.venv' }, venvBin() { return '/tmp/.venv/bin'; } };
  const codexBackend = require('../coder/codex')(mockConfig, store);
  const backend = codexBackend;

  const result = backend.formatProgress('{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Hello from Codex"}}');
  assert.strictEqual(result, 'Hello from Codex', 'agent message text');

  const result2 = backend.formatProgress('{"type":"item.completed","item":{"id":"i2","type":"command_execution","command":"ls"}}');
  assert.strictEqual(result2, null, 'non-agent item returns null');

  const result3 = backend.formatProgress('not json');
  assert.strictEqual(result3, null, 'invalid json returns null');

  console.log('PASS: codex formatProgress');
})();

(function testCodexParseOutput() {
  const store = require('../coder/store');
  const mockConfig = { projectDir: '/tmp', venv: { dir: '.venv' }, venvBin() { return '/tmp/.venv/bin'; } };
  const codexBackend = require('../coder/codex')(mockConfig, store);
  const backend = codexBackend;

  store.setUsage({ cost: 0, input: '0', output: '0' });
  store.setSessionId(null);

  const sampleStdout = [
    '{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}',
    '{"type":"turn.started"}',
    '{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"ls","status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"Repo contains docs, sdk, and examples directory."}}',
    '{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}',
  ].join('\n');

  const output = backend.parseOutput(sampleStdout);
  assert.strictEqual(output.text, 'Repo contains docs, sdk, and examples directory.', 'extracted agent message text');
  assert.strictEqual(store.lastSessionId, '0199a213-81c0-7800-8aa1-bbab2a035a53', 'session ID stored');
  assert.strictEqual(store.lastUsage.input, '24763', 'input tokens stored');
  assert.strictEqual(store.lastUsage.output, '122', 'output tokens stored');
  assert.strictEqual(store.lastUsage.cost, 0, 'cost is 0 (not provided by CLI)');

  console.log('PASS: codex parseOutput extracts events');
})();

(function testCodexParseOutputFallback() {
  const store = require('../coder/store');
  const mockConfig = { projectDir: '/tmp', venv: { dir: '.venv' }, venvBin() { return '/tmp/.venv/bin'; } };
  const codexBackend = require('../coder/codex')(mockConfig, store);
  const backend = codexBackend;

  const raw = 'This is plain text output from codex';
  const result = backend.parseOutput(raw);
  assert.strictEqual(result.text, raw, 'non-JSON output returned as-is');

  console.log('PASS: codex parseOutput fallback to raw');
})();

(async function testRunWithCodexType() {
  injectMockConfig('codex');
  const coder = require('../coder');

  const result = await coder.run('test prompt', { timeout: 500 });
  assert.ok(typeof result === 'object' && typeof result.text === 'string', 'run with codex type should return { output, tokens, sessionId }');
  console.log('PASS: run with codex type resolves');

  cleanupMock();
})();

// ── Claude backend tests ───────────────────────────────────
// Claude Code's CLI uses `--output-format` (not `--format` — the latter is
// an OpenCode flag and `claude` will reject it with "unknown option").
// `claude` also requires `--verbose` whenever `--output-format=stream-json`
// is passed under `--print` (-p). These tests pin those invariants so a
// future refactor can't silently regress the flag spelling.
(function testClaudeBuildArgs() {
  const store = require('../coder/store');
  const mockConfig = {
    projectDir: '/tmp/test-project',
    venv: { dir: '.venv' },
    venvBin() { return '/tmp/test-project/.venv/bin'; },
  };
  const claudeBackend = require('../coder/claude')(mockConfig, store);
  const backend = claudeBackend;

  const argsNew = backend.buildArgs('hello world', null, null);
  assert.deepStrictEqual(
    argsNew,
    ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--dangerously-skip-permissions', 'hello world'],
    'new session args must use --output-format stream-json with --verbose, not --format'
  );

  const argsResume = backend.buildArgs('continue fixing', 'sess-123', null);
  assert.deepStrictEqual(
    argsResume,
    ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--dangerously-skip-permissions', '-r', 'sess-123', 'continue fixing'],
    'resume session args must include -r <sessionId>'
  );

  // In headless `-p` mode there is no interactive approval, so file-editing
  // tools are auto-denied unless permissions are bypassed. Without this flag
  // the implement stage silently produces zero changes.
  for (const args of [argsNew, argsResume]) {
    assert.ok(
      args.includes('--dangerously-skip-permissions'),
      'claude buildArgs must bypass permissions so implement can edit files'
    );
  }

  // Sanity: the args must never contain a bare `--format` token, which is
  // what `claude` rejects. This guards against a copy-paste from opencode.js.
  for (const args of [argsNew, argsResume]) {
    assert.ok(
      !args.includes('--format'),
      'claude buildArgs must not emit --format (claude CLI rejects it)'
    );
    assert.ok(
      args.includes('--output-format') && args.includes('stream-json'),
      'claude buildArgs must emit --output-format stream-json'
    );
    assert.ok(
      args.indexOf('--verbose') < args.indexOf('--output-format'),
      '--verbose must precede --output-format (claude enforces this order)'
    );
  }

  console.log('PASS: claude buildArgs uses --output-format stream-json');
})();

(function testClaudeFormatProgress() {
  const store = require('../coder/store');
  const mockConfig = { projectDir: '/tmp', venv: { dir: '.venv' }, venvBin() { return '/tmp/.venv/bin'; } };
  const claudeBackend = require('../coder/claude')(mockConfig, store);
  const backend = claudeBackend;

  // stream-json assistant text delta — the live-progress hook.
  const deltaLine = JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
  });
  assert.strictEqual(backend.formatProgress(deltaLine), 'hello', 'text delta returned');

  // Non-delta events should return null so the caller falls back to raw.
  assert.strictEqual(
    backend.formatProgress(JSON.stringify({ type: 'message_start' })),
    null,
    'non-delta events return null'
  );
  assert.strictEqual(backend.formatProgress('not json'), null, 'invalid json returns null');

  console.log('PASS: claude formatProgress');
})();

(function testClaudeParseOutput() {
  const store = require('../coder/store');
  const mockConfig = { projectDir: '/tmp', venv: { dir: '.venv' }, venvBin() { return '/tmp/.venv/bin'; } };
  const claudeBackend = require('../coder/claude')(mockConfig, store);
  const backend = claudeBackend;

  store.setUsage({ cost: 0, input: '0', output: '0' });
  store.setSessionId(null);

  // Multi-line stream-json run.
  const sampleStdout = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-abc-123' }),
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: 'text', text: 'partial ' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sess-abc-123', result: 'partial done', total_cost_usd: 0.0123, usage: { input_tokens: 120, output_tokens: 60 } }),
  ].join('\n');

  const output = backend.parseOutput(sampleStdout);
  assert.strictEqual(output.text, 'partial done', 'result text extracted from final event');
  assert.strictEqual(store.lastSessionId, 'sess-abc-123', 'session id stored');
  assert.strictEqual(store.lastUsage.input, '120', 'input tokens stored');
  assert.strictEqual(store.lastUsage.output, '60', 'output tokens stored');
  assert.strictEqual(store.lastUsage.cost, 0.0123, 'cost stored');

  // Reset store so subsequent tests (e.g. unknown backend fallback) see the
  // expected baseline of zero usage.
  store.setUsage({ cost: 0, input: '0', output: '0' });
  store.setSessionId(null);

  console.log('PASS: claude parseOutput extracts events');
})();

(function testClaudeParseOutputFallback() {
  const store = require('../coder/store');
  const mockConfig = { projectDir: '/tmp', venv: { dir: '.venv' }, venvBin() { return '/tmp/.venv/bin'; } };
  const claudeBackend = require('../coder/claude')(mockConfig, store);
  const backend = claudeBackend;

  const raw = 'plain text from claude --print without --output-format';
  assert.strictEqual(backend.parseOutput(raw).text, raw, 'non-JSON output returned as-is');

  console.log('PASS: claude parseOutput fallback to raw');
})();

(async function testRunWithClaudeType() {
  injectMockConfig('claude');
  const coder = require('../coder');

  const result = await coder.run('test prompt', { timeout: 500 });
  assert.ok(typeof result === 'object' && typeof result.text === 'string', 'run with claude type should return { output, tokens, sessionId }');
  console.log('PASS: run with claude type resolves');

  cleanupMock();
})();

// ── Coder type auto-detection ─────────────────────────────
(function testDetectTypeAutoMatchesClaudeBin() {
  const mock = {
    coder: { type: 'opencode', bin: 'claude' },
  };
  assert.strictEqual(
    require('../coder').detectType(mock),
    'claude',
    'bin=claude with type=opencode (default) → detected claude'
  );
  console.log('PASS: detectType: bin=claude matches claude backend');
})();

(function testDetectTypeAutoMatchesCodexBin() {
  const mock = {
    coder: { type: 'opencode', bin: '/usr/local/bin/codex' },
  };
  assert.strictEqual(
    require('../coder').detectType(mock),
    'codex',
    'bin=/path/codex with type=opencode → detected codex'
  );
  console.log('PASS: detectType: bin=codex matches codex backend');
})();

(function testDetectTypeSkipsWhenExplicit() {
  const mock = {
    coder: { type: 'dummy', bin: 'claude' },
  };
  assert.strictEqual(
    require('../coder').detectType(mock),
    'dummy',
    'type=dummy (explicit) → not overridden by bin=claude'
  );
  console.log('PASS: detectType: explicit type not overridden by bin name');
})();

(function testDetectTypeUnknownBinStaysOpencode() {
  const mock = {
    coder: { type: 'opencode', bin: '/home/user/bin/my-coder' },
  };
  assert.strictEqual(
    require('../coder').detectType(mock),
    'opencode',
    'unknown bin name with type=opencode → stays opencode'
  );
  console.log('PASS: detectType: unknown bin name → stays opencode');
})();

// ── Unknown backend fallback ───────────────────────────────
(function testUnknownBackendFallback() {
  injectMockConfig('nonexistent');
  const coder = require('../coder');

  const stats = coder.getStats();
  assert.strictEqual(stats.cost, 0, 'unknown backend falls back to dummy stats');
  console.log('PASS: unknown backend falls back to dummy');

  cleanupMock();
})();

console.log('\n✅ All coder tests passed\n');
