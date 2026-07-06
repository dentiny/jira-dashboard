const fs = require('fs');
const os = require('os');

const CLK_TCK = 100;
const PAGE_SIZE = 4096;

function create(pid, onProgress) {
  const ncores = os.cpus().length;
  let peakMem = 0;
  const startTime = Date.now();

  function poll() {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const afterParen = raw.slice(raw.lastIndexOf(')') + 2);
      const fields = afterParen.split(' ');
      const utime = parseInt(fields[11]) || 0;
      const stime = parseInt(fields[12]) || 0;
      const rss = parseInt(fields[21]) || 0;
      const threads = parseInt(fields[17]) || 1;
      const cpuSec = ((utime + stime) / CLK_TCK).toFixed(1);
      const memMB = rss * PAGE_SIZE / (1024 * 1024);
      if (memMB > peakMem) peakMem = memMB;
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (onProgress) onProgress({ cpuSec, memMB: memMB.toFixed(1), threads, elapsed, ncores });
    } catch {}
  }

  const interval = setInterval(poll, 3000);

  return { poll, peakMem: () => peakMem, close: () => clearInterval(interval) };
}

module.exports = { create };
