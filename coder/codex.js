const path = require('path');

module.exports = function codexBackend(config, store) {
  return {
    name: 'codex',

    stats() { return store.lastUsage; },

    buildArgs(prompt, sessionId, title) {
      const args = ['exec'];
      if (sessionId === '--last') {
        args.push('resume', '--last');
      } else if (sessionId) {
        args.push('resume', sessionId);
      }
      args.push('--json');
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
        if (evt.type === 'item.completed' && evt.item?.type === 'agent_message') return evt.item.text || '';
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
            if (evt.type === 'thread.started' && evt.thread_id) store.setSessionId(evt.thread_id);
            if (evt.type === 'turn.completed' && evt.usage) {
              const input = parseInt(evt.usage.input_tokens, 10) || 0;
              const output = parseInt(evt.usage.output_tokens, 10) || 0;
              store.setUsage({
                cost: 0,
                input: String(input),
                output: String(output),
              });
            }
            if (evt.type === 'item.completed' && evt.item?.type === 'agent_message') {
              text += evt.item.text || '';
            }
          } catch {}
        }
        if (text) return text;
      } catch {}
      return stdout;
    },
  };
};
