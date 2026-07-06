// coder/index.js — Coder CLI abstraction layer
// Decouples the dashboard from any specific AI coding tool.
// New backends: add a file under coder/<name>.js and register it below.

const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');
const store = require('./store');
const { createResourceMonitor } = require('../monitor');

const opencode = require('./opencode')(config, store);
const claude = require('./claude')(config, store);
const codex = require('./codex')(config, store);
const dummy = require('./dummy')(config, store);

const backends = { opencode, claude, codex, dummy };

// ── Coder type autodetection ──────────────────────────────
// Prevents the common config mismatch where a user sets
// JIRA_CODER_BIN=claude (their machine's only AI CLI) but
// doesn't also set JIRA_CODER_TYPE=claude (the default from
// config.json is 'opencode').  Without detection, the opencode
// backend would be selected and emit `--format` flags, which
// the claude binary rejects with:
//   error: unknown option '--format'
function detectType(cfg) {
  const type = cfg.coder.type;
  const binName = path.basename(cfg.coder.bin).toLowerCase();

  // Only auto-detect when the configured type is 'opencode' —
  // the built-in default.  If the user explicitly chose a
  // different type we respect that choice.
  if (type !== 'opencode') return type;

  if (binName.startsWith('claude') || binName.includes('claude')) return 'claude';
  if (binName.startsWith('codex') || binName.includes('codex')) return 'codex';
  return 'opencode';
}

function resolveBackend() {
  const type = detectType(config);
  const backend = backends[type];
  if (!backend) {
    console.warn(`Unknown coder type "${type}" — using dummy backend`);
    return dummy;
  }
  return backend;
}

function getStats() {
  const backend = resolveBackend();
  if (backend.name === 'opencode') return backend.stats();
  return store.lastUsage;
}

function getLastSessionId() {
  return store.lastSessionId;
}

function buildSpawnOptions(backend, opts = {}) {
  const { timeout = 180_000 } = opts;
  return {
    cwd: opts.cwd || config.projectDir,
    env: { ...process.env, ...backend.buildEnv() },
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group so the whole coder tree (the CLI plus any git /
    // language-server children it spawns) can be killed together when a
    // ticket is closed mid-run — a plain kill only hits the group leader.
    detached: true,
  };
}

function run(prompt, opts = {}) {
  const backend = resolveBackend();
  const { sessionId, title, onProgress } = opts;

  if (backend.runDummy) {
    return backend.runDummy(prompt).then(text => ({
      text, tokens: null, sessionId: null,
    }));
  }

  return new Promise((resolve, reject) => {
    const args = backend.buildArgs(prompt, sessionId, title);
    const spawnOpts = buildSpawnOptions(backend, opts);

    const proc = spawn(config.coder.bin, args, spawnOpts);
    // Hand the live process to the caller so it can be force-killed (e.g. when
    // a ticket is closed mid-run) without waiting for it to finish.
    if (typeof opts.onSpawn === 'function') opts.onSpawn(proc);

    let stdout = '';
    let stderr = '';
    const resMonitor = createResourceMonitor(proc.pid, data => {
      if (!onProgress) return;
      let tokensStr = '';
      try {
        const s = resolveBackend().stats();
        if (parseInt(s.input) > 0) tokensStr = ` tokens_in=${s.input} tokens_out=${s.output} cost=$${s.cost || ''}`;
      } catch {}
      onProgress(`[resource] cpu=${data.cpuSec}s mem=${data.memMB}MB threads=${data.threads} elapsed=${data.elapsed}s ncores=${data.ncores}${tokensStr}`);
    });

    proc.stdout.on('data', d => {
      const chunk = d.toString();
      stdout += chunk;
      if (onProgress) {
        chunk.split('\n').filter(l => l.trim()).forEach(l => {
          const formatted = backend.formatProgress ? backend.formatProgress(l) : null;
          if (formatted !== null) {
            onProgress(formatted);
          } else if (!/^\s*[{[]/.test(l)) {
            onProgress(l);
          }
        });
      }
    });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', code => {
      // Parse output FIRST so store.setUsage() captures the final
      // token/cost values before the resource monitor's last poll.
      const raw = stdout.trim();
      const parsed = backend.parseOutput ? backend.parseOutput(raw) : { text: raw, tokens: null, sessionId: null };
      if (resMonitor) { resMonitor.poll(); resMonitor.close(); }
      if (code === 0) {
        if (!parsed.text && stderr.trim()) {
          reject(new Error(`Coder produced no output: ${stderr.slice(-500)}`));
        } else {
          resolve(parsed);
        }
      } else if (parsed.text) {
        resolve(parsed);
      } else {
        const reason = code === null ? 'killed (signal/timeout)' : `exited ${code}`;
        reject(new Error(`Coder ${reason}: ${stderr.slice(-500)}`));
      }
    });

    proc.on('error', err => {
      if (resMonitor) resMonitor.close();
      reject(err);
    });
  });
}

module.exports = { run, getStats, getLastSessionId, buildSpawnOptions, detectType };
