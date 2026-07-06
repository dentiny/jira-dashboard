const { execSync } = require('child_process');
const path = require('path');

module.exports = function opencodeBackend(config, store) {
  return {
    name: 'opencode',

    stats() {
      try {
        const out = execSync(`${config.coder.bin} stats`, {
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
      const args = ['run', '--format', 'json'];
      if (sessionId) args.push('-s', sessionId);
      else if (title) args.push('--title', title);
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

    formatProgress(line) {
      try {
        const evt = JSON.parse(line);
        if (evt.type === 'text' && evt.part?.type === 'text') return evt.part.text;
      } catch {}
      return null;
    },

    parseOutput(stdout) {
      try {
        const lines = stdout.trim().split('\n');
        let text = '';
        for (const line of lines) {
          try {
            const evt = JSON.parse(line);
            if (evt.type === 'step_start' && evt.sessionID) store.setSessionId(evt.sessionID);
            if (evt.type === 'step_finish' && evt.part?.tokens) {
              store.setUsage({
                cost: evt.part.cost || 0,
                input: String(evt.part.tokens.input || 0),
                output: String(evt.part.tokens.output || 0),
              });
            }
            if (evt.type === 'text' && evt.part?.type === 'text') text += evt.part.text || '';
          } catch {}
        }
        if (text) return text;
      } catch {}
      return stdout;
    },
  };
};
