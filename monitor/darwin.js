const { execFileSync } = require('child_process');
const os = require('os');

function secs(str) {
  str = str.trim();
  let m;
  if ((m = str.match(/^(\d+)-(\d+):(\d+):(\d+)(?:\.(\d+))?$/)))
    return +m[1] * 86400 + +m[2] * 3600 + +m[3] * 60 + +m[4] + +('.' + (m[5] || '0'));
  if ((m = str.match(/^(\d+):(\d+):(\d+)(?:\.(\d+))?$/)))
    return +m[1] * 3600 + +m[2] * 60 + +m[3] + +('.' + (m[4] || '0'));
  if ((m = str.match(/^(\d+):(\d+)(?:\.(\d+))?$/)))
    return +m[1] * 60 + +m[2] + +('.' + (m[3] || '0'));
  return 0;
}

function create(pid, onProgress) {
  const ncores = os.cpus().length;
  let peakMem = 0;
  const startTime = Date.now();

  const interval = setInterval(() => {
    try {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'rss=,time=,thcount='], {
        encoding: 'utf-8', timeout: 2000,
      }).trim();
      const parts = out.split(/\s+/);
      if (parts.length < 2) return;
      const rssKiB = parseInt(parts[0]) || 0;
      const cpuSec = secs(parts[1]);
      const threads = parts[2] ? parseInt(parts[2]) : 1;
      const memMB = rssKiB / 1024;
      if (memMB > peakMem) peakMem = memMB;
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (onProgress) onProgress({ cpuSec: cpuSec.toFixed(1), memMB: memMB.toFixed(1), threads, elapsed, ncores });
    } catch {}
  }, 3000);

  return { interval, peakMem: () => peakMem, close: () => clearInterval(interval) };
}

module.exports = { create };
