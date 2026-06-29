// coder.js — Coder CLI abstraction layer
// Decouples the dashboard from any specific AI coding tool (opencode, etc.).
// New backends: add a new handler object with run() and stats().

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const config = require('./config');

// ── opencode backend ───────────────────────────────────────
const opencodeBackend = {
  name: 'opencode',

  stats() {
    try {
      const out = execSync(`${config.coder.bin} stats --project ''`, {
        encoding: 'utf-8',
        timeout: config.coder.timeouts.command,
        stdio: 'pipe',
        cwd: config.projectDir,
      });
      const cost = (out.match(/Total Cost\s+\$?([\d.]+)/) || [])[1];
      const input = (out.match(/Input\s+([\d,.]+[KMB]?)/) || [])[1];
      const output = (out.match(/Output\s+([\d,.]+[KMB]?)/) || [])[1];
      return { cost: parseFloat(cost) || 0, input: input || '0', output: output || '0' };
    } catch {
      return { cost: 0, input: '0', output: '0' };
    }
  },

  buildArgs(prompt, sessionId, title) {
    const args = ['run'];
    if (sessionId) {
      args.push('-s', sessionId);
    } else if (title) {
      args.push('--title', title);
    }
    args.push(prompt);
    return args;
  },

  buildEnv() {
    return {
      HOME: process.env.HOME,
      PATH: `${config.venvBin()}:${process.env.PATH}`,
      VIRTUAL_ENV: path.join(config.projectDir, config.venv.dir),
    };
  },
};

// ── claude code backend ────────────────────────────────────
const claudeBackend = {
  name: 'claude',

  stats() {
    return { cost: 0, input: '0', output: '0' };
  },

  buildArgs(prompt, sessionId, title) {
    const args = ['-p', prompt];
    if (sessionId) {
      args.push('--resume', sessionId);
    }
    return args;
  },

  buildEnv() {
    return {
      HOME: process.env.HOME,
      PATH: `${config.venvBin()}:${process.env.PATH}`,
      VIRTUAL_ENV: path.join(config.projectDir, config.venv.dir),
    };
  },
};

// ── dummy backend (for testing) ────────────────────────────
const dummyBackend = {
  name: 'dummy',
  stats() {
    return { cost: 0, input: '0', output: '0' };
  },
  // dummy just echoes the prompt back — no real process spawned
  async runDummy(prompt) {
    return `[dummy output] Received prompt: ${prompt.slice(0, 80)}`;
  },
  buildArgs(prompt) { return []; },
  buildEnv() { return { ...process.env }; },
};

// ── Registry ───────────────────────────────────────────────
const backends = { opencode: opencodeBackend, claude: claudeBackend, dummy: dummyBackend };

function resolveBackend() {
  const type = config.coder.type;
  const backend = backends[type];
  if (!backend) {
    console.warn(`Unknown coder type "${type}" — using dummy backend`);
    return dummyBackend;
  }
  return backend;
}

// ── Public API ─────────────────────────────────────────────

function getStats() {
  return resolveBackend().stats();
}

/** Spawn the coder CLI, stream stdout, resolve with full output.
 * @param {string} prompt - The prompt/directive
 * @param {object} opts
 * @param {string} [opts.sessionId] - Resume an existing session
 * @param {string} [opts.title] - Title for new session
 * @param {number} [opts.timeout] - Max runtime ms
 * @param {function} [opts.onProgress] - (line: string) => void
 * @returns {Promise<string>} stdout
 */
function run(prompt, opts = {}) {
  const backend = resolveBackend();
  const { sessionId, title, timeout = 180_000, onProgress } = opts;

  // Dummy backend short-circuits (no real process)
  if (backend.runDummy) {
    return backend.runDummy(prompt);
  }

  return new Promise((resolve, reject) => {
    const args = backend.buildArgs(prompt, sessionId, title);
    const env = { ...process.env, ...backend.buildEnv() };

    const proc = spawn(config.coder.bin, args, {
      cwd: config.projectDir,
      env,
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const resMonitor = startResourceMonitor(proc.pid, onProgress);

    proc.stdout.on('data', d => {
      const chunk = d.toString();
      stdout += chunk;
      if (onProgress) {
        chunk.split('\n').filter(l => l.trim()).forEach(l => onProgress(l));
      }
    });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', code => {
      clearInterval(resMonitor.interval);
      if (code === 0) {
        if (!stdout.trim() && stderr.trim()) {
          reject(new Error(`Coder produced no output: ${stderr.slice(-500)}`));
        } else {
          resolve(stdout.trim());
        }
      } else if (stdout.trim()) {
        resolve(stdout.trim());
      } else {
        const reason = code === null ? 'killed (signal/timeout)' : `exited ${code}`;
        reject(new Error(`Coder ${reason}: ${stderr.slice(-500)}`));
      }
    });

    proc.on('error', err => {
      clearInterval(resMonitor.interval);
      reject(err);
    });
  });
}

// ── Resource monitor (CPU, mem, tokens) ────────────────────
function startResourceMonitor(pid, onProgress) {
  const clkTck = 100;
  const ncores = os.cpus().length;
  const PAGE_SIZE = 4096;
  let peakMem = 0;
  const startTime = Date.now();

  const interval = setInterval(() => {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const afterParen = raw.slice(raw.lastIndexOf(')') + 2);
      const fields = afterParen.split(' ');
      const utime = parseInt(fields[11]) || 0;
      const stime = parseInt(fields[12]) || 0;
      const rss = parseInt(fields[21]) || 0;
      const threads = parseInt(fields[17]) || 1;
      const cpuSec = ((utime + stime) / clkTck).toFixed(1);
      const memMB = rss * PAGE_SIZE / (1024 * 1024);
      const memStr = memMB.toFixed(1);
      if (memMB > peakMem) peakMem = memMB;
      const elapsed = Math.round((Date.now() - startTime) / 1000);

      let tokensIn = '', tokensOut = '', runCost = '';
      try {
        const s = resolveBackend().stats();
        tokensIn = s.input || '';
        tokensOut = s.output || '';
        runCost = String(s.cost || '');
      } catch {}
      let tokensStr = '';
      if (tokensIn) tokensStr = ` tokens_in=${tokensIn} tokens_out=${tokensOut} cost=$${runCost}`;

      const resStr = `cpu=${cpuSec}s mem=${memStr}MB threads=${threads} elapsed=${elapsed}s ncores=${ncores}${tokensStr}`;
      if (onProgress) onProgress(`[resource] ${resStr}`);
    } catch { /* proc gone */ }
  }, 3000);

  return { interval, peakMem: () => peakMem };
}

module.exports = { run, getStats, startResourceMonitor };
