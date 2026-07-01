// coder/index.js — Coder CLI abstraction layer
// Decouples the dashboard from any specific AI coding tool.
// New backends: add a file under coder/<name>.js and register it below.

const { spawn } = require('child_process');
const config = require('../config');
const store = require('./store');
const { createResourceMonitor } = require('../monitor');

const opencode = require('./opencode')(config, store);
const claude = require('./claude')(config, store);
const codex = require('./codex')(config, store);
const dummy = require('./dummy')(config, store);

const backends = { opencode, claude, codex, dummy };

function resolveBackend() {
  const type = config.coder.type;
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
  };
}

function run(prompt, opts = {}) {
  const backend = resolveBackend();
  const { sessionId, title, onProgress } = opts;

  if (backend.runDummy) {
    return backend.runDummy(prompt);
  }

  return new Promise((resolve, reject) => {
    const args = backend.buildArgs(prompt, sessionId, title);
    const spawnOpts = buildSpawnOptions(backend, opts);

    const proc = spawn(config.coder.bin, args, spawnOpts);

    let stdout = '';
    let stderr = '';
    const resMonitor = createResourceMonitor(proc.pid, data => {
      if (!onProgress) return;
      let tokensStr = '';
      try {
        const s = resolveBackend().stats();
        if (s.input) tokensStr = ` tokens_in=${s.input} tokens_out=${s.output} cost=$${s.cost || ''}`;
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
      if (resMonitor) resMonitor.close();
      const raw = stdout.trim();
      const output = backend.parseOutput ? backend.parseOutput(raw) : raw;
      if (code === 0) {
        if (!output && stderr.trim()) {
          reject(new Error(`Coder produced no output: ${stderr.slice(-500)}`));
        } else {
          resolve(output);
        }
      } else if (output) {
        resolve(output);
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

module.exports = { run, getStats, getLastSessionId, buildSpawnOptions };
